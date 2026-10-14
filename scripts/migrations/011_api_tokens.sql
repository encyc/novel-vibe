-- Migration 011: scoped API token persistence.
-- Token management remains Web-session-only at the application layer.

BEGIN;

CREATE TABLE IF NOT EXISTS novel.api_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id     TEXT NOT NULL UNIQUE,
  secret_hash   TEXT NOT NULL,
  user_id       UUID NOT NULL,
  name          TEXT NOT NULL,
  scopes        JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_active_owner
  ON novel.api_tokens(user_id, created_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE novel.api_tokens ENABLE ROW LEVEL SECURITY;

-- Remove write policies from earlier migration revisions. All mutations use
-- the trusted system repository and carry explicit owner predicates where the
-- operation is owner-facing.
DROP POLICY IF EXISTS api_tokens_owner_insert ON novel.api_tokens;
DROP POLICY IF EXISTS api_tokens_owner_update ON novel.api_tokens;
DROP POLICY IF EXISTS api_tokens_owner_delete ON novel.api_tokens;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'api_tokens_owner_select'
      AND polrelid = 'novel.api_tokens'::regclass
  ) THEN
    CREATE POLICY api_tokens_owner_select ON novel.api_tokens
      FOR SELECT TO authenticated
      USING (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;

-- Table privileges are stricter than RLS: browser-authenticated callers can
-- inspect only owner-safe metadata and can never read or mutate secret_hash.
REVOKE ALL ON novel.api_tokens FROM PUBLIC;
REVOKE ALL ON novel.api_tokens FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON novel.api_tokens FROM authenticated;
REVOKE UPDATE (last_used_at, revoked_at) ON novel.api_tokens FROM authenticated;
GRANT SELECT (
  id, public_id, user_id, name, scopes, expires_at,
  last_used_at, revoked_at, created_at
) ON novel.api_tokens TO authenticated;

-- Creation, secret-bearing authentication lookup, and maintenance use a
-- trusted system DbClient. Explicit owner predicates remain mandatory in the
-- repository for owner-facing operations, including when postgres bypasses RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.api_tokens TO postgres;

COMMIT;
