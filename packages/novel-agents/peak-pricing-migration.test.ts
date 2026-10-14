import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../scripts/migrations/024_peak_time_pricing.sql", import.meta.url),
  "utf8",
);
const rollback = readFileSync(
  new URL("../../scripts/migrations/rollback/024_peak_time_pricing.sql", import.meta.url),
  "utf8",
);
const ensureRatesMigration = readFileSync(
  new URL("../../scripts/migrations/025_ensure_opencode_deepseek_peak_prices.sql", import.meta.url),
  "utf8",
);

describe("peak-time pricing migration", () => {
  it("creates constrained UTC windows and usage audit fields", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS novel.credit_rate_time_windows");
    expect(migration).toContain("CHECK (timezone = 'UTC')");
    expect(migration).toContain("CHECK (start_minute < end_minute)");
    expect(migration).toContain("UNIQUE (credit_rate_id, label, start_minute, end_minute)");
    for (const column of [
      "request_started_at", "pricing_period", "credit_rate_window_id",
      "rate_snapshot", "billing_multiplier",
    ]) expect(migration).toContain(column);
  });

  it("seeds exact DeepSeek prices and restricts writes", () => {
    for (const value of [
      "0.046200", "0.138600", "0.001540", "0.092400", "0.277200", "0.003080",
      "0.015400", "0.000490", "0.030800", "0.000980",
    ]) expect(migration).toContain(value);
    expect(migration).toContain("('peak', 60, 240)");
    expect(migration).toContain("('peak', 360, 600)");
    expect(migration).toMatch(/REVOKE INSERT, UPDATE, DELETE ON novel\.credit_rates FROM authenticated, anon/);
    expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON novel\.credit_rate_time_windows TO project_admin/);
  });

  it("ships an explicit rollback companion", () => {
    expect(rollback).toContain("DROP TABLE IF EXISTS novel.credit_rate_time_windows");
    expect(rollback).toContain("DROP COLUMN IF EXISTS rate_snapshot");
    expect(rollback).toContain("deepseek-v4-pro");
    expect(rollback).toContain("deepseek-v4-flash");
  });

  it("creates missing opencode DeepSeek base rows idempotently", () => {
    expect(ensureRatesMigration).toContain("'deepseek-v4-pro'");
    expect(ensureRatesMigration).toContain("'deepseek-v4-flash'");
    expect(ensureRatesMigration).toMatch(/WHERE NOT EXISTS\s*\(/);
    expect(ensureRatesMigration).toContain("novel.credit_rate_time_windows");
    expect(ensureRatesMigration).toContain("ON CONFLICT (credit_rate_id, label, start_minute, end_minute) DO UPDATE");
  });

  it("deactivates legacy labels before reactivating canonical peak windows", () => {
    for (const sql of [migration, ensureRatesMigration]) {
      const deactivateIndex = sql.indexOf("UPDATE novel.credit_rate_time_windows AS existing_window");
      const insertIndex = sql.indexOf("INSERT INTO novel.credit_rate_time_windows");
      expect(deactivateIndex).toBeGreaterThanOrEqual(0);
      expect(deactivateIndex).toBeLessThan(insertIndex);
    }
  });
});
