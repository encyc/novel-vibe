BEGIN;

-- Local InsForge uses auth.users (not public.users). Create a public.users VIEW
-- that exposes the identity + profile columns the profile service expects.
-- Production may already have public.users; this is idempotent.

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS nickname TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Do not replace an existing view: later migrations may have extended it
-- with additional profile columns (for example locale), and PostgreSQL does
-- not allow CREATE OR REPLACE VIEW to remove those columns on a repeat run.
DO $migration$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    EXECUTE 'CREATE VIEW public.users AS
      SELECT id, nickname, avatar_url
      FROM auth.users';
  END IF;
END
$migration$;

-- Grant access so PostgREST can serve the view via Accept-Profile: public
GRANT SELECT, INSERT, UPDATE ON public.users TO authenticated;

-- INSTEAD OF trigger to make the view writable: forward INSERT/UPDATE to auth.users
CREATE OR REPLACE FUNCTION public.users_upsert_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public
AS $$
BEGIN
  INSERT INTO auth.users (id, nickname, avatar_url)
  VALUES (NEW.id, NEW.nickname, NEW.avatar_url)
  ON CONFLICT (id) DO UPDATE
  SET nickname = EXCLUDED.nickname,
      avatar_url = EXCLUDED.avatar_url,
      updated_at = now()
  RETURNING id, nickname, avatar_url INTO NEW;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_upsert ON public.users;
CREATE TRIGGER users_upsert
  INSTEAD OF INSERT OR UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_upsert_trigger();

GRANT EXECUTE ON FUNCTION public.users_upsert_trigger() TO authenticated;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
