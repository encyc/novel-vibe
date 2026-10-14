import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../../scripts/migrations/003_novel_rls.sql", import.meta.url);

describe("Novel Vibe RLS migration", () => {
  it("enables RLS and defines operation-specific ownership policies", () => {
    const exists = existsSync(migrationUrl);
    expect(exists).toBe(true);
    if (!exists) return;

    const sql = readFileSync(migrationUrl, "utf8");
    for (const table of [
      "projects", "document_index", "agent_tasks", "foreshadow_index",
      "sessions", "session_messages", "session_agent_state", "memory_jobs",
      "memory_exclusions", "project_deletion_jobs",
    ]) {
      expect(sql).toContain(`ALTER TABLE novel.${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain("ALTER TABLE public.project_skills ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE public.workspace_skills ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("projects_owner_select");
    expect(sql).toContain("projects_owner_insert");
    expect(sql).toContain("projects_owner_update");
    expect(sql).toContain("projects_owner_delete");
    expect(sql).toContain("document_index_owner_select");
    expect(sql).toContain("session_messages_owner_insert");
    expect(sql).toContain("project_skills_owner_update");
    expect(sql).toContain("workspace_skills_owner_select");
    expect(sql).toContain("(SELECT auth.jwt() ->> 'sub')");
    expect(sql).toContain("FROM novel.projects p");
  });

  it("keeps worker and billing mutations system-only", () => {
    const exists = existsSync(migrationUrl);
    expect(exists).toBe(true);
    if (!exists) return;

    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION novel.claim_memory_jobs");
    expect(sql).toContain("REVOKE INSERT, UPDATE, DELETE ON novel.credit_balances");
    expect(sql).toContain("credit_balances_owner_select");
    expect(sql).toContain("credit_transactions_owner_select");
    expect(sql).toContain("usage_records_owner_select");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION novel.prepare_session_memory_delete");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("Session does not belong to authenticated user");
  });

  it("guards policy creation for idempotent replay", () => {
    const exists = existsSync(migrationUrl);
    expect(exists).toBe(true);
    if (!exists) return;

    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("FROM pg_policy");
    expect(sql).toContain("IF NOT EXISTS");
    expect(sql).not.toMatch(/CREATE POLICY IF NOT EXISTS/i);
  });
});
