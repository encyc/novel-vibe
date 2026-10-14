import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../scripts/migrations/007_profile_credit_center.sql", import.meta.url);

describe("profile credit center migration", () => {
  it("reuses public users and defines immutable purchase snapshots", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("public.users");
    expect(sql).toContain("package_name_snapshot");
    expect(sql).toContain("bonus_credits_snapshot");
    expect(sql).toContain("uid() = id");
    expect(sql).toContain("credit_purchases_owner_select");
  });

  it("defines cursor queries, activity aggregation, and atomic completion", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("novel.list_credit_transactions_cursor");
    expect(sql).toContain("novel.credit_activity_by_day");
    expect(sql).toContain("novel.complete_credit_purchase");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("ON CONFLICT (reference_type, reference_id)\n    WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL");
  });

  it("creates the avatars bucket and supporting indexes idempotently", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("'avatars'");
    expect(sql).toContain("ON CONFLICT (name) DO NOTHING");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_usage_records_user_created");
  });
});
