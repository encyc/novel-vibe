import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanSourceTree } from "./check-webui-i18n.mjs";

async function createFixture(t) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "novel-vibe-i18n-check-"));
  const sourceRoot = path.join(repositoryRoot, "src");
  await mkdir(sourceRoot);
  t.after(() => rm(repositoryRoot, { force: true, recursive: true }));
  return { repositoryRoot, sourceRoot };
}

test("scans packageable script and style extensions case-insensitively", async (t) => {
  const fixture = await createFixture(t);
  const extensions = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs", "css", "scss", "sass", "less"];
  for (const extension of extensions) {
    await writeFile(path.join(fixture.sourceRoot, `copy.${extension.toUpperCase()}`), "const label = '中文';\n");
  }

  const result = await scanSourceTree(fixture);

  assert.equal(result.hardcodedCopy.length, extensions.length);
  for (const extension of extensions) {
    assert(result.hardcodedCopy.includes(`src/copy.${extension.toUpperCase()}:1`));
  }
});

test("skips test scripts without exempting similarly named styles", async (t) => {
  const fixture = await createFixture(t);
  const testsDirectory = path.join(fixture.sourceRoot, "__tests__");
  await mkdir(testsDirectory);
  await writeFile(path.join(fixture.sourceRoot, "feature.test.ts"), "const label = '中文';\n");
  await writeFile(path.join(fixture.sourceRoot, "feature.spec.JSX"), "const label = '中文';\n");
  await writeFile(path.join(testsDirectory, "fixture.MTS"), "const label = '中文';\n");
  await writeFile(path.join(fixture.sourceRoot, "theme.test.CSS"), ".label::after { content: '中文'; }\n");
  await writeFile(path.join(testsDirectory, "fixture.SCSS"), ".label::after { content: '中文'; }\n");

  const result = await scanSourceTree(fixture);

  assert.deepEqual(result.hardcodedCopy, [
    "src/__tests__/fixture.SCSS:1",
    "src/theme.test.CSS:1",
  ]);
});

test("keeps zh-CN.ts as the only production exemption", async (t) => {
  const fixture = await createFixture(t);
  const localesDirectory = path.join(fixture.sourceRoot, "i18n/locales");
  await mkdir(localesDirectory, { recursive: true });
  await writeFile(path.join(localesDirectory, "zh-CN.ts"), "export const label = '中文';\n");
  await writeFile(path.join(localesDirectory, "zh-CN.js"), "export const label = '中文';\n");

  const result = await scanSourceTree(fixture);

  assert.deepEqual(result.hardcodedCopy, ["src/i18n/locales/zh-CN.js:1"]);
});

test("reports file and directory symlinks without following them", async (t) => {
  const fixture = await createFixture(t);
  const outsideDirectory = path.join(fixture.repositoryRoot, "outside");
  const outsideFile = path.join(fixture.repositoryRoot, "outside.ts");
  await mkdir(outsideDirectory);
  await writeFile(path.join(outsideDirectory, "copy.ts"), "const label = '中文';\n");
  await writeFile(outsideFile, "const label = '中文';\n");
  await symlink(outsideDirectory, path.join(fixture.sourceRoot, "linked-directory"));
  await symlink(outsideFile, path.join(fixture.sourceRoot, "linked-file.ts"));

  const result = await scanSourceTree(fixture);

  assert.deepEqual(result.symlinks, [
    "src/linked-directory",
    "src/linked-file.ts",
  ]);
  assert.deepEqual(result.hardcodedCopy, []);
});
