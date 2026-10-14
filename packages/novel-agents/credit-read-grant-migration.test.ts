import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/039_grant_pricing_and_interaction_reads.sql",
  import.meta.url,
);
const migration = existsSync(fileURLToPath(migrationUrl))
  ? readFileSync(migrationUrl, "utf8")
  : "";

describe("credit read grant migration", () => {
  it("re-grants the pricing table that 024 revoked from authenticated", () => {
    // The Agent Server reads pricing over PostgREST with the user JWT, so
    // project_admin-only access made every refresh fail with a 403.
    expect(migration).toMatch(
      /GRANT SELECT ON novel\.credit_rate_time_windows TO authenticated, anon/,
    );
  });

  it("adds the RLS policies the pricing tables were missing", () => {
    // A grant alone is not enough: these tables have RLS enabled with only a
    // project_admin policy, so authenticated would read zero rows and
    // context-tier pricing would be ignored without any error.
    for (const table of ["credit_rate_time_windows", "credit_rate_context_tiers"]) {
      expect(migration).toMatch(
        new RegExp(`DROP POLICY IF EXISTS ${table}_read ON novel\\.${table}`),
      );
      expect(migration).toMatch(
        new RegExp(`CREATE POLICY ${table}_read ON novel\\.${table}\\s+FOR SELECT TO authenticated, anon USING \\(true\\)`),
      );
    }
  });

  it("grants the interaction table that 023 policed but never granted", () => {
    // 023 added `FOR SELECT TO authenticated` but no table privilege, so the
    // policy could never take effect.
    expect(migration).toMatch(
      /GRANT SELECT ON novel\.session_interactions TO authenticated/,
    );
    expect(migration).not.toMatch(/session_interactions TO authenticated, anon/);
  });
});
