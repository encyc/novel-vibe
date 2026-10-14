import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../scripts/migrations/016_fix_users_upsert_trigger.sql", import.meta.url);

describe("users upsert trigger fix migration", () => {
  const sql = readFileSync(migrationUrl, "utf8");

  it("checks row existence before attempting an insert", () => {
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.id)");
    expect(sql).toContain("UPDATE auth.users");
  });

  it("preserves the insert fallback for genuinely new rows", () => {
    expect(sql).toContain("INSERT INTO auth.users (id, nickname, avatar_url)");
    expect(sql).toContain("ON CONFLICT (id) DO UPDATE");
  });

  it("rebinds the trigger idempotently", () => {
    expect(sql).toContain("DROP TRIGGER IF EXISTS users_upsert ON public.users");
    expect(sql).toContain("INSTEAD OF INSERT OR UPDATE ON public.users");
  });

  it("wraps all changes in a transaction and reloads the schema cache", () => {
    expect(sql.trim().startsWith("BEGIN;")).toBe(true);
    expect(sql.trim().endsWith("COMMIT;")).toBe(true);
    expect(sql).toContain("NOTIFY pgrst, 'reload schema'");
  });
});
