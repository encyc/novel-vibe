import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationUrl = resolve(__dirname, "../../scripts/migrations/013_community.sql");
const hardeningMigrationUrl = resolve(__dirname, "../../scripts/migrations/014_community_harden_rls.sql");

describe("community migration", () => {
  const sql = readFileSync(migrationUrl, "utf8");

  it("creates all seven tables", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.community_articles");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.community_comments");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.community_article_likes");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.community_comment_likes");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.community_bookmarks");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.community_follows");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.community_author_profiles");
  });

  it("enables RLS on all tables", () => {
    expect(sql).toContain("ALTER TABLE novel.community_articles ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE novel.community_comments ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE novel.community_author_profiles ENABLE ROW LEVEL SECURITY");
  });

  it("grants anon SELECT on public-readable tables", () => {
    expect(sql).toContain("GRANT SELECT ON novel.community_articles TO anon");
    expect(sql).toContain("GRANT SELECT ON novel.community_comments TO anon");
    expect(sql).toContain("GRANT SELECT ON novel.community_follows TO anon");
    expect(sql).toContain("GRANT SELECT ON novel.community_author_profiles TO anon");
  });

  it("creates count-maintenance triggers", () => {
    expect(sql).toContain("trg_community_article_likes_count");
    expect(sql).toContain("trg_community_comment_likes_count");
    expect(sql).toContain("trg_community_comments_count");
    expect(sql).toContain("trg_community_bookmarks_count");
    expect(sql).toContain("trg_community_follows_count");
    expect(sql).toContain("trg_community_articles_author_count");
  });

  it("wraps in a transaction", () => {
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
  });
});

describe("community hardening migration", () => {
  const sql = readFileSync(hardeningMigrationUrl, "utf8");

  it("replaces interaction insert policies with published/visible target checks", () => {
    expect(sql).toContain("DROP POLICY IF EXISTS community_comments_insert");
    expect(sql).toContain("a.status = 'published'");
    expect(sql).toContain("root.article_id = article_id");
    expect(sql).toContain("root.root_id IS NULL");
    expect(sql).toContain("DROP POLICY IF EXISTS community_article_likes_insert");
    expect(sql).toContain("DROP POLICY IF EXISTS community_bookmarks_insert");
    expect(sql).toContain("DROP POLICY IF EXISTS community_comment_likes_insert");
    expect(sql).toContain("c.status = 'visible'");
  });
});
