import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../scripts/migrations/031_verified_email_registration.sql", import.meta.url);

describe("verified registration migration", () => {
  it("creates private challenge, ticket, and reservation state", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.registration_email_challenges");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.registration_tickets");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.registration_reservations");
    expect(sql).toContain("code_hash TEXT NOT NULL");
    expect(sql).toContain("ticket_hash TEXT NOT NULL UNIQUE");
    expect(sql).toContain("invite_code TEXT");
  });

  it("defines the rate limits and complete ticket lifecycle", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    for (const name of [
      "request_registration_email_code",
      "verify_registration_email_code",
      "reserve_registration_ticket",
      "release_registration_reservation",
      "finalize_registration_reservation",
      "reconcile_registration_reservations",
    ]) expect(sql).toContain(`novel.${name}`);
    expect(sql).toContain("INTERVAL '60 seconds'");
    expect(sql).toContain("INTERVAL '10 minutes'");
    expect(sql).toContain("INTERVAL '15 minutes'");
    expect(sql).toContain("failed_attempts >= 5");
    expect(sql).toContain("email_day_count >= 10");
    expect(sql).toContain("ip_hour_count >= 20");
    expect(sql).toContain("ip_day_count >= 100");
  });

  it("keeps registration state server-only", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toMatch(/REVOKE ALL ON novel\.registration_email_challenges FROM PUBLIC, authenticated, anon/);
    expect(sql).toMatch(/REVOKE ALL ON novel\.registration_tickets FROM PUBLIC, authenticated, anon/);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON novel\.registration_email_challenges TO project_admin/);
  });
});
