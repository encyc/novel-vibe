import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("document version migration", () => {
  const sql = readFileSync(
    new URL("../../../scripts/migrations/022_document_versions.sql", import.meta.url),
    "utf8",
  );

  it("creates version and diff tables", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.document_versions");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS novel.document_version_diffs");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_document_versions_active_lease");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_document_versions_history");
    expect(sql).toContain("DROP POLICY IF EXISTS document_versions_owner_select");
    expect(sql).toContain("DROP POLICY IF EXISTS document_version_diffs_owner_select");
  });

  it("installs the write lifecycle and repair RPCs", () => {
    for (const name of [
      "claim_document_write",
      "complete_document_write",
      "fail_document_write",
      "claim_document_version_repairs",
    ]) {
      expect(sql).toContain(`FUNCTION novel.${name}`);
    }
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("SET search_path = pg_catalog, novel, public");
  });

  it("allows owners to read but not mutate version history directly", () => {
    expect(sql).toContain("document_versions_owner_select");
    expect(sql).toContain("document_version_diffs_owner_select");
    expect(sql).not.toContain("document_versions_owner_delete");
    expect(sql).toContain("REVOKE INSERT, UPDATE, DELETE ON novel.document_versions FROM authenticated");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION novel.claim_document_version_repairs");
    expect(sql).toContain("TO project_admin");
  });
});
