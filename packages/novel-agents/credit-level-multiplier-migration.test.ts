import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../scripts/migrations/026_rebalance_credit_level_multipliers.sql",
  import.meta.url,
);
const sql = existsSync(fileURLToPath(migrationUrl)) ? readFileSync(migrationUrl, "utf8") : "";

describe("credit level multiplier migration", () => {
  it("sets the approved level ladder idempotently", () => {
    for (const row of [
      "(0, '新用户', 0, 2.10,",
      "(1, '普通会员', 100, 2.05,",
      "(2, '银卡会员', 500, 2.00,",
      "(3, '金卡会员', 2000, 1.95,",
      "(4, '铂金会员', 5000, 1.90,",
      "(5, '钻石会员', 10000, 1.85,",
    ]) {
      expect(sql).toContain(row);
    }
    expect(sql).toContain("ON CONFLICT (level) DO UPDATE");
    expect(sql).toContain("multiplier = EXCLUDED.multiplier");
  });

  it("updates existing denormalized user balance multipliers", () => {
    expect(sql).toContain("UPDATE novel.credit_balances AS balance");
    expect(sql).toContain("WHERE balance.level = config.level");
    expect(sql).toContain("balance.multiplier IS DISTINCT FROM config.multiplier");
  });
});
