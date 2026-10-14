import { describe, expect, it } from "vitest";
import { loadCaseLibrary } from "./load.ts";
import { parseCaseYaml } from "./schema.ts";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const LIB_DIR = new URL("../../cases", import.meta.url).pathname;

describe("真实案例库", () => {
  it("全部案例可解析且 fixture 齐全", async () => {
    const lib = await loadCaseLibrary(LIB_DIR);
    expect(lib.light.length).toBeGreaterThanOrEqual(6);
    expect(lib.heavy.length).toBeGreaterThanOrEqual(1);
  });

  it("正文案例至少 1800 字下限，章纲案例覆盖前三章", async () => {
    const lib = await loadCaseLibrary(LIB_DIR);
    const byId = new Map([...lib.light, ...lib.heavy].map((c) => [c.id, c]));
    expect(byId.get("light/L001")?.constraints.minWords).toBe(1800);
    expect(byId.get("light/L004")?.constraints.chapterNums).toEqual([1, 2, 3]);
    const heavy = byId.get("heavy/H001");
    expect(heavy?.constraints.foreshadowIds).toEqual(["fs-001", "fs-002", "fs-003"]);
    expect(heavy?.script).toHaveLength(8);
  });

  it("每个 YAML 都有对应测试过的 frontmatter 约定（正文 fixture 过 prose-lint 的 frontmatter 检查）", async () => {
    const { runProseLint } = await import("../../../novel-agents/lint/index.ts");
    const fixturesDir = join(LIB_DIR, "light", "fixtures");
    const chapters = (await readdir(fixturesDir)).filter((n) => n.endsWith("ch-001.md"));
    expect(chapters.length).toBeGreaterThanOrEqual(3);
    for (const name of chapters) {
      const content = await readFile(join(fixturesDir, name), "utf8");
      const report = runProseLint(name, content);
      const schemaErrors = report.findings.filter((f) => f.rule === "frontmatter.schema");
      expect(schemaErrors, `${name}: ${JSON.stringify(report.findings)}`).toEqual([]);
    }
  });

  it("案例 id 与文件名一致", async () => {
    const files = (await readdir(join(LIB_DIR, "light"))).filter((n) => n.endsWith(".yaml"));
    for (const file of files) {
      const parsed = parseCaseYaml(`light/${file}`, await readFile(join(LIB_DIR, "light", file), "utf8"));
      expect(parsed.id).toBe(`light/${file.replace(/\.yaml$/, "")}`);
    }
  });
});
