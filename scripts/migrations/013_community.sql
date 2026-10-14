-- 013_community.sql — Community module: articles, comments, likes, bookmarks, follows, author profiles.
BEGIN;

-- ============================================================================
-- Tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS novel.community_articles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  excerpt        TEXT,
  section        TEXT NOT NULL,
  tags           TEXT[] NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'draft',
  like_count     INT NOT NULL DEFAULT 0,
  comment_count  INT NOT NULL DEFAULT 0,
  bookmark_count INT NOT NULL DEFAULT 0,
  published_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT community_articles_status CHECK (status IN ('draft','published','hidden','deleted')),
  CONSTRAINT community_articles_section CHECK (section IN ('prompt','worldbuilding','character','outline','chapter','tools','showcase','announcements'))
);

CREATE TABLE IF NOT EXISTS novel.community_comments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id       UUID NOT NULL REFERENCES novel.community_articles(id) ON DELETE CASCADE,
  author_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  root_id          UUID REFERENCES novel.community_comments(id) ON DELETE CASCADE,
  reply_to_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  body             TEXT NOT NULL,
  like_count       INT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'visible',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT community_comments_status CHECK (status IN ('visible','hidden','deleted'))
);

CREATE TABLE IF NOT EXISTS novel.community_article_likes (
  article_id UUID NOT NULL REFERENCES novel.community_articles(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, user_id)
);

CREATE TABLE IF NOT EXISTS novel.community_comment_likes (
  comment_id UUID NOT NULL REFERENCES novel.community_comments(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);

CREATE TABLE IF NOT EXISTS novel.community_bookmarks (
  article_id UUID NOT NULL REFERENCES novel.community_articles(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, user_id)
);

CREATE TABLE IF NOT EXISTS novel.community_follows (
  follower_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  followee_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT community_follows_no_self CHECK (follower_id <> followee_id)
);

CREATE TABLE IF NOT EXISTS novel.community_author_profiles (
  user_id        UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  is_official    BOOLEAN NOT NULL DEFAULT false,
  bio            TEXT,
  article_count  INT NOT NULL DEFAULT 0,
  follower_count INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_community_articles_published
  ON novel.community_articles (published_at DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_community_articles_author
  ON novel.community_articles (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_articles_section
  ON novel.community_articles (section) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_community_articles_tags
  ON novel.community_articles USING GIN (tags) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_community_articles_popular
  ON novel.community_articles (like_count DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_community_comments_article
  ON novel.community_comments (article_id, created_at ASC) WHERE status = 'visible';
CREATE INDEX IF NOT EXISTS idx_community_comments_root
  ON novel.community_comments (root_id, created_at ASC) WHERE status = 'visible' AND root_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_community_follows_followee
  ON novel.community_follows (followee_id);

-- ============================================================================
-- Triggers: updated_at
-- ============================================================================

DROP TRIGGER IF EXISTS trg_community_articles_updated ON novel.community_articles;
CREATE TRIGGER trg_community_articles_updated
  BEFORE UPDATE ON novel.community_articles
  FOR EACH ROW EXECUTE FUNCTION novel.set_updated_at();

DROP TRIGGER IF EXISTS trg_community_comments_updated ON novel.community_comments;
CREATE TRIGGER trg_community_comments_updated
  BEFORE UPDATE ON novel.community_comments
  FOR EACH ROW EXECUTE FUNCTION novel.set_updated_at();

DROP TRIGGER IF EXISTS trg_community_author_profiles_updated ON novel.community_author_profiles;
CREATE TRIGGER trg_community_author_profiles_updated
  BEFORE UPDATE ON novel.community_author_profiles
  FOR EACH ROW EXECUTE FUNCTION novel.set_updated_at();

-- ============================================================================
-- Triggers: denormalized count maintenance
-- ============================================================================

-- article_likes <-> articles.like_count
CREATE OR REPLACE FUNCTION novel.community_article_like_count()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE novel.community_articles SET like_count = like_count + 1 WHERE id = NEW.article_id;
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE novel.community_articles SET like_count = like_count - 1 WHERE id = OLD.article_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_community_article_likes_count ON novel.community_article_likes;
CREATE TRIGGER trg_community_article_likes_count
  AFTER INSERT OR DELETE ON novel.community_article_likes
  FOR EACH ROW EXECUTE FUNCTION novel.community_article_like_count();

-- comment_likes <-> comments.like_count
CREATE OR REPLACE FUNCTION novel.community_comment_like_count()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE novel.community_comments SET like_count = like_count + 1 WHERE id = NEW.comment_id;
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE novel.community_comments SET like_count = like_count - 1 WHERE id = OLD.comment_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_community_comment_likes_count ON novel.community_comment_likes;
CREATE TRIGGER trg_community_comment_likes_count
  AFTER INSERT OR DELETE ON novel.community_comment_likes
  FOR EACH ROW EXECUTE FUNCTION novel.community_comment_like_count();

-- comments <-> articles.comment_count (visible comments only; soft-delete decrements)
CREATE OR REPLACE FUNCTION novel.community_comment_count()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    IF NEW.status = 'visible' THEN
      UPDATE novel.community_articles SET comment_count = comment_count + 1 WHERE id = NEW.article_id;
    END IF;
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    IF OLD.status = 'visible' THEN
      UPDATE novel.community_articles SET comment_count = comment_count - 1 WHERE id = OLD.article_id;
    END IF;
    RETURN OLD;
  ELSIF (TG_OP = 'UPDATE') THEN
    -- Only react when status transitions to/from visible
    IF OLD.status = 'visible' AND NEW.status <> 'visible' THEN
      UPDATE novel.community_articles SET comment_count = comment_count - 1 WHERE id = NEW.article_id;
    ELSIF OLD.status <> 'visible' AND NEW.status = 'visible' THEN
      UPDATE novel.community_articles SET comment_count = comment_count + 1 WHERE id = NEW.article_id;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_community_comments_count ON novel.community_comments;
CREATE TRIGGER trg_community_comments_count
  AFTER INSERT OR DELETE OR UPDATE OF status ON novel.community_comments
  FOR EACH ROW EXECUTE FUNCTION novel.community_comment_count();

-- bookmarks <-> articles.bookmark_count
CREATE OR REPLACE FUNCTION novel.community_bookmark_count()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE novel.community_articles SET bookmark_count = bookmark_count + 1 WHERE id = NEW.article_id;
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE novel.community_articles SET bookmark_count = bookmark_count - 1 WHERE id = OLD.article_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_community_bookmarks_count ON novel.community_bookmarks;
CREATE TRIGGER trg_community_bookmarks_count
  AFTER INSERT OR DELETE ON novel.community_bookmarks
  FOR EACH ROW EXECUTE FUNCTION novel.community_bookmark_count();

-- follows <-> author_profiles.follower_count
CREATE OR REPLACE FUNCTION novel.community_follow_count()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    INSERT INTO novel.community_author_profiles (user_id, follower_count)
      VALUES (NEW.followee_id, 1)
      ON CONFLICT (user_id) DO UPDATE SET follower_count = novel.community_author_profiles.follower_count + 1;
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE novel.community_author_profiles SET follower_count = GREATEST(follower_count - 1, 0) WHERE user_id = OLD.followee_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_community_follows_count ON novel.community_follows;
CREATE TRIGGER trg_community_follows_count
  AFTER INSERT OR DELETE ON novel.community_follows
  FOR EACH ROW EXECUTE FUNCTION novel.community_follow_count();

-- articles.status <-> author_profiles.article_count
CREATE OR REPLACE FUNCTION novel.community_article_author_count()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    IF NEW.status = 'published' THEN
      INSERT INTO novel.community_author_profiles (user_id, article_count)
        VALUES (NEW.author_id, 1)
        ON CONFLICT (user_id) DO UPDATE SET article_count = novel.community_author_profiles.article_count + 1;
    ELSE
      INSERT INTO novel.community_author_profiles (user_id, article_count)
        VALUES (NEW.author_id, 0)
        ON CONFLICT (user_id) DO NOTHING;
    END IF;
    RETURN NEW;
  ELSIF (TG_OP = 'UPDATE') THEN
    IF OLD.status = 'published' AND NEW.status <> 'published' THEN
      UPDATE novel.community_author_profiles SET article_count = GREATEST(article_count - 1, 0) WHERE user_id = NEW.author_id;
    ELSIF OLD.status <> 'published' AND NEW.status = 'published' THEN
      INSERT INTO novel.community_author_profiles (user_id, article_count)
        VALUES (NEW.author_id, 1)
        ON CONFLICT (user_id) DO UPDATE SET article_count = novel.community_author_profiles.article_count + 1;
    END IF;
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    IF OLD.status = 'published' THEN
      UPDATE novel.community_author_profiles SET article_count = GREATEST(article_count - 1, 0) WHERE user_id = OLD.author_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_community_articles_author_count ON novel.community_articles;
CREATE TRIGGER trg_community_articles_author_count
  AFTER INSERT OR DELETE OR UPDATE OF status ON novel.community_articles
  FOR EACH ROW EXECUTE FUNCTION novel.community_article_author_count();

-- ============================================================================
-- RLS: articles
-- ============================================================================

ALTER TABLE novel.community_articles ENABLE ROW LEVEL SECURITY;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_articles_select' AND polrelid = 'novel.community_articles'::regclass) THEN
    CREATE POLICY community_articles_select ON novel.community_articles
      FOR SELECT TO anon, authenticated
      USING (
        status = 'published'
        OR author_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
      );
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_articles_insert' AND polrelid = 'novel.community_articles'::regclass) THEN
    CREATE POLICY community_articles_insert ON novel.community_articles
      FOR INSERT TO authenticated
      WITH CHECK (author_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_articles_update' AND polrelid = 'novel.community_articles'::regclass) THEN
    CREATE POLICY community_articles_update ON novel.community_articles
      FOR UPDATE TO authenticated
      USING (author_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid)
      WITH CHECK (author_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;

-- ============================================================================
-- RLS: comments
-- ============================================================================

ALTER TABLE novel.community_comments ENABLE ROW LEVEL SECURITY;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_comments_select' AND polrelid = 'novel.community_comments'::regclass) THEN
    CREATE POLICY community_comments_select ON novel.community_comments
      FOR SELECT TO anon, authenticated
      USING (
        status = 'visible'
        AND EXISTS (
          SELECT 1 FROM novel.community_articles a
          WHERE a.id = article_id AND a.status = 'published'
        )
      );
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_comments_insert' AND polrelid = 'novel.community_comments'::regclass) THEN
    CREATE POLICY community_comments_insert ON novel.community_comments
      FOR INSERT TO authenticated
      WITH CHECK (author_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_comments_update' AND polrelid = 'novel.community_comments'::regclass) THEN
    CREATE POLICY community_comments_update ON novel.community_comments
      FOR UPDATE TO authenticated
      USING (author_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid)
      WITH CHECK (author_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;

-- ============================================================================
-- RLS: interaction tables (owner-scoped)
-- ============================================================================

ALTER TABLE novel.community_article_likes ENABLE ROW LEVEL SECURITY;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_article_likes_select' AND polrelid = 'novel.community_article_likes'::regclass) THEN
    CREATE POLICY community_article_likes_select ON novel.community_article_likes
      FOR SELECT TO authenticated
      USING (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_article_likes_insert' AND polrelid = 'novel.community_article_likes'::regclass) THEN
    CREATE POLICY community_article_likes_insert ON novel.community_article_likes
      FOR INSERT TO authenticated
      WITH CHECK (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_article_likes_delete' AND polrelid = 'novel.community_article_likes'::regclass) THEN
    CREATE POLICY community_article_likes_delete ON novel.community_article_likes
      FOR DELETE TO authenticated
      USING (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;

-- comment_likes: same owner-scoped pattern
ALTER TABLE novel.community_comment_likes ENABLE ROW LEVEL SECURITY;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_comment_likes_select' AND polrelid = 'novel.community_comment_likes'::regclass) THEN
    CREATE POLICY community_comment_likes_select ON novel.community_comment_likes
      FOR SELECT TO authenticated USING (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_comment_likes_insert' AND polrelid = 'novel.community_comment_likes'::regclass) THEN
    CREATE POLICY community_comment_likes_insert ON novel.community_comment_likes
      FOR INSERT TO authenticated WITH CHECK (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_comment_likes_delete' AND polrelid = 'novel.community_comment_likes'::regclass) THEN
    CREATE POLICY community_comment_likes_delete ON novel.community_comment_likes
      FOR DELETE TO authenticated USING (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;

-- bookmarks: same owner-scoped pattern
ALTER TABLE novel.community_bookmarks ENABLE ROW LEVEL SECURITY;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_bookmarks_select' AND polrelid = 'novel.community_bookmarks'::regclass) THEN
    CREATE POLICY community_bookmarks_select ON novel.community_bookmarks
      FOR SELECT TO authenticated USING (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_bookmarks_insert' AND polrelid = 'novel.community_bookmarks'::regclass) THEN
    CREATE POLICY community_bookmarks_insert ON novel.community_bookmarks
      FOR INSERT TO authenticated WITH CHECK (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_bookmarks_delete' AND polrelid = 'novel.community_bookmarks'::regclass) THEN
    CREATE POLICY community_bookmarks_delete ON novel.community_bookmarks
      FOR DELETE TO authenticated USING (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;

-- ============================================================================
-- RLS: follows (public SELECT, follower-scoped write)
-- ============================================================================

ALTER TABLE novel.community_follows ENABLE ROW LEVEL SECURITY;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_follows_select' AND polrelid = 'novel.community_follows'::regclass) THEN
    CREATE POLICY community_follows_select ON novel.community_follows
      FOR SELECT TO anon, authenticated USING (true);
  END IF;
END
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_follows_insert' AND polrelid = 'novel.community_follows'::regclass) THEN
    CREATE POLICY community_follows_insert ON novel.community_follows
      FOR INSERT TO authenticated WITH CHECK (follower_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_follows_delete' AND polrelid = 'novel.community_follows'::regclass) THEN
    CREATE POLICY community_follows_delete ON novel.community_follows
      FOR DELETE TO authenticated USING (follower_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;

-- ============================================================================
-- RLS: author_profiles (public SELECT, owner-scoped UPDATE)
-- ============================================================================

ALTER TABLE novel.community_author_profiles ENABLE ROW LEVEL SECURITY;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_author_profiles_select' AND polrelid = 'novel.community_author_profiles'::regclass) THEN
    CREATE POLICY community_author_profiles_select ON novel.community_author_profiles
      FOR SELECT TO anon, authenticated USING (true);
  END IF;
END
$migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'community_author_profiles_update' AND polrelid = 'novel.community_author_profiles'::regclass) THEN
    CREATE POLICY community_author_profiles_update ON novel.community_author_profiles
      FOR UPDATE TO authenticated
      USING (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid)
      WITH CHECK (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;
-- No INSERT policy for authenticated: profiles are created by triggers (SECURITY DEFINER).
-- is_official is set only via forSystem (postgres role, bypasses RLS).

-- ============================================================================
-- Grants
-- ============================================================================

GRANT SELECT ON novel.community_articles TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON novel.community_articles TO authenticated;

GRANT SELECT ON novel.community_comments TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON novel.community_comments TO authenticated;

GRANT SELECT, INSERT, DELETE ON novel.community_article_likes TO authenticated;
GRANT SELECT, INSERT, DELETE ON novel.community_comment_likes TO authenticated;
GRANT SELECT, INSERT, DELETE ON novel.community_bookmarks TO authenticated;

GRANT SELECT ON novel.community_follows TO anon, authenticated;
GRANT INSERT, DELETE ON novel.community_follows TO authenticated;

GRANT SELECT ON novel.community_author_profiles TO anon, authenticated;
GRANT UPDATE ON novel.community_author_profiles TO authenticated;

-- Trigger functions: grant execute to postgres (they are SECURITY DEFINER, called by triggers)
GRANT EXECUTE ON FUNCTION novel.community_article_like_count() TO postgres;
GRANT EXECUTE ON FUNCTION novel.community_comment_like_count() TO postgres;
GRANT EXECUTE ON FUNCTION novel.community_comment_count() TO postgres;
GRANT EXECUTE ON FUNCTION novel.community_bookmark_count() TO postgres;
GRANT EXECUTE ON FUNCTION novel.community_follow_count() TO postgres;
GRANT EXECUTE ON FUNCTION novel.community_article_author_count() TO postgres;

COMMIT;
