import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../../scripts/migrations/006_project_deletion_worker.sql", import.meta.url), "utf8");

describe("project deletion worker migration", () => {
  it("claims atomically, freezes memory capture, and completes database purge", () => {
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("freeze_project_for_deletion");
    expect(sql).toMatch(/memory_jobs[\s\S]*status = 'cancelled'/);
    expect(sql).toContain("purge_project_database");
    expect(sql).toMatch(/DELETE FROM novel\.projects[\s\S]*stage = 'complete'/);
  });
});
