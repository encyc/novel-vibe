BEGIN;

-- ---------------------------------------------------------------------------
-- Local-first owner bootstrap.
--
-- Local mode owns exactly one user, and `novel.projects.owner_id` references
-- `auth.users(id)`, so that row must exist before the first project is created.
--
-- It cannot be created through the API surface that normally makes users:
--   * `auth` is not in PostgREST's exposed schemas (PGRST_DB_SCHEMA=novel,public);
--   * `public.users` is a view exposing only (id, nickname, avatar_url, locale),
--     and its INSTEAD OF INSERT trigger writes `auth.users` without the NOT NULL
--     `email` column, so that path cannot create a user at all.
--
-- A SECURITY DEFINER function in the exposed `novel` schema is therefore the
-- supported way in, and matches the existing RPC style (`acquire_session_lease`,
-- `claim_memory_jobs`).
--
-- Idempotent: re-running is a no-op, so every local start may call it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION novel.ensure_local_user(
  p_user_id UUID,
  p_email TEXT,
  p_nickname TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public
AS $$
BEGIN
  INSERT INTO auth.users (id, email, nickname)
  VALUES (p_user_id, p_email, p_nickname)
  ON CONFLICT (id) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION novel.ensure_local_user(UUID, TEXT, TEXT)
  TO authenticated, project_admin, anon;

COMMIT;
