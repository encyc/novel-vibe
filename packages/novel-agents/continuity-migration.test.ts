import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../scripts/migrations/032_continuity_jobs.sql", import.meta.url), "utf8");

describe("continuity jobs migration", () => {
  it("creates an idempotent revision-scoped queue", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.continuity_jobs");
    expect(sql).toContain("UNIQUE (project_id, chapter_path, confirmed_hash)");
    expect(sql).toContain("next_attempt_at");
    expect(sql).toContain("lease_expires_at");
  });

  it("claims work atomically and recovers expired leases", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION novel.claim_continuity_jobs");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toMatch(/status = 'pending'[\s\S]*lease_expires_at <= p_now/);
  });

  it("enforces owner-scoped user access", () => {
    expect(sql).toContain("ALTER TABLE novel.continuity_jobs ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("continuity_jobs_owner_insert");
    expect(sql).toContain("auth.uid()");
  });
});
