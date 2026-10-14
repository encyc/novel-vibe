import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/029_scheduler.sql",
  import.meta.url,
);
const migration = existsSync(fileURLToPath(migrationUrl))
  ? readFileSync(migrationUrl, "utf8")
  : "";

describe("scheduler migration", () => {
  it("creates durable run history with one success per scheduled date", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS novel.scheduler_runs");
    expect(migration).toContain("job_name TEXT NOT NULL");
    expect(migration).toContain("schedule_date DATE");
    expect(migration).toContain("next_retry_at TIMESTAMPTZ");
    expect(migration).toContain("summary JSONB");
    expect(migration).toContain("idx_scheduler_runs_unique_success");
    expect(migration).toContain("WHERE status = 'succeeded'");
  });

  it("creates a leased email outbox that can recover expired sends", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS novel.system_email_outbox");
    expect(migration).toContain("lease_id UUID");
    expect(migration).toContain("lease_expires_at TIMESTAMPTZ");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION novel.claim_system_email_outbox");
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("outbox.lease_expires_at <= now()");
  });

  it("keeps scheduler state restricted to project_admin", () => {
    expect(migration).toContain("ALTER TABLE novel.scheduler_runs ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE novel.system_email_outbox ENABLE ROW LEVEL SECURITY");
    expect(migration).toMatch(/REVOKE ALL ON novel\.scheduler_runs FROM PUBLIC, authenticated, anon/);
    expect(migration).toMatch(/REVOKE ALL ON novel\.system_email_outbox FROM PUBLIC, authenticated, anon/);
    expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON novel\.scheduler_runs TO project_admin/);
    expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON novel\.system_email_outbox TO project_admin/);
  });
});
