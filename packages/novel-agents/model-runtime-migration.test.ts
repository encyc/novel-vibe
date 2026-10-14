import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../scripts/migrations/030_dynamic_model_runtime.sql", import.meta.url);
const rollbackUrl = new URL("../../scripts/migrations/rollback/030_dynamic_model_runtime_rollback.sql", import.meta.url);
const readIfPresent = (url: URL) => existsSync(fileURLToPath(url)) ? readFileSync(url, "utf8") : "";
const migration = readIfPresent(migrationUrl);
const rollback = readIfPresent(rollbackUrl);

describe("dynamic model runtime migration", () => {
  it("creates a constrained runtime catalog and incident history", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS novel.model_runtime_catalog");
    expect(migration).toContain("UNIQUE (provider, model_id)");
    expect(migration).toContain("CHECK (status IN ('active', 'disabled', 'retired'))");
    expect(migration).toContain("CHECK (api IN (");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS novel.model_runtime_incidents");
    expect(migration).toContain("REFERENCES novel.model_runtime_catalog(id)");
  });

  it("atomically disables only the matching active fingerprint", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION novel.disable_dynamic_model");
    expect(migration).toContain("runtime.runtime_fingerprint = p_runtime_fingerprint");
    expect(migration).toContain("runtime.status = 'active'");
    expect(migration).toContain("INSERT INTO novel.model_runtime_incidents");
    expect(migration).toContain("UPDATE novel.credit_rates AS rate");
    expect(migration).toContain("INSERT INTO novel.system_email_outbox");
  });

  it("restricts runtime state to trusted workers", () => {
    expect(migration).toContain("ALTER TABLE novel.model_runtime_catalog ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE novel.model_runtime_incidents ENABLE ROW LEVEL SECURITY");
    expect(migration).toMatch(/REVOKE ALL ON novel\.model_runtime_catalog FROM PUBLIC, authenticated, anon/);
    expect(migration).toMatch(/REVOKE ALL ON novel\.model_runtime_incidents FROM PUBLIC, authenticated, anon/);
    expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON novel\.model_runtime_catalog TO project_admin/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION novel\.disable_dynamic_model/);
  });

  it("rolls back the function before its tables", () => {
    const functionIndex = rollback.indexOf("DROP FUNCTION IF EXISTS novel.disable_dynamic_model");
    const incidentIndex = rollback.indexOf("DROP TABLE IF EXISTS novel.model_runtime_incidents");
    const catalogIndex = rollback.indexOf("DROP TABLE IF EXISTS novel.model_runtime_catalog");
    expect(functionIndex).toBeGreaterThanOrEqual(0);
    expect(incidentIndex).toBeGreaterThan(functionIndex);
    expect(catalogIndex).toBeGreaterThan(incidentIndex);
  });
});
