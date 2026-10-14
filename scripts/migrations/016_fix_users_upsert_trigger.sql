BEGIN;

-- Fix the users_upsert_trigger so PATCH (UPDATE) does not fail when the
-- auth.users table has NOT NULL columns (e.g. email) that the view does
-- not expose. The original trigger always issued an INSERT, which hit the
-- NOT NULL constraint before ON CONFLICT could resolve. Now we check
-- existence first and UPDATE in-place when the row already exists.

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
        updated_at = now()
    WHERE id = NEW.id
    RETURNING id, nickname, avatar_url INTO NEW;
  ELSE
    INSERT INTO auth.users (id, nickname, avatar_url)
    VALUES (NEW.id, NEW.nickname, NEW.avatar_url)
    ON CONFLICT (id) DO UPDATE
    SET nickname = EXCLUDED.nickname,
        avatar_url = EXCLUDED.avatar_url,
        updated_at = now()
    RETURNING id, nickname, avatar_url INTO NEW;
  END IF;
  RETURN NEW;
END;
$$;

-- The trigger itself does not need to be recreated (the function is called
-- by name), but DROP+CREATE ensures the binding is current.
DROP TRIGGER IF EXISTS users_upsert ON public.users;
CREATE TRIGGER users_upsert
  INSTEAD OF INSERT OR UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_upsert_trigger();

GRANT EXECUTE ON FUNCTION public.users_upsert_trigger() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
