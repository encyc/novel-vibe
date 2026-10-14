import { describe, expect, it, vi } from "vitest";
import {
  buildReaderReport,
  clampChapterBody,
  createSimulateReaderTool,
  extractJsonBlock,
  foldReaderReply,
  renderReaderPrompt,
} from "./simulator-tools.js";

describe("extractJsonBlock", () => {
  it("finds a balanced object inside fences and prose", () => {
    const text = "阅读完成。\n```json\n{\"confusions\":[],\"updated_notes\":\"a{b}\"}\n```";
    expect(extractJsonBlock(text)).toBe('{"confusions":[],"updated_notes":"a{b}"}');
  });

  it("returns null when no object exists", () => {
    expect(extractJsonBlock("没有任何 JSON")).toBeNull();
  });
});

describe("foldReaderReply", () => {
  it("folds a well-formed reply", () => {
    const reply = JSON.stringify({
      confusions: [{ where: "第二章开头", type: "unknown_entity", note: "\"北境联盟\"没有出现过" },
        { where: "", type: "magic_power", note: "非法类型会回落" }],
      engagement_drop: true,
      updated_notes: "主角获得断剑；北境联盟是敌方。",
    });
    const { parsed, nextNotes } = foldReaderReply(reply, "旧笔记");
    expect(parsed.confusions).toHaveLength(2);
    expect(parsed.confusions[1].type).toBe("logic_gap");
    expect(parsed.engagementDrop).toBe(true);
    expect(nextNotes).toContain("断剑");
  });

  it("degrades gracefully on unparseable replies and keeps prior notes", () => {
    const { parsed, nextNotes } = foldReaderReply("这章节奏有点慢，没什么大问题。", "旧笔记");
    expect(parsed.parseFailed).toBe(true);
    expect(nextNotes).toBe("旧笔记");
  });

  it("keeps notes within budget", () => {
    const reply = JSON.stringify({ confusions: [], updated_notes: "记".repeat(5000) });
    const { nextNotes } = foldReaderReply(reply, "");
    expect(nextNotes.length).toBeLessThanOrEqual(1600);
  });
});

describe("renderReaderPrompt / clampChapterBody", () => {
  it("embeds notes and truncated bodies in the reader task frame", () => {
    const prompt = renderReaderPrompt({
      chapter: 4,
      body: clampChapterBody("正文".repeat(10_000)),
      notes: "仅记得断剑。",
    });
    expect(prompt).toContain('<reader_task chapter="4">');
    expect(prompt).toContain("<rolling_notes>\n仅记得断剑。");
    expect(prompt).toContain("本章正文超长已截断");
  });
});

describe("buildReaderReport", () => {
  it("summarizes confusion counts, drops and truncation guidance", () => {
    const report = buildReaderReport({
      fromChapter: 3,
      toChapter: 9,
      truncated: true,
      sections: [
        { chapter: 3, path: "text/ch-003.md", rawReply: "{}",
          parsed: { confusions: [{ where: "开场", type: "unknown_entity", note: "陌生门派" }], engagementDrop: false, updatedNotes: null, parseFailed: false } },
        { chapter: 5, path: "text/ch-005.md", rawReply: "乱写的",
          parsed: { confusions: [], engagementDrop: false, updatedNotes: null, parseFailed: true } },
      ],
    });
    expect(report).toContain("# 读者模拟报告（第 3–9 章）");
    expect(report).toContain("❓[unknown_entity] 开场：陌生门派");
    expect(report).toContain("本章结果降级为未整理记录");
    expect(report).toContain("1 个困惑点");
  });
});

describe("simulate_reader tool", () => {
  it("validates the range before invoking the runner", async () => {
    const runner = { runReaderCheckpoint: vi.fn() };
    const tool = createSimulateReaderTool(runner);
    const result = await (tool as any).execute("c1", { from_chapter: 7, to_chapter: 3 });
    expect(result.isError).toBe(true);
    expect(runner.runReaderCheckpoint).not.toHaveBeenCalled();
  });

  it("forwards the range to the runner and returns its report", async () => {
    const runner = {
      runReaderCheckpoint: vi.fn(async (from: number, to: number) => ({
        report: `# 读者模拟报告（第 ${from}–${to} 章）`,
        chaptersRead: [from, to],
        confusionCount: 0,
      })),
    };
    const tool = createSimulateReaderTool(runner);
    const result = await (tool as any).execute("c2", { from_chapter: 1, to_chapter: 6 });
    expect(runner.runReaderCheckpoint).toHaveBeenCalledWith(1, 6);
    expect(result.content[0].text).toContain("第 1–6 章");
    expect(result.details.chapters_read).toEqual([1, 6]);
  });

  it("wraps runner failures as error results", async () => {
    const tool = createSimulateReaderTool({ runReaderCheckpoint: vi.fn(async () => { throw new Error("范围没有章节"); }) });
    const result = await (tool as any).execute("c3", { from_chapter: 2, to_chapter: 2 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("范围没有章节");
  });
});
