import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/031_repair_orphan_special_pricing.sql",
  import.meta.url,
);
const migration = existsSync(fileURLToPath(migrationUrl))
  ? readFileSync(migrationUrl, "utf8")
  : "";

describe("orphan special pricing repair migration", () => {
  it("deactivates tiers and time windows whose base rates are inactive", () => {
    expect(migration).toContain("UPDATE novel.credit_rate_context_tiers AS tier");
    expect(migration).toContain("UPDATE novel.credit_rate_time_windows AS rate_window");
    expect(migration.match(/NOT rate\.is_active/g)).toHaveLength(2);
  });

  it("deactivates semantically duplicate active time windows", () => {
    expect(migration).toContain("row_number() OVER");
    expect(migration).toContain("semantic_rank > 1");
  });
});
