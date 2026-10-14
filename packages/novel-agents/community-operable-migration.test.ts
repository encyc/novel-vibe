import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../scripts/migrations/015_minimum_operable_community.sql", import.meta.url);

describe("minimum operable community migration", () => {
  const sql = readFileSync(migrationUrl, "utf8");

  it("adds content kind, featured, feedback status, and comment controls", () => {
    expect(sql).toContain("ALTER TABLE novel.community_articles");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'article'");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT false");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS feedback_status TEXT");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS comments_enabled BOOLEAN NOT NULL DEFAULT true");
    expect(sql).toContain("community_articles_kind");
    expect(sql).toContain("community_articles_feedback_status");
  });

  it("creates admin roles separately from the official badge", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.community_user_roles");
    expect(sql).toContain("role TEXT NOT NULL");
    expect(sql).toContain("community_admin");
    expect(sql).toContain("ALTER TABLE novel.community_user_roles ENABLE ROW LEVEL SECURITY");
  });

  it("allows admins to moderate articles through RLS", () => {
    expect(sql).toContain("community_articles_admin_update");
    expect(sql).toContain("FROM novel.community_user_roles");
    expect(sql).toContain("role = 'community_admin'");
  });

  it("rejects new comments when comments are disabled", () => {
    expect(sql).toContain("DROP POLICY IF EXISTS community_comments_insert");
    expect(sql).toContain("a.comments_enabled = true");
  });

  it("adds indexes used by kind filters and ranked lists", () => {
    expect(sql).toContain("idx_community_articles_kind_published");
    expect(sql).toContain("idx_community_articles_featured");
    expect(sql).toContain("idx_community_articles_feedback_status");
    expect(sql).toContain("idx_community_articles_title_trgm");
  });

  it("seeds atomyuangao as admin and official when the account exists", () => {
    expect(sql).toContain("atomyuangao@gmail.com");
    expect(sql).toContain("community_user_roles");
    expect(sql).toContain("is_official = true");
  });

  it("wraps all changes in a transaction", () => {
    expect(sql.trim().startsWith("BEGIN;")).toBe(true);
    expect(sql.trim().endsWith("COMMIT;")).toBe(true);
  });
});
