import { describe, expect, it } from "vitest";
import { splitFrontmatter } from "./frontmatter";

describe("splitFrontmatter", () => {
  it("splits a flat frontmatter block from the body", () => {
    const split = splitFrontmatter("---\ntype: character\nname: 陆尘\n---\n\n# 陆尘\n\n正文。");
    expect(split).not.toBeNull();
    expect(split!.yaml).toBe("type: character\nname: 陆尘");
    expect(split!.body).toBe("# 陆尘\n\n正文。");
  });

  it("keeps nested list lines in the raw yaml", () => {
    const split = splitFrontmatter("---\nabilities:\n  - 青玄剑诀\n  - 本命飞剑：青霜\n---\n正文");
    expect(split!.yaml).toBe("abilities:\n  - 青玄剑诀\n  - 本命飞剑：青霜");
    expect(split!.body).toBe("正文");
  });

  it("returns null for content without frontmatter", () => {
    expect(splitFrontmatter("# 普通文档\n\n没有元数据。")).toBeNull();
    expect(splitFrontmatter("")).toBeNull();
  });

  it("returns null when the opening marker is never closed", () => {
    expect(splitFrontmatter("---\ntype: character\n\n正文")).toBeNull();
  });

  it("closes at the first marker after the opening one", () => {
    const split = splitFrontmatter("---\ntype: character\n\n---\n正文");
    expect(split!.yaml).toBe("type: character");
    expect(split!.body).toBe("正文");
  });
});
