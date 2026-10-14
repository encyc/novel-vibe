import { describe, expect, it } from "vitest";
import { countWords } from "../../../novel-agents/lib/frontmatter.ts";
import { aggregateCase } from "./aggregate.ts";
import type { BenchCase, CollectedDoc, JudgeResult } from "../types.ts";

function chapterDoc(): CollectedDoc {
  const body = Array.from({ length: 40 }, (_, i) => `雨点第${i}次砸在他${i}号窗上，他数到第${i}声雷才动身${i}。`).join("");
  const content = [
    "---",
    "type: chapter-text",
    "chapter: 1",
    "volume: 1",
    "pov: 林奇",
    "status: confirmed",
    `word_count: ${countWords(body)}`,
    "characters_present: [林奇]",
    "style_tags: [冷峻]",
    "---",
    "",
    body,
  ].join("\n");
  return { path: "text/ch-001.md", type: "chapter-text", content, wordCount: countWords(body) };
}

const CASE: BenchCase = {
  id: "light/L000",
  title: "测试",
  layer: "light",
  dimensionFocus: ["prose"],
  setup: [],
  script: [{ text: "写" }],
  constraints: { minWords: 100 },
  rubricWeights: { prose: 0.6, design: 0.4 },
};

function judge(rubric: string, ok: boolean, scores: number[]): JudgeResult {
  return {
    rubric,
    rubricVersion: 1,
    ok,
    items: scores.map((score, i) => ({ criterion: `c${i}`, score, evidence: "e" })),
  };
}

describe("aggregateCase", () => {
  it("mixes deterministic and judge scores 50/50 per dimension", () => {
    const { dimensions, overall } = aggregateCase(
      [chapterDoc()],
      CASE,
      {
        prose: [judge("prose_flavor", true, [8]), judge("prose_structure", true, [6])],
        design: [],
        continuity: [],
      },
    );
    const prose = dimensions.find((d) => d.dimension === "prose");
    // judge mean = 7; deterministic = 10 (clean lint, words ok) → mix = 8.5
    expect(prose?.score).toBeCloseTo(8.5, 5);
    expect(dimensions.find((d) => d.dimension === "design")?.score).toBeNull();
    // weights prose .6 + design .4, design null → renormalize to prose only
    expect(overall).toBeCloseTo(8.5, 5);
  });

  it("uses explicit weights across available dimensions", () => {
    const docs = [
      chapterDoc(),
      {
        path: "outline/ch-001.md",
        type: "chapter-card",
        content:
          "---\ntype: chapter-card\nchapter: 1\nvolume: 1\narc: 1\ntitle: 第一章\npov: 林奇\nstatus: draft\ncharacters: []\nworld_elements: []\nforeshadow_plant: []\nforeshadow_resolve: []\nemotion_curve: 平→惊\n---\n目标：拿回玉佩。",
        wordCount: 60,
      },
    ];
    const { overall, dimensions } = aggregateCase(docs, CASE, {
      prose: [judge("prose_flavor", true, [10])],
      design: [],
      continuity: [],
    });
    const prose = dimensions.find((d) => d.dimension === "prose");
    const design = dimensions.find((d) => d.dimension === "design");
    expect(prose?.score).toBeCloseTo(10, 5); // det 10, judge 10
    expect(design?.score).not.toBeNull(); // card valid, chapter present → 10
    expect(overall).toBeCloseTo(10, 5);
  });

  it("falls back to judge-only when deterministic is null", () => {
    const { dimensions } = aggregateCase([], CASE, {
      prose: [judge("prose_flavor", true, [4])],
      design: [],
      continuity: [],
    });
    // no chapter-text docs → deterministic null → prose uses judge mean
    expect(dimensions.find((d) => d.dimension === "prose")?.score).toBe(4);
  });

  it("returns null overall when every dimension is null", () => {
    const { overall } = aggregateCase([], CASE, { prose: [], design: [], continuity: [] });
    expect(overall).toBeNull();
  });

  it("ignores failed judges", () => {
    const { dimensions } = aggregateCase([chapterDoc()], CASE, {
      prose: [judge("prose_flavor", false, [], ), judge("prose_structure", true, [7])],
      design: [],
      continuity: [],
    });
    const prose = dimensions.find((d) => d.dimension === "prose");
    // only the ok judge counts: (10 det + 7 judge)/2
    expect(prose?.score).toBeCloseTo(8.5, 5);
  });

  it("excludes seeded setup docs from prose/design scoring but keeps continuity", () => {
    const seededChapter = { ...chapterDoc(), path: "text/ch-001.md", wordCount: 100 };
    const generated = { ...chapterDoc(), path: "text/ch-002.md" };
    const seededForeshadow = {
      path: "foreshadowing/fs-001.md",
      type: "foreshadow",
      content: "---\ntype: foreshadow\nid: fs-001\ndescription: d\nimportance: 5\nplant_chapter: 1\nplanned_resolve: 2\nactual_resolve: 2\nstatus: resolved\n---\nx",
      wordCount: 1,
    };
    const caseWithSetup: BenchCase = {
      ...CASE,
      setup: [{ path: "text/ch-001.md", type: "chapter-text", fixture: "x.md" }],
      constraints: { minWords: 100, foreshadowIds: ["fs-001"] },
      rubricWeights: {},
    };
    const { dimensions } = aggregateCase([seededChapter, generated, seededForeshadow], caseWithSetup, {
      prose: [],
      design: [],
      continuity: [],
    });
    const prose = dimensions.find((d) => d.dimension === "prose");
    // seeded short chapter must not trip the word floor: only ch-002 scores → 10
    expect(prose?.deterministic?.score).toBe(10);
    expect(prose?.deterministic?.findings.some((f) => f.check === "words.min")).toBe(false);
    // continuity still observes the seeded foreshadow update → resolved → 10
    const continuity = dimensions.find((d) => d.dimension === "continuity");
    expect(continuity?.deterministic?.score).toBe(10);
  });
});
