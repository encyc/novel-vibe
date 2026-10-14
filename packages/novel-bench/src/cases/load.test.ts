import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCaseYaml, CaseSchemaError } from "./schema.ts";
import { loadCaseLibrary } from "./load.ts";

const VALID = `
id: light/L001
title: 都市重生单章
layer: light
dimension_focus: [prose]
setup:
  - path: worldview/core.md
    type: worldview
    fixture: fixtures/core.md
script:
  - text: "请基于章卡写第 2 章正文。"
    expect:
      doc_type: chapter-text
      min_count: 1
constraints:
  min_words: 1800
rubric_weights:
  prose: 1.0
`;

describe("parseCaseYaml", () => {
  it("parses a valid case into camelCase shape", () => {
    const parsed = parseCaseYaml("light/L001", VALID);
    expect(parsed.id).toBe("light/L001");
    expect(parsed.layer).toBe("light");
    expect(parsed.dimensionFocus).toEqual(["prose"]);
    expect(parsed.setup[0]).toEqual({ path: "worldview/core.md", type: "worldview", fixture: "fixtures/core.md" });
    expect(parsed.script[0].expect).toEqual({ docType: "chapter-text", path: undefined, minCount: 1 });
    expect(parsed.constraints.minWords).toBe(1800);
    expect(parsed.rubricWeights).toEqual({ prose: 1.0 });
  });

  it("rejects bad layer", () => {
    expect(() => parseCaseYaml("x", VALID.replace("layer: light", "layer: mid"))).toThrow(CaseSchemaError);
  });

  it("rejects setup doc whose path does not match its type directory", () => {
    const bad = VALID.replace("path: worldview/core.md", "path: outline/core.md");
    expect(() => parseCaseYaml("light/L001", bad)).toThrow(/must live under worldview\//);
  });

  it("rejects chapter-text setup path not matching ch-NNN", () => {
    const bad = VALID.replace("type: worldview", "type: chapter-text").replace("path: worldview/core.md", "path: text/chapter-2.md");
    expect(() => parseCaseYaml("light/L001", bad)).toThrow(/ch-NNN|chapter-text/);
  });

  it("rejects unknown setup doc type", () => {
    const bad = VALID.replace("type: worldview", "type: spellbook");
    expect(() => parseCaseYaml("light/L001", bad)).toThrow(/unknown doc type spellbook/);
  });

  it("rejects empty script", () => {
    const bad = `${VALID}# tail`;
    expect(() => parseCaseYaml("light/L001", bad.replace(/script:[\s\S]*?constraints:/, "constraints:"))).toThrow(CaseSchemaError);
  });

  it("rejects unknown expect doc_type", () => {
    const bad = VALID.replace("doc_type: chapter-text", "doc_type: chapter");
    expect(() => parseCaseYaml("light/L001", bad)).toThrow(/unknown expect.doc_type chapter\b/);
  });

  it("reports invalid YAML with the case id", () => {
    expect(() => parseCaseYaml("light/L001", "id: [unclosed")).toThrow(/case light\/L001: invalid YAML/);
  });
});

describe("loadCaseLibrary", () => {
  it("groups cases by directory and verifies fixtures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-lib-"));
    await mkdir(join(dir, "light", "fixtures"), { recursive: true });
    await mkdir(join(dir, "heavy", "fixtures"), { recursive: true });
    await writeFile(join(dir, "light", "fixtures", "core.md"), "世界观正文");
    await writeFile(join(dir, "heavy", "fixtures", "core.md"), "世界观正文");
    await writeFile(join(dir, "light", "L001.yaml"), VALID);
    const heavyCase = VALID.replace("id: light/L001", "id: heavy/H001").replace("layer: light", "layer: heavy");
    await writeFile(join(dir, "heavy", "H001.yaml"), heavyCase);

    const lib = await loadCaseLibrary(dir);
    expect(lib.light.map((c) => c.id)).toEqual(["light/L001"]);
    expect(lib.heavy.map((c) => c.id)).toEqual(["heavy/H001"]);
  });

  it("throws naming the file when a case is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-lib-"));
    await mkdir(join(dir, "light"), { recursive: true });
    await writeFile(join(dir, "light", "bad.yaml"), "id: light/BAD\nlayer: light\n");
    await expect(loadCaseLibrary(dir)).rejects.toThrow(/case light\/bad\.yaml/);
  });

  it("throws when a fixture file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-lib-"));
    await mkdir(join(dir, "light"), { recursive: true });
    await writeFile(join(dir, "light", "L001.yaml"), VALID);
    await expect(loadCaseLibrary(dir)).rejects.toThrow(/fixture not found/);
  });

  it("tolerates missing layer directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-lib-"));
    const lib = await loadCaseLibrary(dir);
    expect(lib.light).toEqual([]);
    expect(lib.heavy).toEqual([]);
  });
});
