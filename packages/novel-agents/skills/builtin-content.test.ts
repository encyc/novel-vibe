import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateSkill } from "./policy.js";

const skill = readFileSync(
  new URL("../builtin/zhihu-yanxuan-polish/SKILL.md", import.meta.url),
  "utf8",
);

describe("zhihu-yanxuan-polish built-in skill", () => {
  it("remains a valid single-file skill for its assigned roles", () => {
    const result = validateSkill({
      filename: "SKILL.md",
      slug: "zhihu-yanxuan-polish",
      content: skill,
      roles: ["chief_editor", "outliner", "director", "writer"],
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("states the evidence boundary and retention model", () => {
    for (const term of ["截断样本", "体验承诺", "信息差", "阶段兑现", "认知升级", "未闭合问题"]) {
      expect(skill).toContain(term);
    }
  });

  it("preserves distinct genre mechanisms", () => {
    for (const term of ["悬疑嵌套", "青春甜文", "沙雕脑洞", "现实爽文", "明线", "重复意象", "角色口癖", "边界重建"]) {
      expect(skill).toContain(term);
    }
  });

  it("does not present unsupported numeric heuristics as hard rules", () => {
    expect(skill).not.toMatch(/每\s*1000\s*字至少一个/);
    expect(skill).not.toMatch(/单句尽量\s*[≤<]/);
    expect(skill).not.toMatch(/段落\s*[≤<]/);
    expect(skill).not.toMatch(/黄金卡点：故事总长度的\s*1\/3\s*[~～至到-]+\s*1\/2/);
  });

  it("forbids precise pacing numbers when only partial material is available", () => {
    expect(skill).toContain("仅有梗概、片段或截断文本时");
    expect(skill).toContain("不要给出百分比、固定字数、章节数或反转频率");
    expect(skill).toContain("即使声明‘仅供参考’也不例外");
  });
});
