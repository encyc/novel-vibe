import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../../scripts/migrations/002_project_management.sql", import.meta.url);

describe("project management migration", () => {
  it("defines idempotent project and session lifecycle schema", () => {
    const exists = existsSync(migrationUrl);
    expect(exists).toBe(true);
    if (!exists) return;

    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS lifecycle_status");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS writing_stage");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS pre_trash_status");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS archived_at");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS purge_after");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_projects_owner_lifecycle_activity");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_sessions_project_lifecycle_message");
  });

  it("migrates project skills and creates durable deletion jobs", () => {
    const exists = existsSync(migrationUrl);
    expect(exists).toBe(true);
    if (!exists) return;

    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.project_skills");
    expect(sql).toContain("REFERENCES novel.projects(id) ON DELETE CASCADE");
    expect(sql).toContain("ON CONFLICT (project_id, skill_slug) DO NOTHING");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.project_deletion_jobs");
    expect(sql).toContain("'excluding_memory'");
    expect(sql).toContain("'deleting_storage'");
    expect(sql).toContain("'deleting_database'");
  });

  it("preserves billing records and avoids unsafe schema operations", () => {
    const exists = existsSync(migrationUrl);
    expect(exists).toBe(true);
    if (!exists) return;

    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("ON DELETE SET NULL");
    expect(sql).toContain("usage_records_project_id_fkey");
    expect(sql).not.toMatch(/ALTER TABLE\s+\S+\s+RENAME TO/i);
    expect(sql).not.toMatch(/project_deletion_jobs[\s\S]*project_id\s+UUID[^,]*REFERENCES novel\.projects/i);
  });
});
