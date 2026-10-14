import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../../scripts/migrations/012_api_audit_events.sql", import.meta.url), "utf8");

describe("API audit migration", () => {
  it("creates an append-only server-owned audit table", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.api_audit_events");
    expect(sql).toContain("token_id UUID REFERENCES novel.api_tokens(id) ON DELETE SET NULL");
    expect(sql).toContain("ALTER TABLE novel.api_audit_events ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON novel.api_audit_events FROM authenticated");
    expect(sql).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)\s+ON\s+novel\.api_audit_events\s+TO\s+authenticated/i);
  });
});
