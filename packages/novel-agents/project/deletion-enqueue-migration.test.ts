import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../../scripts/migrations/005_project_deletion_enqueue.sql", import.meta.url);

describe("project deletion enqueue migration", () => {
  it("atomically validates trash state and creates one active job", () => {
    const exists = existsSync(migrationUrl);
    expect(exists).toBe(true);
    if (!exists) return;
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_project_deletion_jobs_active_project");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION novel.enqueue_project_deletion");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("lifecycle_status <> 'trash'");
    expect(sql).toContain("processing_lease_id IS NOT NULL");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION novel.enqueue_project_deletion");
  });
});
