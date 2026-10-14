import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../scripts/migrations/009_safe_skill_system.sql", import.meta.url);

describe("safe skill system migration", () => {
  const sql = readFileSync(migrationUrl, "utf8");

  it("creates draft, immutable review, and role records", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.skill_drafts");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.skill_reviews");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.skill_roles");
    expect(sql).toContain("skill_reviews_are_immutable");
  });

  it("binds installed skills to an approved review and content hash", () => {
    expect(sql).toContain("active_review_id");
    expect(sql).toContain("approved_content_hash");
    expect(sql).toContain("review_policy_version");
    expect(sql).toContain("review_status");
  });

  it("enforces owner-scoped row level security", () => {
    expect(sql).toContain("ALTER TABLE public.skill_drafts ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE public.skill_reviews ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE public.skill_roles ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("skill_drafts_owner_select");
    expect(sql).toContain("skill_reviews_owner_select");
    expect(sql).toContain("skill_roles_owner_select");
    expect(sql).toContain("auth.uid()");
  });
});
