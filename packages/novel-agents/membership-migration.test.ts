import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../scripts/migrations/010_membership.sql", import.meta.url);
const webSearchMigrationUrl = new URL(
  "../../scripts/migrations/020_membership_web_search.sql",
  import.meta.url,
);

describe("membership migration", () => {
  it("creates membership_plans and membership_purchases with snapshots", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.membership_plans");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.membership_purchases");
    expect(sql).toContain("plan_name_snapshot");
    expect(sql).toContain("duration_days_snapshot");
    expect(sql).toContain("bonus_credits_snapshot");
    expect(sql).toContain("features_snapshot");
    expect(sql).toContain("expires_at");
  });

  it("seeds the monthly plan at 990 cents / 30 days / 100 bonus credits", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("'monthly'");
    expect(sql).toContain("990");
    expect(sql).toContain("duration_days");
    expect(sql).toContain("100");
    expect(sql).toContain('["unlimited_projects","export"]');
  });

  it("defines completion RPC with stacking expiry and idempotent bonus", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("novel.complete_membership_purchase");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("greatest(now()");
    expect(sql).toContain("ON CONFLICT (reference_type, reference_id)");
    expect(sql).toContain("SECURITY DEFINER");
  });

  it("defines status RPC with auth.uid guard and RLS owner policy", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("novel.get_active_membership");
    expect(sql).toContain("auth.uid()");
    expect(sql).toContain("membership_purchases_owner_select");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
  });

  it("adds web_search to the monthly plan and active membership snapshots idempotently", () => {
    const sql = readFileSync(webSearchMigrationUrl, "utf8");
    expect(sql).toContain("UPDATE novel.membership_plans");
    expect(sql).toContain("slug = 'monthly'");
    expect(sql).toContain("'[\"web_search\"]'::jsonb");
    expect(sql).toContain("UPDATE novel.membership_purchases");
    expect(sql).toContain("payment_status = 'completed'");
    expect(sql).toContain("expires_at > now()");
    expect(sql).toContain("NOT (features_snapshot @>");
  });
});
