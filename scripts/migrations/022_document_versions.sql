BEGIN;

CREATE TABLE IF NOT EXISTS novel.document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES novel.projects(id) ON DELETE CASCADE,
  doc_path TEXT NOT NULL CHECK (doc_path <> '' AND doc_path NOT LIKE '.versions/%'),
  version_no INTEGER,
  before_hash TEXT,
  after_hash TEXT NOT NULL,
  before_snapshot_path TEXT,
  after_snapshot_path TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('agent', 'user', 'system')),
  agent_id TEXT,
  session_id UUID REFERENCES novel.sessions(id) ON DELETE SET NULL,
  turn_id UUID,
  tool_call_id TEXT,
  created_by UUID,
  state TEXT NOT NULL DEFAULT 'preparing' CHECK (state IN ('preparing', 'complete', 'failed')),
  failure_code TEXT,
  lease_id UUID NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (project_id, doc_path, version_no),
  CHECK ((state = 'complete') = (version_no IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_versions_active_lease
  ON novel.document_versions(project_id, doc_path)
  WHERE state = 'preparing';
CREATE INDEX IF NOT EXISTS idx_document_versions_history
  ON novel.document_versions(project_id, doc_path, version_no DESC)
  WHERE state = 'complete';

CREATE TABLE IF NOT EXISTS novel.document_version_diffs (
  version_id UUID PRIMARY KEY REFERENCES novel.document_versions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ready', 'unavailable')),
  algorithm_version TEXT NOT NULL,
  body_hunks JSONB NOT NULL DEFAULT '[]'::jsonb,
  frontmatter_changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  added_lines INTEGER NOT NULL DEFAULT 0,
  deleted_lines INTEGER NOT NULL DEFAULT 0,
  changed_sections JSONB NOT NULL DEFAULT '[]'::jsonb,
  truncated BOOLEAN NOT NULL DEFAULT false,
  error_code TEXT,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE novel.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.document_version_diffs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_versions_owner_select ON novel.document_versions;
CREATE POLICY document_versions_owner_select ON novel.document_versions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM novel.projects p
    WHERE p.id = project_id
      AND p.owner_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
  ));

DROP POLICY IF EXISTS document_version_diffs_owner_select ON novel.document_version_diffs;
CREATE POLICY document_version_diffs_owner_select ON novel.document_version_diffs
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM novel.document_versions v
    JOIN novel.projects p ON p.id = v.project_id
    WHERE v.id = version_id
      AND p.owner_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
  ));

CREATE OR REPLACE FUNCTION novel.claim_document_write(
  p_project_id UUID,
  p_doc_path TEXT,
  p_before_hash TEXT,
  p_after_hash TEXT,
  p_source_type TEXT,
  p_agent_id TEXT,
  p_session_id UUID,
  p_turn_id UUID,
  p_tool_call_id TEXT,
  p_created_by UUID,
  p_lease_id UUID,
  p_lease_expires_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, novel, public
AS $function$
DECLARE
  caller_id UUID;
  caller_role TEXT;
  caller_sub TEXT;
  claimed_id UUID;
BEGIN
  caller_role := (SELECT auth.jwt() ->> 'role');
  caller_sub := (SELECT auth.jwt() ->> 'sub');
  IF caller_sub ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    caller_id := caller_sub::uuid;
  END IF;
  IF p_doc_path = '' OR p_doc_path LIKE '.versions/%' THEN
    RAISE EXCEPTION 'Invalid document path' USING ERRCODE = '22023';
  END IF;
  IF p_lease_expires_at <= now() THEN
    RAISE EXCEPTION 'Lease expiry must be in the future' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM novel.projects p
    WHERE p.id = p_project_id
      AND p.lifecycle_status = 'active'
      AND (p.owner_id = caller_id OR caller_role = 'project_admin')
  ) THEN
    RAISE EXCEPTION 'Project is unavailable for document writes' USING ERRCODE = '42501';
  END IF;
  IF p_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM novel.sessions s
    WHERE s.id = p_session_id AND s.project_id = p_project_id
  ) THEN
    RAISE EXCEPTION 'Session does not belong to the document project' USING ERRCODE = '22023';
  END IF;

  UPDATE novel.document_versions
  SET state = 'failed', failure_code = 'lease_expired'
  WHERE project_id = p_project_id AND doc_path = p_doc_path
    AND state = 'preparing' AND lease_expires_at <= now();

  BEGIN
    INSERT INTO novel.document_versions (
      project_id, doc_path, before_hash, after_hash, source_type, agent_id,
      session_id, turn_id, tool_call_id, created_by, lease_id, lease_expires_at
    ) VALUES (
      p_project_id, p_doc_path, p_before_hash, p_after_hash, p_source_type, p_agent_id,
      p_session_id, p_turn_id, p_tool_call_id,
      CASE WHEN caller_role = 'project_admin' THEN p_created_by ELSE caller_id END,
      p_lease_id, p_lease_expires_at
    ) RETURNING id INTO claimed_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('outcome', 'busy');
  END;
  RETURN jsonb_build_object('outcome', 'claimed', 'version_id', claimed_id);
END
$function$;

CREATE OR REPLACE FUNCTION novel.complete_document_write(
  p_version_id UUID,
  p_lease_id UUID,
  p_before_snapshot_path TEXT,
  p_after_snapshot_path TEXT,
  p_diff_status TEXT,
  p_algorithm_version TEXT,
  p_body_hunks JSONB,
  p_frontmatter_changes JSONB,
  p_added_lines INTEGER,
  p_deleted_lines INTEGER,
  p_changed_sections JSONB,
  p_truncated BOOLEAN,
  p_error_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, novel, public
AS $function$
DECLARE
  target novel.document_versions%ROWTYPE;
  next_version INTEGER;
  caller_id UUID;
  caller_role TEXT;
  caller_sub TEXT;
BEGIN
  caller_role := (SELECT auth.jwt() ->> 'role');
  caller_sub := (SELECT auth.jwt() ->> 'sub');
  IF caller_sub ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    caller_id := caller_sub::uuid;
  END IF;
  SELECT v.* INTO target
  FROM novel.document_versions v
  JOIN novel.projects p ON p.id = v.project_id
  WHERE v.id = p_version_id AND v.lease_id = p_lease_id AND v.state = 'preparing'
    AND (p.owner_id = caller_id OR caller_role = 'project_admin')
  FOR UPDATE;
  IF NOT FOUND OR target.lease_expires_at <= now() THEN
    RAISE EXCEPTION 'Document write lease is invalid or expired' USING ERRCODE = '40001';
  END IF;

  PERFORM 1 FROM novel.document_versions
  WHERE project_id = target.project_id AND doc_path = target.doc_path
  FOR UPDATE;
  SELECT COALESCE(MAX(version_no), 0) + 1 INTO next_version
  FROM novel.document_versions
  WHERE project_id = target.project_id AND doc_path = target.doc_path AND state = 'complete';

  INSERT INTO novel.document_version_diffs (
    version_id, status, algorithm_version, body_hunks, frontmatter_changes,
    added_lines, deleted_lines, changed_sections, truncated, error_code
  ) VALUES (
    target.id, p_diff_status, p_algorithm_version, COALESCE(p_body_hunks, '[]'::jsonb),
    COALESCE(p_frontmatter_changes, '[]'::jsonb), p_added_lines, p_deleted_lines,
    COALESCE(p_changed_sections, '[]'::jsonb), p_truncated, p_error_code
  ) ON CONFLICT (version_id) DO UPDATE SET
    status = EXCLUDED.status,
    algorithm_version = EXCLUDED.algorithm_version,
    body_hunks = EXCLUDED.body_hunks,
    frontmatter_changes = EXCLUDED.frontmatter_changes,
    added_lines = EXCLUDED.added_lines,
    deleted_lines = EXCLUDED.deleted_lines,
    changed_sections = EXCLUDED.changed_sections,
    truncated = EXCLUDED.truncated,
    error_code = EXCLUDED.error_code,
    computed_at = now();

  UPDATE novel.document_versions SET
    version_no = next_version,
    before_snapshot_path = p_before_snapshot_path,
    after_snapshot_path = p_after_snapshot_path,
    state = 'complete',
    failure_code = NULL,
    completed_at = now()
  WHERE id = target.id;
  RETURN jsonb_build_object('version_no', next_version);
END
$function$;

CREATE OR REPLACE FUNCTION novel.fail_document_write(
  p_version_id UUID,
  p_lease_id UUID,
  p_failure_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, novel, public
AS $function$
DECLARE
  caller_id UUID;
  caller_role TEXT;
  caller_sub TEXT;
BEGIN
  caller_role := (SELECT auth.jwt() ->> 'role');
  caller_sub := (SELECT auth.jwt() ->> 'sub');
  IF caller_sub ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    caller_id := caller_sub::uuid;
  END IF;
  UPDATE novel.document_versions versions
  SET state = 'failed', failure_code = p_failure_code
  WHERE versions.id = p_version_id AND versions.lease_id = p_lease_id AND versions.state = 'preparing'
    AND EXISTS (
      SELECT 1 FROM novel.projects p
      WHERE p.id = versions.project_id
        AND (p.owner_id = caller_id OR caller_role = 'project_admin')
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document write lease is invalid' USING ERRCODE = '40001';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION novel.claim_document_version_repairs(
  p_now TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS SETOF novel.document_versions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, novel, public
AS $function$
BEGIN
  IF (SELECT auth.jwt() ->> 'role') <> 'project_admin' THEN
    RAISE EXCEPTION 'Repair claims require project_admin' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM novel.document_versions
    WHERE state = 'preparing' AND lease_expires_at <= p_now
    ORDER BY lease_expires_at, created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(0, LEAST(p_limit, 100))
  )
  UPDATE novel.document_versions versions
  SET lease_id = gen_random_uuid(), lease_expires_at = p_now + INTERVAL '5 minutes'
  FROM candidates
  WHERE versions.id = candidates.id
  RETURNING versions.*;
END
$function$;

REVOKE INSERT, UPDATE, DELETE ON novel.document_versions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON novel.document_version_diffs FROM authenticated;
GRANT SELECT ON novel.document_versions, novel.document_version_diffs TO authenticated;

REVOKE EXECUTE ON FUNCTION novel.claim_document_write(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, UUID, TEXT, UUID, UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION novel.complete_document_write(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, INTEGER, INTEGER, JSONB, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION novel.fail_document_write(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION novel.claim_document_version_repairs(TIMESTAMPTZ, INTEGER) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION novel.claim_document_write(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, UUID, TEXT, UUID, UUID, TIMESTAMPTZ) TO authenticated, project_admin;
GRANT EXECUTE ON FUNCTION novel.complete_document_write(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, INTEGER, INTEGER, JSONB, BOOLEAN, TEXT) TO authenticated, project_admin;
GRANT EXECUTE ON FUNCTION novel.fail_document_write(UUID, UUID, TEXT) TO authenticated, project_admin;
GRANT EXECUTE ON FUNCTION novel.claim_document_version_repairs(TIMESTAMPTZ, INTEGER) TO project_admin;

COMMIT;
