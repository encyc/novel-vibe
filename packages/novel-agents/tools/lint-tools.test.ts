import { describe, expect, it, vi } from "vitest";
import { countWords } from "../lib/frontmatter.js";
import { createLintDocTool, createNotesHealthTool } from "./lint-tools.js";
import type { ToolContext } from "./file-tools.js";

const sampleBody = "雨点砸在屋檐上，他握着刀柄站在门口，没有动。";

const sampleChapter = [
  "---",
  "type: chapter-text",
  "chapter: 1",
  "volume: 1",
  "pov: lin-fan",
  "status: draft",
  `word_count: ${countWords(sampleBody)}`,
  "characters_present: [lin-fan]",
  "style_tags: [冷峻]",
  "---",
  "",
  sampleBody,
].join("\n");

function mockCtx(readImpl: () => Promise<string>): ToolContext {
  return {
    storage: { read: vi.fn(readImpl) },
  } as unknown as ToolContext;
}

describe("lint_doc tool", () => {
  it("returns a formatted report with counts in details", async () => {
    const ctx = mockCtx(async () => sampleChapter);
    const result = await createLintDocTool(ctx).execute("call-1", { path: "text/ch-001.md" });

    const text = result.content[0].text;
    expect(text).toContain("Lint report for text/ch-001.md");
    // Short body triggers exactly the truncation warning.
    expect(result.details).toMatchObject({ errors: 0, warnings: 1 });
  });

  it("renders an OK report for a passing document", async () => {
    const notes = [
      "他把水囊灌满，在溪边的石头上磨了磨刀。",
      "山雨说下就下，他躲进一处废弃的山神庙过夜。",
      "清晨出发时，雾气还没有散尽。",
      "路上遇到一队返程的货郎，换了两张进山的官凭。",
      "崖边的栈道断了一截，只能贴着湿滑的石壁爬过去。",
      "傍晚宿营时，他把火堆压得很低，不让光透出林子。",
      "第二天天没亮就动身，赶在大风前翻过了山脊。",
    ];
    const goodBody = notes.join("") + notes.join("");
    const doc = [
      "---",
      "type: chapter-text",
      "chapter: 2",
      "volume: 1",
      "pov: lin-fan",
      "status: draft",
      `word_count: ${countWords(goodBody)}`,
      "characters_present: [lin-fan]",
      "style_tags: [冷峻]",
      "---",
      "",
      goodBody,
    ].join("\n");
    const ctx = mockCtx(async () => doc);
    const result = await createLintDocTool(ctx).execute("call-2", { path: "text/ch-002.md" });

    expect(result.content[0].text).toContain("Lint OK");
    expect(result.details.errors).toBe(0);
  });

  it("surfaces read failures as error results", async () => {
    const ctx = mockCtx(async () => {
      throw new Error("object not found");
    });
    const result = await createLintDocTool(ctx).execute("call-3", { path: "text/gone.md" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error linting text/gone.md");
  });
});

describe("notes_health tool", () => {
  function healthCtx(docs: Record<string, any[]>, files: Record<string, string>): ToolContext {
    return {
      db: {
        listDocuments: vi.fn(async (_pid: string, docType?: string) => docs[docType ?? "all"] ?? []),
      },
      storage: {
        read: vi.fn(async (path: string) => {
          if (!(path in files)) throw new Error(`object not found: ${path}`);
          return files[path];
        }),
      },
    } as unknown as ToolContext;
  }

  const confirmedChapters = (n: number, updatedAt = "2026-08-01T00:00:00.000Z") =>
    Array.from({ length: n }, (_, i) => ({
      doc_path: `text/ch-${String(i + 1).padStart(3, "0")}.md`,
      doc_type: "chapter-text",
      status: "confirmed",
      chapter_num: i + 1,
      updated_at: updatedAt,
    }));

  const storySoFar = (sections: number[], latest: number, updatedAt = "2026-08-02T00:00:00.000Z") => ({
    doc_path: "summary/story-so-far.md",
    doc_type: "story-summary",
    status: "draft",
    updated_at: updatedAt,
    meta: { latest_chapter: latest },
  });

  const storySoFarContent = (sections: number[]) => [
    "---",
    "type: story-summary",
    "status: draft",
    "latest_chapter: " + Math.max(...sections, 0),
    "---",
    "",
    ...sections.map((n) => `## Ch.${n} 第${n}章\n\n摘要。`),
  ].join("\n");

  it("reports a healthy project with full coverage", async () => {
    const ctx = healthCtx({
      "chapter-text": confirmedChapters(3),
      "story-summary": [storySoFar([1, 2, 3], 3)],
      "character-state": [{
        doc_path: "characters/lin-fan-state.md",
        doc_type: "character-state",
        status: "draft",
        updated_at: "2026-08-02T00:00:00.000Z",
        meta: { character: "lin-fan", latest_chapter: 3 },
      }],
      character: [{ doc_path: "characters/lin-fan.md", doc_type: "character", meta: { slug: "lin-fan" } }],
    }, {
      "summary/story-so-far.md": storySoFarContent([1, 2, 3]),
    });

    const result = await createNotesHealthTool(ctx).execute("call-h1", {});

    expect(result.details.healthy).toBe(true);
    expect(result.content[0].text).toContain("healthy");
  });

  it("reports coverage gap and missing sections", async () => {
    const ctx = healthCtx({
      "chapter-text": confirmedChapters(5),
      "story-summary": [storySoFar([1, 2], 3)],
      "character-state": [],
      character: [],
    }, {
      "summary/story-so-far.md": storySoFarContent([1, 2]),
    });

    const result = await createNotesHealthTool(ctx).execute("call-h2", {});
    const text = result.content[0].text as string;

    expect(result.details.healthy).toBe(false);
    expect(text).toContain("latest_chapter=3");
    expect(text).toContain("第 5 章");
    expect(text).toContain("Ch.4");
    expect(text).toContain("Ch.5");
  });

  it("reports orphan character-state files", async () => {
    const ctx = healthCtx({
      "chapter-text": confirmedChapters(1),
      "story-summary": [storySoFar([1], 1)],
      "character-state": [{
        doc_path: "characters/ghost-state.md",
        doc_type: "character-state",
        status: "draft",
        updated_at: "2026-08-02T00:00:00.000Z",
        meta: { character: "ghost" },
      }],
      character: [],
    }, {
      "summary/story-so-far.md": storySoFarContent([1]),
    });

    const result = await createNotesHealthTool(ctx).execute("call-h3", {});

    expect(result.details.healthy).toBe(false);
    expect(result.content[0].text).toContain("characters/ghost-state.md");
    expect(result.content[0].text).toContain("正典角色档案");
  });

  it("warns when a confirmed chapter was re-confirmed after the notes update", async () => {
    const ctx = healthCtx({
      "chapter-text": confirmedChapters(2, "2026-08-03T00:00:00.000Z"),
      "story-summary": [storySoFar([1, 2], 2)],
      "character-state": [],
      character: [],
    }, {
      "summary/story-so-far.md": storySoFarContent([1, 2]),
    });

    const result = await createNotesHealthTool(ctx).execute("call-h4", {});
    const text = result.content[0].text as string;

    expect(result.details.healthy).toBe(false);
    expect(text).toContain("重新确认");
    expect(text).toContain("需复核");
  });

  it("reports missing story-so-far as an issue", async () => {
    const ctx = healthCtx({
      "chapter-text": confirmedChapters(2),
      "story-summary": [],
      "character-state": [],
      character: [],
    }, {});

    const result = await createNotesHealthTool(ctx).execute("call-h5", {});

    expect(result.details.healthy).toBe(false);
    expect(result.content[0].text).toContain("summary/story-so-far.md");
  });

  it("skips the section-hole check for legacy section-less summaries", async () => {
    const ctx = healthCtx({
      "chapter-text": confirmedChapters(3),
      "story-summary": [storySoFar([], 3)],
      "character-state": [],
      character: [],
    }, {
      "summary/story-so-far.md": "---\ntype: story-summary\n---\n旧式滚动摘要正文",
    });

    const result = await createNotesHealthTool(ctx).execute("call-h6", {});
    const text = result.content[0].text as string;

    expect(text).not.toContain("Ch.");
    expect(result.details.healthy).toBe(true);
  });
});
