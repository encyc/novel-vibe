BEGIN;

CREATE TABLE IF NOT EXISTS novel.session_interactions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES novel.projects(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES novel.sessions(id) ON DELETE CASCADE,
  turn_id UUID NOT NULL,
  assistant_message_id UUID NOT NULL REFERENCES novel.session_messages(id) ON DELETE CASCADE,
  request JSONB NOT NULL CHECK (octet_length(request::text) <= 32768),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'cancelled')),
  response JSONB CHECK (response IS NULL OR octet_length(response::text) <= 16384),
  response_message_id UUID REFERENCES novel.session_messages(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  responded_by UUID,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'resolved') = (response IS NOT NULL AND response_message_id IS NOT NULL)),
  CHECK ((idempotency_key IS NULL) = (status <> 'resolved'))
);

CREATE INDEX IF NOT EXISTS idx_session_interactions_messages
  ON novel.session_interactions(assistant_message_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_session_interactions_pending
  ON novel.session_interactions(session_id, created_at)
  WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_interactions_idempotency
  ON novel.session_interactions(id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE novel.session_interactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS session_interactions_owner_select ON novel.session_interactions;
CREATE POLICY session_interactions_owner_select ON novel.session_interactions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM novel.projects p
    WHERE p.id = project_id
      AND p.owner_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
  ));

REVOKE INSERT, UPDATE, DELETE ON novel.session_interactions FROM authenticated;

CREATE OR REPLACE FUNCTION novel.create_session_interaction(
  p_id UUID,
  p_project_id UUID,
  p_session_id UUID,
  p_turn_id UUID,
  p_assistant_message_id UUID,
  p_request JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, novel, public
AS $function$
DECLARE
  caller_id UUID;
  created_row novel.session_interactions%ROWTYPE;
BEGIN
  caller_id := NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid;
  IF caller_id IS NULL OR octet_length(p_request::text) > 32768 THEN
    RAISE EXCEPTION 'Invalid interaction request' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM novel.projects project
    JOIN novel.sessions session ON session.project_id = project.id
    JOIN novel.session_messages message ON message.session_id = session.id
    WHERE project.id = p_project_id AND project.owner_id = caller_id
      AND project.lifecycle_status = 'active'
      AND session.id = p_session_id AND session.lifecycle_status = 'active'
      AND message.id = p_assistant_message_id AND message.turn_id = p_turn_id
      AND message.role = 'assistant' AND message.status = 'running'
  ) THEN
    RAISE EXCEPTION 'Interaction context is unavailable' USING ERRCODE = '42501';
  END IF;
  INSERT INTO novel.session_interactions (
    id, project_id, session_id, turn_id, assistant_message_id, request, status
  ) VALUES (
    p_id, p_project_id, p_session_id, p_turn_id, p_assistant_message_id, p_request, 'pending'
  ) RETURNING * INTO created_row;
  RETURN to_jsonb(created_row);
END;
$function$;

CREATE OR REPLACE FUNCTION novel.respond_to_session_interaction(
  p_interaction_id UUID,
  p_response JSONB,
  p_idempotency_key TEXT,
  p_response_message_id UUID,
  p_turn_id UUID,
  p_message_text TEXT,
  p_timestamp BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, novel, public
AS $function$
DECLARE
  caller_id UUID;
  interaction_row novel.session_interactions%ROWTYPE;
BEGIN
  caller_id := NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid;
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) > 128 THEN
    RAISE EXCEPTION 'Invalid idempotency key' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_response::text) > 16384 THEN
    RAISE EXCEPTION 'Interaction response is too large' USING ERRCODE = '22023';
  END IF;

  SELECT interaction.* INTO interaction_row
  FROM novel.session_interactions interaction
  JOIN novel.projects project ON project.id = interaction.project_id
  JOIN novel.sessions session ON session.id = interaction.session_id
  WHERE interaction.id = p_interaction_id
    AND project.owner_id = caller_id
    AND session.project_id = interaction.project_id
    AND session.lifecycle_status = 'active'
  FOR UPDATE OF interaction;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Interaction not found' USING ERRCODE = '42501';
  END IF;

  IF interaction_row.status = 'resolved' THEN
    IF interaction_row.idempotency_key = p_idempotency_key AND interaction_row.response = p_response THEN
      RETURN jsonb_build_object(
        'outcome', 'replayed',
        'response_message_id', interaction_row.response_message_id,
        'response', interaction_row.response
      );
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'conflict',
      'response_message_id', interaction_row.response_message_id,
      'response', interaction_row.response
    );
  END IF;
  IF interaction_row.status <> 'pending' THEN
    RETURN jsonb_build_object('outcome', 'conflict', 'response', interaction_row.response);
  END IF;

  INSERT INTO novel.session_messages (
    id, session_id, agent_id, turn_id, role, content, message,
    status, display, metadata, provider, model, timestamp
  ) VALUES (
    p_response_message_id, interaction_row.session_id, 'chief_editor', p_turn_id,
    'user', to_jsonb(p_message_text),
    jsonb_build_object('role', 'user', 'content', p_message_text, 'timestamp', p_timestamp),
    'complete', true, jsonb_build_object('interactionResponse', p_response), NULL, NULL, p_timestamp
  );

  UPDATE novel.session_interactions
  SET status = 'resolved', response = p_response, response_message_id = p_response_message_id,
      idempotency_key = p_idempotency_key, responded_by = caller_id,
      responded_at = now(), updated_at = now()
  WHERE id = interaction_row.id;

  RETURN jsonb_build_object(
    'outcome', 'resolved',
    'response_message_id', p_response_message_id,
    'response', p_response
  );
END;
$function$;

REVOKE ALL ON FUNCTION novel.respond_to_session_interaction(UUID, JSONB, TEXT, UUID, UUID, TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION novel.create_session_interaction(UUID, UUID, UUID, UUID, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION novel.create_session_interaction(UUID, UUID, UUID, UUID, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION novel.respond_to_session_interaction(UUID, JSONB, TEXT, UUID, UUID, TEXT, BIGINT) TO authenticated;

COMMIT;
