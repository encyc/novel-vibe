import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../../scripts/migrations/004_project_lifecycle.sql", import.meta.url);

describe("project lifecycle transaction migration", () => {
  it("locks the project and checks processing Sessions before transition", () => {
    const exists = existsSync(migrationUrl);
    expect(exists).toBe(true);
    if (!exists) return;
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION novel.transition_project_lifecycle");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("processing_lease_id IS NOT NULL");
    expect(sql).toContain("purge_in_progress");
    expect(sql).toContain("pre_trash_status");
  });
});
