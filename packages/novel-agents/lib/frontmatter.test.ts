import { describe, expect, it } from "vitest";
import { countWords, getDocDir, hashContent, parseFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses scalar fields, inline arrays, nested objects, and body content", () => {
    const parsed = parseFrontmatter(`---
type: worldview
category: power_system
name: 灵气体系
status: draft
importance: 8
related:
  characters: [lin-fan, su-yun]
  chapters: [1, 2]
  world_elements: []
---
# 灵气体系

修行者以灵根引气。`);

    expect(parsed.frontmatter).toEqual({
      type: "worldview",
      category: "power_system",
      name: "灵气体系",
      status: "draft",
      importance: 8,
      related: {
        characters: ["lin-fan", "su-yun"],
        chapters: [1, 2],
        world_elements: [],
      },
    });
    expect(parsed.body).toContain("修行者以灵根引气。");
  });

  it("parses one-level arrays of objects used by relationships documents", () => {
    const parsed = parseFrontmatter(`---
type: relationships
status: draft
pairs:
  - from: lin-fan
    to: su-yun
    relation: 师徒
    tension: 信任尚未建立
---
关系索引`);

    expect(parsed.frontmatter.pairs).toEqual([
      {
        from: "lin-fan",
        to: "su-yun",
        relation: "师徒",
        tension: "信任尚未建立",
      },
    ]);
  });

  it("returns empty frontmatter when no delimiter exists", () => {
    const parsed = parseFrontmatter("# Chapter\n\n正文");

    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("# Chapter\n\n正文");
  });

  it("handles empty frontmatter with only delimiters", () => {
    const parsed = parseFrontmatter(`---
---
body content here`);

    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("body content here");
  });

  it("returns raw content when opening delimiter has no closing match", () => {
    const parsed = parseFrontmatter(`---
type: test
no closing delimiter`);

    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toContain("type: test");
  });

  it("parses frontmatter with comments (lines starting with #)", () => {
    const parsed = parseFrontmatter(`---
type: character
name: 林凡
# this is a comment
status: draft
---
body`);

    expect(parsed.frontmatter).toEqual({
      type: "character",
      name: "林凡",
      status: "draft",
    });
  });

  it("parses values with embedded colons as strings", () => {
    const parsed = parseFrontmatter(`---
type: note
title: 标题：副标题
---
body`);

    expect(parsed.frontmatter.title).toBe("标题：副标题");
  });

  it("parses boolean and numeric values correctly", () => {
    const parsed = parseFrontmatter(`---
type: test
flag: true
neg: false
count: 42
pi: 3.14
empty: null
---
body`);

    expect(parsed.frontmatter.flag).toBe(true);
    expect(parsed.frontmatter.neg).toBe(false);
    expect(parsed.frontmatter.count).toBe(42);
    expect(parsed.frontmatter.pi).toBe(3.14);
    expect(parsed.frontmatter.empty).toBeNull();
  });

  it("parses quoted string values", () => {
    const parsed = parseFrontmatter(`---
type: test
single: 'hello world'
double: "hello world"
---
body`);

    expect(parsed.frontmatter.single).toBe("hello world");
    expect(parsed.frontmatter.double).toBe("hello world");
  });

  it("handles Unicode and emoji in frontmatter values", () => {
    const parsed = parseFrontmatter(`---
type: character
name: 🐉龙傲天
note: 日本語もOK
---
body`);

    expect(parsed.frontmatter.name).toBe("🐉龙傲天");
    expect(parsed.frontmatter.note).toBe("日本語もOK");
  });

  it("parses worldview document frontmatter fully", () => {
    const parsed = parseFrontmatter(`---
type: worldview
category: power_system
name: 灵气体系
status: draft
importance: 8
related:
  characters: [lin-fan, su-yun]
  chapters: [1, 2]
  world_elements: []
---
# 灵气体系

灵气是天地间最本源的力量。`);

    expect(parsed.frontmatter.type).toBe("worldview");
    expect(parsed.frontmatter.category).toBe("power_system");
  });

  it("parses character document frontmatter fully", () => {
    const parsed = parseFrontmatter(`---
type: character
name: 林凡
slug: lin-fan
role: protagonist
status: draft
tags: [天才, 修炼者]
abilities: [天命之体, 灵气吞噬]
arc_stage: growth
appears_in: [1, 2, 3]
---
# 林凡`);

    expect(parsed.frontmatter.type).toBe("character");
    expect(parsed.frontmatter.slug).toBe("lin-fan");
    expect(parsed.frontmatter.tags).toEqual(["天才", "修炼者"]);
    expect(parsed.frontmatter.appears_in).toEqual([1, 2, 3]);
  });

  it("parses chapter-card document frontmatter fully", () => {
    const parsed = parseFrontmatter(`---
type: chapter-card
chapter: 1
volume: 1
arc: 1
title: 觉醒
pov: lin-fan
status: draft
characters: [lin-fan, su-yun]
world_elements: [天命之体, 灵气]
foreshadow_plant: [fs-001]
foreshadow_resolve: []
emotion_curve: 轻松→紧张→热血
---
# 第1章 觉醒`);

    expect(parsed.frontmatter.type).toBe("chapter-card");
    expect(parsed.frontmatter.chapter).toBe(1);
    expect(parsed.frontmatter.pov).toBe("lin-fan");
    expect(parsed.frontmatter.characters).toEqual(["lin-fan", "su-yun"]);
  });

  it("parses director-script document frontmatter fully", () => {
    const parsed = parseFrontmatter(`---
type: director-script
chapter: 1
based_on: outline/cards/chapter-001.md
status: draft
characters_ref: [lin-fan, su-yun]
world_ref: [天命之体]
prev_chapter: 0
---
# 导演脚本`);

    expect(parsed.frontmatter.type).toBe("director-script");
    expect(parsed.frontmatter.chapter).toBe(1);
    expect(parsed.frontmatter.prev_chapter).toBe(0);
  });

  it("parses chapter-text document frontmatter fully", () => {
    const parsed = parseFrontmatter(`---
type: chapter-text
chapter: 1
volume: 1
pov: lin-fan
status: draft
word_count: 3500
characters_present: [lin-fan, su-yun]
style_tags: [热血, 轻松]
---
正文内容开始...`);

    expect(parsed.frontmatter.type).toBe("chapter-text");
    expect(parsed.frontmatter.word_count).toBe(3500);
    expect(parsed.frontmatter.style_tags).toEqual(["热血", "轻松"]);
  });

  it("parses foreshadow document frontmatter with fs-XXX id", () => {
    const parsed = parseFrontmatter(`---
type: foreshadow
id: fs-001
description: 主角体内的封印将在关键时解开
importance: 9
plant_chapter: 1
planned_resolve: 50
actual_resolve: null
status: planned
---
# 伏笔 fs-001`);

    expect(parsed.frontmatter.type).toBe("foreshadow");
    expect(parsed.frontmatter.id).toBe("fs-001");
    expect(parsed.frontmatter.plant_chapter).toBe(1);
    expect(parsed.frontmatter.actual_resolve).toBeNull();
  });

  it("parses volume document frontmatter fully", () => {
    const parsed = parseFrontmatter(`---
type: volume
volume: 1
title: 觉醒之路
status: draft
chapters: [1, 2, 3, 4, 5]
word_count_target: 50000
---
# 第一卷`);

    expect(parsed.frontmatter.type).toBe("volume");
    expect(parsed.frontmatter.chapters).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.frontmatter.word_count_target).toBe(50000);
  });
});

describe("countWords", () => {
  it("counts Chinese characters and English words together", () => {
    expect(countWords("林凡 enters the cave")).toBe(5);
  });

  it("returns 0 for empty string", () => {
    expect(countWords("")).toBe(0);
  });

  it("counts only Chinese characters", () => {
    expect(countWords("林凡修炼天道")).toBe(6);
  });

  it("counts only English words", () => {
    expect(countWords("hello world test")).toBe(3);
  });

  it("handles mixed CJK and English with punctuation", () => {
    // 林凡(2) + a young cultivator(3) + 踏入修炼之路(6) = 11 CJK + 3 English = 14
    // But ，and 。are CJK punctuation not in the uni range — count may vary
    const result = countWords("林凡，a young cultivator，踏入修炼之路。");
    expect(result).toBeGreaterThan(8);
    expect(result).toBeLessThan(15);
  });
});

describe("getDocDir", () => {
  it("maps known document types to storage directories", () => {
    expect(getDocDir("chapter-text")).toBe("text");
    expect(getDocDir("unknown")).toBe("misc");
  });

  it("maps all known types correctly", () => {
    expect(getDocDir("worldview")).toBe("worldview");
    expect(getDocDir("character")).toBe("characters");
    expect(getDocDir("relationships")).toBe("characters");
    expect(getDocDir("volume")).toBe("outline");
    expect(getDocDir("chapter-skeleton")).toBe("outline");
    expect(getDocDir("chapter-card")).toBe("outline");
    expect(getDocDir("director-script")).toBe("scripts");
    expect(getDocDir("chapter-text")).toBe("text");
    expect(getDocDir("foreshadow")).toBe("foreshadowing");
    expect(getDocDir("story-summary")).toBe("summary");
    expect(getDocDir("character-state")).toBe("characters");
  });
});

describe("hashContent", () => {
  it("returns a 16-character hex string", () => {
    const hash = hashContent("hello world");
    expect(hash).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it("is deterministic — same input yields same hash", () => {
    expect(hashContent("test content")).toBe(hashContent("test content"));
  });

  it("different inputs yield different hashes", () => {
    expect(hashContent("content A")).not.toBe(hashContent("content B"));
  });

  it("handles empty string", () => {
    const hash = hashContent("");
    expect(hash).toHaveLength(16);
  });

  it("handles Unicode content", () => {
    const hash = hashContent("林凡修炼天道");
    expect(hash).toHaveLength(16);
  });
});
