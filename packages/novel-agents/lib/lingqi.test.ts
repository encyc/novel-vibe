import { describe, expect, it } from "vitest";
import { parseLingqi, filterForAgent } from "./lingqi.js";

const SAMPLE = `---
version: 1
updated_at: 2026-07-07
---

# 创作指南

## 全局禁忌
不要出现真实地名
不要血腥恐怖描写

## [writer, director] 文风指南
- 短句为主
- 对话占比 ≥ 40%

## [worldbuilder, outliner] 世界观硬规则
灵气复苏体系，严禁修真飞升

## [chief_editor] 商业线
每 5 章一个付费卡点`;

describe("parseLingqi", () => {
  it("strips frontmatter and splits into heading-delimited sections", () => {
    const { frontmatter, sections } = parseLingqi(SAMPLE);
    expect(frontmatter).toEqual({ version: 1, updated_at: "2026-07-07" });
    expect(sections.map((s) => s.heading)).toEqual([
      "全局禁忌",
      "[writer, director] 文风指南",
      "[worldbuilder, outliner] 世界观硬规则",
      "[chief_editor] 商业线",
    ]);
  });

  it("marks untagged headings as visible to all (roles === null)", () => {
    const { sections } = parseLingqi(SAMPLE);
    expect(sections[0].roles).toBeNull();
    expect(sections[0].body).toContain("不要出现真实地名");
  });

  it("parses a comma-separated role list", () => {
    const { sections } = parseLingqi(SAMPLE);
    expect(sections[1].roles).toEqual(["writer", "director"]);
    expect(sections[2].roles).toEqual(["worldbuilder", "outliner"]);
    expect(sections[3].roles).toEqual(["chief_editor"]);
  });

  it("treats [all] as visible to every agent (roles === null)", () => {
    const { sections } = parseLingqi("## [all] 备注\n所有人可见");
    expect(sections[0].roles).toBeNull();
  });

  it("tolerates spaces and mixed case in role tags", () => {
    const { sections } = parseLingqi("## [Writer, Chief_Editor] x\nbody");
    expect(sections[0].roles).toEqual(["writer", "chief_editor"]);
  });

  it("drops unknown roles from the parsed list", () => {
    const { sections } = parseLingqi("## [writer, robot] x\nbody");
    expect(sections[0].roles).toEqual(["writer"]);
  });

  it("returns no sections for an empty file", () => {
    expect(parseLingqi("").sections).toEqual([]);
    expect(parseLingqi("---\nversion: 1\n---\n").sections).toEqual([]);
  });

  it("returns no sections when only a frontmatter block is present", () => {
    const { frontmatter, sections } = parseLingqi("---\nversion: 2\n---");
    expect(frontmatter).toEqual({ version: 2 });
    expect(sections).toEqual([]);
  });

  it("treats a document-level # H1 as a title and does not open a section for it", () => {
    // Regression: previously the H1 became an empty all-agent section at
    // index 0, shifting every real section by one.
    const { sections } = parseLingqi("# 创作指南\n\n## 全局禁忌\nbody");
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("全局禁忌");
  });
});

describe("filterForAgent", () => {
  it("returns only all-sections plus the agent's own sections", () => {
    const parsed = parseLingqi(SAMPLE);
    const writerView = filterForAgent(parsed, "writer");
    expect(writerView).toContain("全局禁忌");
    expect(writerView).toContain("文风指南");
    expect(writerView).not.toContain("世界观硬规则");
    expect(writerView).not.toContain("商业线");
  });

  it("chief_editor sees all-sections plus its own, not others'", () => {
    const parsed = parseLingqi(SAMPLE);
    const chiefView = filterForAgent(parsed, "chief_editor");
    expect(chiefView).toContain("全局禁忌");
    expect(chiefView).toContain("商业线");
    expect(chiefView).not.toContain("文风指南");
    expect(chiefView).not.toContain("世界观硬规则");
  });

  it("director shares a section tagged with it", () => {
    const parsed = parseLingqi(SAMPLE);
    const directorView = filterForAgent(parsed, "director");
    expect(directorView).toContain("文风指南");
    expect(directorView).not.toContain("世界观硬规则");
  });

  it("returns '' when no section applies", () => {
    const parsed = parseLingqi("## [writer] only\nbody");
    expect(filterForAgent(parsed, "outliner")).toBe("");
  });

  it("returns '' for an empty guide", () => {
    expect(filterForAgent(parseLingqi(""), "chief_editor")).toBe("");
  });
});
