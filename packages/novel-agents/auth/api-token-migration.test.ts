import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../../scripts/migrations/011_api_tokens.sql", import.meta.url);

describe("API token migration", () => {
  it("creates the token table and lookup indexes", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.api_tokens");
    for (const column of [
      "id", "public_id", "secret_hash", "user_id", "name", "scopes",
      "expires_at", "last_used_at", "revoked_at", "created_at",
    ]) expect(sql).toContain(column);
    expect(sql).toMatch(/UNIQUE\s*\(public_id\)|public_id\s+TEXT\s+NOT NULL\s+UNIQUE/i);
    expect(sql).not.toContain("idx_api_tokens_public_id");
    expect(sql).toContain("idx_api_tokens_active_owner");
    expect(sql).toContain("WHERE revoked_at IS NULL");
  });

  it("grants authenticated owners only safe-column reads under RLS", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toMatch(/CREATE POLICY api_tokens_owner_select[\s\S]*FOR SELECT TO authenticated/);
    expect(sql).toContain("user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid");
    expect(sql).toContain("REVOKE ALL ON novel.api_tokens FROM PUBLIC");
    expect(sql).toMatch(/GRANT SELECT \(\s*id, public_id, user_id, name, scopes, expires_at,\s*last_used_at, revoked_at, created_at\s*\) ON novel\.api_tokens TO authenticated;/);
    expect(sql).not.toMatch(/GRANT\s+SELECT\s+ON\s+novel\.api_tokens\s+TO\s+authenticated/i);
    expect(sql).not.toMatch(/GRANT SELECT \([^)]*secret_hash[^)]*\) ON novel\.api_tokens TO authenticated/is);
  });

  it("revokes authenticated writes and defines no write policies", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("REVOKE INSERT, UPDATE, DELETE ON novel.api_tokens FROM authenticated;");
    expect(sql).toContain("REVOKE UPDATE (last_used_at, revoked_at) ON novel.api_tokens FROM authenticated;");
    expect(sql).not.toMatch(/CREATE POLICY api_tokens_owner_(insert|update|delete)/);
    expect(sql).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)/i);
  });

  it("reserves secret-bearing persistence and authentication lookup for postgres", () => {
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON novel.api_tokens TO postgres");
    expect(sql).toContain("Token management remains Web-session-only");
  });
});
