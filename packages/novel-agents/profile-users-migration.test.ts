import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../scripts/migrations/008_profile_users_fix.sql", import.meta.url);
const sql = readFileSync(migrationUrl, "utf8");
const normalizedSql = sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();

describe("profile users migration", () => {
  it("does not replace an existing users view that later migrations may have extended", () => {
    expect(normalizedSql).toContain("IF to_regclass('public.users') IS NULL THEN");
    expect(normalizedSql).toContain(
      "CREATE VIEW public.users AS SELECT id, nickname, avatar_url FROM auth.users",
    );
    expect(normalizedSql).not.toContain("CREATE OR REPLACE VIEW public.users");
  });
});
