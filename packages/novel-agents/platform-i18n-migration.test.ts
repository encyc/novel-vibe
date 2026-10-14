import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isSupportedLanguage,
  normalizeSupportedLanguage,
  SUPPORTED_LANGUAGES,
} from "./lib/language.js";

const migrationUrl = new URL("../../scripts/migrations/019_platform_i18n.sql", import.meta.url);
const sql = readFileSync(migrationUrl, "utf8");
const normalizedSql = sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();

describe("platform i18n migration", () => {
  it("wraps ordered, repeat-safe DDL in one transaction", () => {
    expect(normalizedSql).toMatch(/^BEGIN; .* COMMIT;$/);
    expect(normalizedSql).toMatch(/DO \$migration\$ BEGIN[\s\S]*END \$migration\$;/);

    const usersColumn = normalizedSql.indexOf("ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS locale TEXT;");
    const usersView = normalizedSql.indexOf("CREATE OR REPLACE VIEW public.users AS SELECT id, nickname, avatar_url, locale FROM auth.users;");
    const usersTrigger = normalizedSql.indexOf("CREATE OR REPLACE FUNCTION public.users_upsert_trigger()");
    const projectColumn = normalizedSql.indexOf("ALTER TABLE novel.projects ADD COLUMN IF NOT EXISTS creative_language TEXT NOT NULL DEFAULT 'zh-CN';");
    const backfill = normalizedSql.indexOf("UPDATE novel.projects SET creative_language = 'zh-CN' WHERE creative_language IS NULL;");
    const constraints = normalizedSql.indexOf("DO $migration$");

    expect(usersColumn).toBeGreaterThan(0);
    expect(usersView).toBeGreaterThan(usersColumn);
    expect(usersTrigger).toBeGreaterThan(usersView);
    expect(projectColumn).toBeGreaterThan(usersTrigger);
    expect(backfill).toBeGreaterThan(projectColumn);
    expect(constraints).toBeGreaterThan(backfill);
  });

  it("keeps the legacy profile locale nullable while constraining its canonical values", () => {
    expect(normalizedSql).toContain("ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS locale TEXT;");
    expect(normalizedSql).not.toMatch(/ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL/);
    expect(normalizedSql).toContain("CREATE OR REPLACE VIEW public.users AS SELECT id, nickname, avatar_url, locale FROM auth.users;");
    expect(normalizedSql).toMatch(/UPDATE auth\.users SET nickname = NEW\.nickname, avatar_url = NEW\.avatar_url, locale = NEW\.locale, updated_at = now\(\)/);
    expect(normalizedSql).toMatch(/INSERT INTO auth\.users \(id, nickname, avatar_url, locale\) VALUES \(NEW\.id, NEW\.nickname, NEW\.avatar_url, NEW\.locale\)/);
    expect(normalizedSql).toContain("RETURNING id, nickname, avatar_url, locale INTO NEW;");
    expect(normalizedSql).toContain("DROP TRIGGER IF EXISTS users_upsert ON public.users;");
    expect(normalizedSql).toContain("CREATE TRIGGER users_upsert INSTEAD OF INSERT OR UPDATE ON public.users");
    expect(normalizedSql).toContain("GRANT SELECT, INSERT, UPDATE ON public.users TO authenticated;");
    expect(normalizedSql).toContain("NOTIFY pgrst, 'reload schema';");
    expect(normalizedSql).toMatch(
      /IF NOT EXISTS \( SELECT 1 FROM pg_constraint WHERE conname = 'users_locale_check' AND conrelid = 'auth\.users'::regclass \) THEN ALTER TABLE auth\.users ADD CONSTRAINT users_locale_check CHECK \(locale IS NULL OR locale IN \('zh-CN', 'en'\)\); END IF;/,
    );
  });

  it("creates and backfills a non-null project language with the canonical default", () => {
    expect(normalizedSql).toContain(
      "ALTER TABLE novel.projects ADD COLUMN IF NOT EXISTS creative_language TEXT NOT NULL DEFAULT 'zh-CN';",
    );
    expect(normalizedSql).toContain(
      "UPDATE novel.projects SET creative_language = 'zh-CN' WHERE creative_language IS NULL;",
    );
    expect(normalizedSql).toMatch(
      /IF NOT EXISTS \( SELECT 1 FROM pg_constraint WHERE conname = 'projects_creative_language_check' AND conrelid = 'novel\.projects'::regclass \) THEN ALTER TABLE novel\.projects ADD CONSTRAINT projects_creative_language_check CHECK \(creative_language IN \('zh-CN', 'en'\)\); END IF;/,
    );
  });
});

describe("supported languages", () => {
  it("accepts only canonical values", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(["zh-CN", "en"]);
    expect(isSupportedLanguage("zh-CN")).toBe(true);
    expect(isSupportedLanguage("en")).toBe(true);
    expect(isSupportedLanguage("en-US")).toBe(false);
    expect(normalizeSupportedLanguage("en-US", "zh-CN")).toBe("en");
    expect(normalizeSupportedLanguage("fr-FR", "zh-CN")).toBe("zh-CN");
  });
});
