BEGIN;

CREATE TABLE IF NOT EXISTS novel.api_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  token_id UUID REFERENCES novel.api_tokens(id) ON DELETE SET NULL,
  operation TEXT NOT NULL,
  project_id UUID,
  session_id UUID,
  turn_id UUID,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'complete', 'failed')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_audit_events_user_created
  ON novel.api_audit_events (user_id, created_at DESC);

ALTER TABLE novel.api_audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON novel.api_audit_events FROM authenticated;

COMMIT;
