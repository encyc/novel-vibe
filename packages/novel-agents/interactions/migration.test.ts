import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("typed interaction migration", () => {
  const sql = readFileSync(new URL("../../../scripts/migrations/023_typed_chat_interactions.sql", import.meta.url), "utf8");

  it("creates an owner-scoped durable interaction table", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.session_interactions");
    expect(sql).toContain("REFERENCES novel.projects(id) ON DELETE CASCADE");
    expect(sql).toContain("REFERENCES novel.sessions(id) ON DELETE CASCADE");
    expect(sql).toContain("REFERENCES novel.session_messages(id) ON DELETE CASCADE");
    expect(sql).toContain("CHECK (status IN ('pending', 'resolved', 'cancelled'))");
    expect(sql).toContain("octet_length(request::text) <= 32768");
    expect(sql).toContain("octet_length(response::text) <= 16384");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("session_interactions_owner_select");
  });

  it("resolves and records the response in one locked function", () => {
    expect(sql).toContain("FUNCTION novel.create_session_interaction");
    expect(sql).toContain("FUNCTION novel.respond_to_session_interaction");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("p_idempotency_key");
    expect(sql).toContain("interactionResponse");
    expect(sql).toContain("INSERT INTO novel.session_messages");
    expect(sql).toContain("UPDATE novel.session_interactions");
    expect(sql).toContain("SET search_path = pg_catalog, novel, public");
  });

  it("does not grant direct authenticated mutation", () => {
    expect(sql).toContain("REVOKE INSERT, UPDATE, DELETE ON novel.session_interactions FROM authenticated");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION novel.respond_to_session_interaction");
  });
});
