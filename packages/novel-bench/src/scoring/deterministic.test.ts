import { describe, expect, it } from "vitest";
import { countWords } from "../../../novel-agents/lib/frontmatter.ts";
import { scoreContinuity, scoreDesign, scoreProse } from "./deterministic.ts";
import type { CollectedDoc } from "../types.ts";

/**
 * Bodies built from digit-dense unique sentences (a serial number every few
 * characters), so no 16-char window repeats 3+ times and the lint repetition
 * rule stays quiet.
 */
function longBody(sentences = 40): string {
  const parts: string[] = [];
  for (let i = 0; i < sentences; i++) {
    parts.push(`雨点第${i}次砸在他${i}号窗上，他数到第${i}声雷才动身${i}。`);
  }
  return parts.join("");
}

function chapterDoc(body: string, path = "text/ch-001.md", chapter = 1): CollectedDoc {
  const content = [
    "---",
    "type: chapter-text",
    `chapter: ${chapter}`,
    "volume: 1",
    "pov: 林奇",
    "status: confirmed",
    `word_count: ${countWords(body)}`,
    "characters_present: [林奇, 陈姨]",
    'style_tags: [冷峻, 都市]',
    "---",
    "",
    body,
  ].join("\n");
  return { path, type: "chapter-text", content, wordCount: countWords(body) };
}

function foreshadow(id: string, status: string, actualResolve: number | null): CollectedDoc {
  return {
    path: `foreshadowing/${id}.md`,
    type: "foreshadow",
    content: `---
type: foreshadow
id: ${id}
description: 测试伏笔
importance: 5
plant_chapter: 1
planned_resolve: 3
actual_resolve: ${actualResolve === null ? "null" : actualResolve}
status: ${status}
---
正文`,
    wordCount: 10,
  };
}

describe("scoreProse", () => {
  it("returns null with no chapter docs", () => {
    expect(scoreProse([], {}).score).toBeNull();
  });

  it("scores a clean chapter 10 and reports metrics", () => {
    const doc = chapterDoc(longBody());
    const res = scoreProse([doc], { minWords: 900 });
    expect(res.findings).toEqual([]);
    expect(res.score).toBe(10);
    expect(res.metrics.words_min).toBe(960);
  });

  it("caps the score when the word floor is missed", () => {
    const doc = chapterDoc("雨停了，他出发。", "text/ch-002.md", 2);
    doc.wordCount = 120;
    const res = scoreProse([doc], { minWords: 1800 });
    expect(res.score).toBe(4);
    expect(res.findings.some((f) => f.check === "words.min")).toBe(true);
  });
});

describe("scoreDesign", () => {
  const CARD = `---
type: chapter-card
chapter: 1
volume: 1
arc: 1
title: 第一章
pov: 林奇
status: draft
characters: [林奇]
world_elements: []
foreshadow_plant: []
foreshadow_resolve: []
emotion_curve: 平→惊
---
目标：拿回玉佩。`;

  it("returns null with no docs", () => {
    expect(scoreDesign([], {}).score).toBeNull();
  });

  it("full score with valid card and required types", () => {
    const docs: CollectedDoc[] = [
      { path: "outline/ch-001.md", type: "chapter-card", content: CARD, wordCount: 60 },
    ];
    const res = scoreDesign(docs, { requiredDocTypes: ["chapter-card"], chapterNums: [1] });
    expect(res.score).toBe(10);
  });

  it("penalizes missing types and chapters", () => {
    const docs: CollectedDoc[] = [
      { path: "worldview/core.md", type: "worldview", content: "---\ntype: worldview\ntitle: w\n---\n设定", wordCount: 10 },
    ];
    const res = scoreDesign(docs, { requiredDocTypes: ["worldview", "chapter-card"], chapterNums: [1, 2] });
    expect(res.score).toBe(1); // 10 -3 missing card -3 ch1 -3 ch2
    expect(res.findings).toHaveLength(3);
  });

  it("penalizes invalid card schema", () => {
    const badCard = CARD.replace("pov: 林奇\n", ""); // pov required
    const docs: CollectedDoc[] = [
      { path: "outline/ch-001.md", type: "chapter-card", content: badCard, wordCount: 60 },
    ];
    const res = scoreDesign(docs, { chapterNums: [1] });
    expect(res.score).toBe(8);
    expect(res.findings.some((f) => f.check === "design.card_schema")).toBe(true);
  });
});

describe("scoreContinuity", () => {
  it("returns null when there is no long-range input at all", () => {
    expect(scoreContinuity([{ path: "worldview/w.md", type: "worldview", content: "x", wordCount: 1 }], {}).score).toBeNull();
  });

  it("computes recovery rate against the seeded list", () => {
    const docs = [
      foreshadow("fs-001", "resolved", 3),
      foreshadow("fs-002", "planted", null),
    ];
    const res = scoreContinuity(docs, { foreshadowIds: ["fs-001", "fs-002", "fs-003"] });
    expect(res.score).toBeCloseTo(10 / 3, 5);
    expect(res.metrics).toEqual({ foreshadow_expected: 3, foreshadow_resolved: 1 });
    expect(res.findings.some((f) => f.message.includes("fs-003"))).toBe(true);
  });

  it("flags missing summary for multi-chapter output without a seeded list", () => {
    const doc = chapterDoc("他数到七就动身，雨还没有停。", "text/ch-009.md", 9);
    const res = scoreContinuity([doc], {});
    expect(res.score).toBeNull();
    expect(res.findings.some((f) => f.check === "continuity.summary_missing")).toBe(true);
  });
});
