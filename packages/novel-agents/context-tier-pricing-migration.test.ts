import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/028_context_tier_pricing.sql",
  import.meta.url,
);
const migration = existsSync(fileURLToPath(migrationUrl))
  ? readFileSync(migrationUrl, "utf8")
  : "";

describe("context-tier pricing migration", () => {
  it("creates constrained context tiers and usage audit fields", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS novel.credit_rate_context_tiers");
    expect(migration).toContain("min_context_tokens BIGINT NOT NULL");
    expect(migration).toContain("max_context_tokens BIGINT");
    expect(migration).toContain("CHECK (min_context_tokens >= 0)");
    expect(migration).toContain("CHECK (max_context_tokens IS NULL OR max_context_tokens >= min_context_tokens)");
    expect(migration).toContain("idx_credit_rate_context_tiers_active");
    expect(migration).toContain("context_tokens BIGINT");
    expect(migration).toContain("credit_rate_context_tier_id UUID");
    expect(migration).toContain("ON DELETE SET NULL");
  });

  it("keeps tier mutations system-owned", () => {
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toMatch(/REVOKE ALL ON novel\.credit_rate_context_tiers FROM PUBLIC, authenticated, anon/);
    expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON novel\.credit_rate_context_tiers TO project_admin/);
    expect(migration).toMatch(/GRANT SELECT ON novel\.credit_rate_context_tiers TO authenticated, anon/);
  });

  it("seeds the four existing high-context OpenCode rates idempotently", () => {
    for (const modelPattern of [
      "claude-sonnet-4-5", "claude-sonnet-4.5", "gemini-3.1-pro%", "gpt-5.4", "gpt-5.5",
    ]) expect(migration).toContain(`'${modelPattern}'`);
    for (const threshold of ["200001", "272001"]) expect(migration).toContain(threshold);
    for (const rate of [
      "0.420000", "1.575000", "0.042000", "0.525000",
      "0.280000", "1.260000", "0.028000",
      "0.350000", "0.035000",
      "0.700000", "3.150000", "0.070000",
    ]) expect(migration).toContain(rate);
    expect(migration).toContain(
      "ON CONFLICT (credit_rate_id, credit_rate_time_window_id, min_context_tokens) DO UPDATE",
    );
    expect(migration).toContain("is_active = true");
  });

  it("does not reactivate tiers for inactive base rates", () => {
    expect(migration).toMatch(
      /WHERE rate\.provider_pattern = 'opencode'\s+AND rate\.is_active = true/,
    );
  });
});
