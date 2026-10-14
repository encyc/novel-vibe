-- 014_community_harden_rls.sql — tighten community interaction policies.
BEGIN;

DROP POLICY IF EXISTS community_comments_insert ON novel.community_comments;
CREATE POLICY community_comments_insert ON novel.community_comments
  FOR INSERT TO authenticated
  WITH CHECK (
    author_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
    AND EXISTS (
      SELECT 1 FROM novel.community_articles a
      WHERE a.id = article_id AND a.status = 'published'
    )
    AND (
      root_id IS NULL
      OR EXISTS (
        SELECT 1 FROM novel.community_comments root
        WHERE root.id = root_id
          AND root.article_id = article_id
          AND root.root_id IS NULL
          AND root.status = 'visible'
      )
    )
  );

DROP POLICY IF EXISTS community_article_likes_insert ON novel.community_article_likes;
CREATE POLICY community_article_likes_insert ON novel.community_article_likes
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
    AND EXISTS (
      SELECT 1 FROM novel.community_articles a
      WHERE a.id = article_id AND a.status = 'published'
    )
  );

DROP POLICY IF EXISTS community_bookmarks_insert ON novel.community_bookmarks;
CREATE POLICY community_bookmarks_insert ON novel.community_bookmarks
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
    AND EXISTS (
      SELECT 1 FROM novel.community_articles a
      WHERE a.id = article_id AND a.status = 'published'
    )
  );

DROP POLICY IF EXISTS community_comment_likes_insert ON novel.community_comment_likes;
CREATE POLICY community_comment_likes_insert ON novel.community_comment_likes
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM novel.community_comments c
      JOIN novel.community_articles a ON a.id = c.article_id
      WHERE c.id = comment_id
        AND c.status = 'visible'
        AND a.status = 'published'
    )
  );

COMMIT;
