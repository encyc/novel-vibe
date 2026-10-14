BEGIN;

-- Content kinds, feedback workflow, and community moderation.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE novel.community_articles
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'article',
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS feedback_status TEXT,
  ADD COLUMN IF NOT EXISTS comments_enabled BOOLEAN NOT NULL DEFAULT true;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'community_articles_kind'
      AND conrelid = 'novel.community_articles'::regclass
  ) THEN
    ALTER TABLE novel.community_articles
      ADD CONSTRAINT community_articles_kind
      CHECK (kind IN ('article', 'bug', 'feature_request', 'announcement'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'community_articles_feedback_status'
      AND conrelid = 'novel.community_articles'::regclass
  ) THEN
    ALTER TABLE novel.community_articles
      ADD CONSTRAINT community_articles_feedback_status
      CHECK (
        feedback_status IS NULL
        OR (kind = 'bug' AND feedback_status IN ('open', 'fixed', 'closed'))
        OR (kind = 'feature_request' AND feedback_status IN ('open', 'planned', 'shipped', 'declined'))
      );
  END IF;
END
$migration$;

UPDATE novel.community_articles
SET kind = 'announcement', comments_enabled = false
WHERE section = 'announcements' AND kind = 'article';

UPDATE novel.community_articles
SET feedback_status = 'open'
WHERE kind IN ('bug', 'feature_request') AND feedback_status IS NULL;

CREATE TABLE IF NOT EXISTS novel.community_user_roles (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role),
  CONSTRAINT community_user_roles_role CHECK (role IN ('community_admin'))
);

ALTER TABLE novel.community_user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS community_user_roles_self_select ON novel.community_user_roles;
CREATE POLICY community_user_roles_self_select ON novel.community_user_roles
  FOR SELECT TO authenticated
  USING (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);

DROP POLICY IF EXISTS community_articles_admin_select ON novel.community_articles;
CREATE POLICY community_articles_admin_select ON novel.community_articles
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM novel.community_user_roles
      WHERE user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
        AND role = 'community_admin'
    )
  );

DROP POLICY IF EXISTS community_articles_admin_update ON novel.community_articles;
CREATE POLICY community_articles_admin_update ON novel.community_articles
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM novel.community_user_roles
      WHERE user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
        AND role = 'community_admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM novel.community_user_roles
      WHERE user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
        AND role = 'community_admin'
    )
  );

DROP POLICY IF EXISTS community_comments_insert ON novel.community_comments;
CREATE POLICY community_comments_insert ON novel.community_comments
  FOR INSERT TO authenticated
  WITH CHECK (
    author_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM novel.community_articles a
      WHERE a.id = article_id
        AND a.status = 'published'
        AND a.comments_enabled = true
    )
    AND (
      root_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM novel.community_comments root
        WHERE root.id = root_id
          AND root.article_id = article_id
          AND root.root_id IS NULL
          AND root.status = 'visible'
      )
    )
  );

GRANT SELECT ON novel.community_user_roles TO authenticated;
GRANT SELECT, INSERT, DELETE ON novel.community_user_roles TO postgres;

CREATE INDEX IF NOT EXISTS idx_community_articles_kind_published
  ON novel.community_articles (kind, published_at DESC)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_community_articles_featured
  ON novel.community_articles (kind, is_featured, published_at DESC)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_community_articles_feedback_status
  ON novel.community_articles (kind, feedback_status, updated_at DESC)
  WHERE kind IN ('bug', 'feature_request') AND status = 'published';

CREATE INDEX IF NOT EXISTS idx_community_articles_title_trgm
  ON novel.community_articles USING GIN (title gin_trgm_ops)
  WHERE status = 'published';

WITH admin_user AS (
  SELECT id
  FROM auth.users
  WHERE email = 'atomyuangao@gmail.com'
  LIMIT 1
)
INSERT INTO novel.community_user_roles (user_id, role)
SELECT id, 'community_admin'
FROM admin_user
ON CONFLICT (user_id, role) DO NOTHING;

WITH admin_user AS (
  SELECT id
  FROM auth.users
  WHERE email = 'atomyuangao@gmail.com'
  LIMIT 1
)
INSERT INTO novel.community_author_profiles (user_id, is_official)
SELECT id, true
FROM admin_user
ON CONFLICT (user_id) DO UPDATE
SET is_official = true,
    updated_at = now();

COMMIT;
