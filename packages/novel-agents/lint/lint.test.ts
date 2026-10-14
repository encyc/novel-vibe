import { describe, expect, it } from "vitest";
import { countWords } from "../lib/frontmatter.js";
import { formatLintReport, runProseLint } from "./index.js";
import { findRepeatedPassages } from "./rules/prose.js";

function chapterTextDoc(opts?: {
  body?: string;
  overrides?: Record<string, unknown>;
}): string {
  const body = opts?.body ?? defaultChapterBody();
  const fm: Record<string, unknown> = {
    type: "chapter-text",
    chapter: 3,
    volume: 1,
    pov: "lin-fan",
    status: "draft",
    word_count: countWords(body),
    characters_present: ["lin-fan"],
    style_tags: ["热血"],
    ...opts?.overrides,
  };
  const lines = Object.entries(fm)
    .map(([k, v]) => (Array.isArray(v) ? `${k}: [${v.join(", ")}]` : `${k}: ${v}`));
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

/** Unique beats joined twice: any seed occurs at most 2 (< minOccurrences 3), so
 *  the body stays clean while still exercising length/schema rules. */
function defaultChapterBody(): string {
  const notes = [
    "他把水囊灌满，在溪边的石头上磨了磨刀。",
    "山雨说下就下，他躲进一处废弃的山神庙过夜。",
    "清晨出发时，雾气还没有散尽。",
    "路上遇到一队返程的货郎，换了两张进山的官凭。",
    "崖边的栈道断了一截，只能贴着湿滑的石壁爬过去。",
    "傍晚宿营时，他把火堆压得很低，不让光透出林子。",
    "第二天天没亮就动身，赶在大风前翻过了山脊。",
    "谷底立着一块界碑，字迹早被风雨磨平了。",
  ];
  return notes.join("") + notes.join("");
}

describe("runProseLint", () => {
  it("passes a well-formed chapter without findings", () => {
    const report = runProseLint("text/ch-003.md", chapterTextDoc());
    expect(report.docType).toBe("chapter-text");
    expect(report.findings).toEqual([]);
  });

  it("reports a missing frontmatter type", () => {
    const content = "---\nstatus: draft\n---\n\n正文内容。\n";
    const report = runProseLint("misc/x.md", content);
    expect(report.docType).toBeNull();
    expect(report.findings.map((f) => f.rule)).toEqual(["frontmatter.missing_type"]);
  });

  it("reports an unsupported document type", () => {
    const content = "---\ntype: poetry\nstatus: draft\n---\n\n诗句。\n";
    const rules = runProseLint("poetry/a.md", content).findings.map((f) => f.rule);
    expect(rules).toContain("frontmatter.unknown_type");
  });

  it("reports schema violations without throwing", () => {
    const content = chapterTextDoc({ overrides: { status: "published" } });
    const report = runProseLint("text/ch-003.md", content);
    const schema = report.findings.find((f) => f.rule === "frontmatter.schema");
    expect(schema?.severity).toBe("error");
    expect(schema?.message).toContain("status");
  });

  it("flags an over-limit story summary as an error", () => {
    const content = [
      "---",
      "type: story-summary",
      "status: confirmed",
      "latest_chapter: 5",
      "updated_at: \"2026-08-27T00:00:00Z\"",
      "word_count: 1",
      "---",
      "",
      "山".repeat(2600),
    ].join("\n");
    const rules = runProseLint("summary/story-so-far.md", content)
      .findings.map((f) => f.rule);
    expect(rules).toContain("word.summary_limit");
  });

  it("flags truncated chapters and dishonest word counts", () => {
    const content = chapterTextDoc({
      body: "他转身离开了。",
      overrides: { word_count: 1200 },
    });
    const rules = runProseLint("text/ch-003.md", content).findings.map((f) => f.rule);
    expect(rules).toContain("word.too_short");
    expect(rules).toContain("word.reported_mismatch");
  });

  it("keeps chapter meta checks scoped to chapter-text", () => {
    const content = [
      "---",
      "type: character-state",
      "character: lin-fan",
      "status: draft",
      "latest_chapter: 3",
      "---",
      "",
      "状态记录。",
    ].join("\n");
    const report = runProseLint("characters/lin-fan-state.md", content);
    expect(report.findings).toEqual([]);
  });

  it("warns when pov is absent from characters_present", () => {
    const content = chapterTextDoc({
      overrides: { characters_present: ["su-qing"], style_tags: [] },
    });
    const rules = runProseLint("text/ch-003.md", content).findings.map((f) => f.rule);
    expect(rules).toContain("chapter.pov_not_listed");
    expect(rules).toContain("chapter.style_tags_empty");
  });

  it("counts cliché phrase hits with multiplicity", () => {
    const filler = defaultChapterBody();
    const body = `${filler}\n空气仿佛凝固了。片刻之后，空气仿佛凝固得更彻底了。${filler}`;
    const content = chapterTextDoc({ body });
    const finding = runProseLint("text/ch-003.md", content).findings
      .find((f) => f.rule === "prose.banned_phrase");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("×2");
  });

  it("flags the added abstract-emotion clichés", () => {
    const filler = defaultChapterBody();
    const content = chapterTextDoc({ body: `${filler}\n他望着她的背影，心中五味杂陈。${filler}` });
    const finding = runProseLint("text/ch-003.md", content).findings
      .find((f) => f.rule === "prose.banned_phrase");
    expect(finding?.message).toContain("五味杂陈");
  });

  it("flags a chapter ending on a summary beat", () => {
    const filler = defaultChapterBody();
    const content = chapterTextDoc({ body: `${filler}\n总之，这一天的一切，都和从前不一样了。` });
    const finding = runProseLint("text/ch-003.md", content).findings
      .find((f) => f.rule === "prose.ending_summary");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("总之");
  });

  it("accepts a chapter ending on action or dialogue", () => {
    const filler = defaultChapterBody();
    const dialogueEnd = chapterTextDoc({ body: `${filler}\n「钥匙在我这儿。」他把锁扣回腰间，「想开门，先来找我。」` });
    expect(runProseLint("text/ch-003.md", dialogueEnd).findings
      .some((f) => f.rule === "prose.ending_summary")).toBe(false);
  });

  it("does not apply the ending rule to story summaries", () => {
    const content = "---\ntype: story-summary\nstatus: draft\nlatest_chapter: 3\nupdated_at: 2026-09-03T00:00:00Z\nword_count: 10\n---\n\n总之，主角抵达了北门。\n";
    const rules = runProseLint("summary/story-so-far.md", content).findings.map((f) => f.rule);
    expect(rules).not.toContain("prose.ending_summary");
  });

  it("detects long duplicated passages", () => {
    const refrain = "夜风掠过屋檐吹动檐角的铜铃发出断续的轻响";
    const body = Array.from({ length: 60 }, (_, i) =>
      `第${i}段行程里两人一前一后沉默地走着。${refrain}。`)
      .join("");
    const content = chapterTextDoc({ body });
    const finding = runProseLint("text/ch-003.md", content).findings
      .find((f) => f.rule === "prose.repetition");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain(refrain.slice(0, 10));
  });

  it("sorts errors before warnings", () => {
    const content = chapterTextDoc({ overrides: { status: "published", style_tags: [] } });
    const severities = runProseLint("text/ch-003.md", content)
      .findings.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => (a === b ? 0 : a === "error" ? -1 : 1)));
  });
});

describe("formatLintReport", () => {
  it("renders an OK line when there are no findings", () => {
    const report = runProseLint("text/ch-003.md", chapterTextDoc());
    expect(formatLintReport(report)).toContain("Lint OK");
  });

  it("includes severity tags and hints", () => {
    const content = chapterTextDoc({
      body: "他转身离开了。",
      overrides: { characters_present: [] },
    });
    const text = formatLintReport(runProseLint("text/ch-003.md", content));
    expect(text).toContain("[warning]");
    expect(text).toContain("建议：");
  });
});

describe("findRepeatedPassages", () => {
  it("ignores markdown separators without CJK characters", () => {
    const body = `${"- ".repeat(40)}\n`.repeat(4);
    expect(findRepeatedPassages(body)).toEqual([]);
  });

  it("collapses nested repeats into their longest form", () => {
    const unit = "铜铃声在空旷的山谷里来回激荡久久不肯散去";
    const text = (unit + "。").repeat(5);
    const passages = findRepeatedPassages(text);
    expect(passages).toHaveLength(1);
    expect(passages[0].snippet.length).toBeGreaterThan(unit.length);
  });
});
