import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Read a file when it is present; `undefined` lets the caller choose how to degrade. */
const readIfPresent = (url: URL): string | undefined =>
  existsSync(url) ? readFileSync(url, "utf8") : undefined;

const migration = readIfPresent(
  new URL("../../scripts/migrations/027_rebalance_credit_package_bonuses.sql", import.meta.url),
) ?? "";

// `scripts/deploy.sh` is operator-held: the full checkout ships it, the public export
// does not. Reading it lazily (never at module top level) keeps this module from
// throwing ENOENT on import in the public repository, and the deploy-seed assertions
// are skipped only when the file is truly missing — the migration assertions above
// still run and pass in both repositories.
const deploy = readIfPresent(new URL("../../scripts/deploy.sh", import.meta.url))?.replace(/\s+/g, " ");
const hasPrivateDeployScript = deploy !== undefined;

describe("credit package bonus configuration", () => {
  it("updates existing package bonuses idempotently", () => {
    expect(migration).toContain("WHEN '尝鲜包' THEN 0");
    expect(migration).toContain("WHEN '基础包' THEN 20");
    expect(migration).toContain("WHEN '日常包' THEN 75");
    expect(migration).toContain("WHEN '进阶包' THEN 200");
    expect(migration).toContain("WHERE name IN ('尝鲜包', '基础包', '日常包', '进阶包')");
  });

  it.skipIf(!hasPrivateDeployScript)("keeps the deploy-time package seed on the same bonus ladder", () => {
    expect(deploy).toContain("('尝鲜包', '体验一下灵器 AI', 100, 10, 0,");
    expect(deploy).toContain("('基础包', '日常创作必备', 2000, 200, 20,");
    expect(deploy).toContain("('日常包', '高频创作首选', 5000, 500, 75,");
    expect(deploy).toContain("('进阶包', '专业写手推荐', 10000, 1000, 200,");
  });
});
