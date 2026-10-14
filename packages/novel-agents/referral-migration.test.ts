import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../scripts/migrations/032_member_referrals.sql", import.meta.url), "utf8");
const deadlineMigrationUrl = new URL(
  "../../scripts/migrations/033_referral_campaign_deadline.sql",
  import.meta.url,
);
const deadlineSql = existsSync(fileURLToPath(deadlineMigrationUrl))
  ? readFileSync(deadlineMigrationUrl, "utf8")
  : "";

describe("member referral migration", () => {
  it("creates campaign, code, binding, reward, metrics, and audit state", () => {
    for (const table of [
      "referral_campaigns", "referral_codes", "referral_slot_reservations",
      "referral_bindings", "referral_rewards", "referral_daily_metrics", "referral_admin_audit",
    ]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS novel.${table}`);
    expect(sql).toContain("UNIQUE (binding_id, beneficiary_role)");
    expect(sql).toContain("CHECK (inviter_user_id <> invitee_user_id)");
  });

  it("locks capacity and seeds a closed campaign", () => {
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("max_slots_per_inviter");
    expect(sql).toContain("purchase_window_days");
    expect(sql).toContain("reward_days");
    expect(sql).toMatch(/binding_ends_at[^;]+now\(\)/s);
  });

  it("extends membership source without granting reward Credit", () => {
    expect(sql).toContain("referral_reward");
    expect(sql).toContain("bonus_credits_snapshot");
    expect(sql).toContain("0::NUMERIC");
    expect(sql).toContain("complete_membership_purchase");
    expect(sql).toContain("RR-");
  });

  it("keeps mutation server-only", () => {
    expect(sql).toMatch(/REVOKE ALL ON novel\.referral_bindings FROM PUBLIC, authenticated, anon/);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON novel\.referral_bindings TO project_admin/);
  });

  it("expires only pending bindings with bounded row locking", () => {
    expect(sql).toContain("expire_referral_bindings");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("status = 'pending'");
  });

  it("audits deadline changes and supports risk review", () => {
    expect(sql).toContain("update_referral_campaign");
    expect(sql).toContain("referral-campaign-update");
    expect(sql).toContain("review_referral_binding");
    expect(sql).toContain("referral_qualifying_purchase_missing");
  });

  it("keeps the member referral campaign open through 2026-12-31 in future deployments", () => {
    expect(deadlineSql).toContain("member-referral-2026");
    expect(deadlineSql).toContain("2026-12-31 23:59:59+08:00");
    expect(deadlineSql).toMatch(/UPDATE novel\.referral_campaigns[\s\S]+WHERE slug = 'member-referral-2026'/);
  });
});
