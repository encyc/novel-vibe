BEGIN;

-- Local InsForge exposes profiles through public.users, an updatable view over
-- auth.users. The backing table owns locale; the view and trigger expose it.
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS locale TEXT;

CREATE OR REPLACE VIEW public.users AS
SELECT id, nickname, avatar_url, locale
FROM auth.users;

CREATE OR REPLACE FUNCTION public.users_upsert_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.id) THEN
    UPDATE auth.users
    SET nickname = NEW.nickname,
        avatar_url = NEW.avatar_url,
        locale = NEW.locale,
        updated_at = now()
    WHERE id = NEW.id
    RETURNING id, nickname, avatar_url, locale INTO NEW;
  ELSE
    INSERT INTO auth.users (id, nickname, avatar_url, locale)
    VALUES (NEW.id, NEW.nickname, NEW.avatar_url, NEW.locale)
    ON CONFLICT (id) DO UPDATE
    SET nickname = EXCLUDED.nickname,
        avatar_url = EXCLUDED.avatar_url,
        locale = EXCLUDED.locale,
        updated_at = now()
    RETURNING id, nickname, avatar_url, locale INTO NEW;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_upsert ON public.users;
CREATE TRIGGER users_upsert
  INSTEAD OF INSERT OR UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_upsert_trigger();

GRANT SELECT, INSERT, UPDATE ON public.users TO authenticated;
GRANT EXECUTE ON FUNCTION public.users_upsert_trigger() TO authenticated;

ALTER TABLE novel.projects
  ADD COLUMN IF NOT EXISTS creative_language TEXT NOT NULL DEFAULT 'zh-CN';

UPDATE novel.projects
SET creative_language = 'zh-CN'
WHERE creative_language IS NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_locale_check'
      AND conrelid = 'auth.users'::regclass
  ) THEN
    ALTER TABLE auth.users ADD CONSTRAINT users_locale_check
      CHECK (locale IS NULL OR locale IN ('zh-CN', 'en'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'projects_creative_language_check'
      AND conrelid = 'novel.projects'::regclass
  ) THEN
    ALTER TABLE novel.projects ADD CONSTRAINT projects_creative_language_check
      CHECK (creative_language IN ('zh-CN', 'en'));
  END IF;
END
$migration$;

NOTIFY pgrst, 'reload schema';

COMMIT;
