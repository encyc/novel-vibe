/**
 * Reader-proxy simulation — verifier-stack spec Phase 4 ("run-and-observe").
 *
 * The orchestrator drives a throwaway zero-tool agent with a serial-reader
 * protocol (rolling-notes memory, one chapter per turn). This module holds the
 * pure folding/reporting logic and the thin chief-editor-facing tool; the
 * orchestration loop itself lives in agents.ts next to the continuity runner.
 */

export const READER_SYSTEM_PROMPT = `你是一个"有限记忆的连载读者"模拟器。规则：

1. 你的全部知识只有 <rolling_notes>（截至上一章的记忆笔记）与本轮的 <chapter_text>；绝对不要调用任何工具，也不要引入外部设定知识。
2. 以真实连载读者的心态阅读：只记得笔记里记下的东西。记不住的信息一旦正文未重申，就按"读不懂线索"处理。
3. 每读完一章，输出且仅输出一个 JSON 对象（一行纯 JSON，禁止 Markdown 代码围栏与任何解释文字）：
{"confusions":[{"where":"引发困惑的片段","type":"unknown_entity","note":"一句话说明"}],"engagement_drop":false,"updated_notes":"你的新记忆笔记，≤200 字，记下关键人物状态、悬而未决的钩子"}

type 只能取：unknown_entity / contradiction / logic_gap / pacing。`;

export const MAX_READER_CHAPTERS = 6;
export const CHAPTER_BODY_CHAR_BUDGET = 12_000;
export const NOTES_CHAR_BUDGET = 1_600;

export interface ReaderChapterEntry {
  chapter: number;
  path: string;
  rawReply: string;
}

export interface ParsedReaderReply {
  confusions: Array<{ where?: string; type?: string; note?: string }>;
  engagementDrop: boolean;
  updatedNotes: string | null;
  parseFailed: boolean;
}

/** Pull the first balanced {...} block out of a possibly fenced reply. */
export function extractJsonBlock(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const CONFUSION_TYPES = new Set(["unknown_entity", "contradiction", "logic_gap", "pacing"]);

export function foldReaderReply(rawReply: string, previousNotes: string): { parsed: ParsedReaderReply; nextNotes: string } {
  const json = extractJsonBlock(rawReply);
  if (!json) {
    return {
      parsed: { confusions: [], engagementDrop: false, updatedNotes: null, parseFailed: true },
      nextNotes: previousNotes,
    };
  }
  let value: any;
  try {
    value = JSON.parse(json);
  } catch {
    return {
      parsed: { confusions: [], engagementDrop: false, updatedNotes: null, parseFailed: true },
      nextNotes: previousNotes,
    };
  }
  const confusions = Array.isArray(value.confusions)
    ? value.confusions.filter((c: any) => c && typeof c.note === "string")
        .map((c: any) => ({
          where: typeof c.where === "string" ? c.where : "",
          type: CONFUSION_TYPES.has(c.type) ? c.type : "logic_gap",
          note: String(c.note),
        }))
    : [];
  const notes = typeof value.updated_notes === "string" && value.updated_notes.trim()
    ? value.updated_notes.trim().slice(0, NOTES_CHAR_BUDGET)
    : previousNotes;
  return {
    parsed: { confusions, engagementDrop: !!value.engagement_drop, updatedNotes: notes, parseFailed: false },
    nextNotes: notes,
  };
}

export function clampChapterBody(body: string): string {
  if (body.length <= CHAPTER_BODY_CHAR_BUDGET) return body;
  return `${body.slice(0, CHAPTER_BODY_CHAR_BUDGET)}\n[…本章正文超长已截断…]`;
}

export interface ReaderTurnInput {
  chapter: number;
  title?: string;
  body: string;
  notes: string;
}

export function renderReaderPrompt(input: ReaderTurnInput): string {
  return `<reader_task chapter="${input.chapter}">
<rolling_notes>
${input.notes}
</rolling_notes>
<chapter_text${input.title ? ` title="${input.title}"` : ""}>
${clampChapterBody(input.body)}
</chapter_text>
</reader_task>`;
}

export interface ReportSection {
  chapter: number;
  path: string;
  rawReply: string;
  parsed: ParsedReaderReply;
}

export function buildReaderReport(options: {
  fromChapter: number;
  toChapter: number;
  sections: ReportSection[];
  truncated: boolean;
}): string {
  const lines: string[] = [`# 读者模拟报告（第 ${options.fromChapter}–${options.toChapter} 章）`, ""];
  let totalConfusions = 0;
  let drops = 0;
  for (const section of options.sections) {
    const { parsed } = section;
    lines.push(`## 第 ${section.chapter} 章 (${section.path})`);
    if (parsed.parseFailed) {
      lines.push(`- ⚠️ 回复未能解析为 JSON，本章结果降级为未整理记录：`);
      lines.push(`> ${section.rawReply.slice(0, 400).replace(/\n/g, "\n> ")}`);
    }
    for (const c of parsed.confusions) {
      totalConfusions++;
      lines.push(`- ❓[${c.type}] ${c.where || "—"}：${c.note}`);
    }
    if (parsed.engagementDrop) {
      drops++;
      lines.push("- 📉 读者兴趣信号下降");
    }
    lines.push("");
  }
  lines.push("---");
  lines.push(`阅读体验摘要：${totalConfusions} 个困惑点，${drops} 章出现弃读风险信号。`);
  if (options.truncated) {
    lines.push(`注意：范围内超出前 ${MAX_READER_CHAPTERS} 章的部分未纳入本次模拟，请分批运行。`);
  }
  lines.push("处理建议：把 ❓ 项目当作测试失败清单——unknown_entity 通常需要补回context，contradiction 需要修订排期，其余交由导演评估。");
  return lines.join("\n");
}

export interface ReaderCheckpointRunner {
  runReaderCheckpoint(fromChapter: number, toChapter: number): Promise<{
    report: string;
    chaptersRead: number[];
    confusionCount: number;
  }>;
}

// ─── simulate_reader tool ─────────────────────────────────────────

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const simulateParams = Type.Object({
  from_chapter: Type.Number({ description: "First chapter to read (inclusive)" }),
  to_chapter: Type.Number({ description: "Last chapter to read (inclusive). Keep ranges short: at most 6 chapters per run." }),
});

export function createSimulateReaderTool(runner: ReaderCheckpointRunner): AgentTool<typeof simulateParams> {
  return {
    name: "simulate_reader",
    label: "Simulate Reader",
    description:
      "Run a serial limited-memory reader proxy over confirmed chapters to surface confusion events and drop-off risks before real readers hit them. Synchronous and read-only; keep ranges small.",
    parameters: simulateParams,
    execute: async (_, params) => {
      try {
        if (!(Number.isInteger(params.from_chapter) && Number.isInteger(params.to_chapter))
          || params.from_chapter > params.to_chapter
          || params.from_chapter < 1) {
          throw new Error("Invalid chapter range");
        }
        const outcome = await runner.runReaderCheckpoint(params.from_chapter, params.to_chapter);
        return {
          content: [{ type: "text" as const, text: outcome.report }],
          details: {
            from_chapter: params.from_chapter,
            to_chapter: params.to_chapter,
            chapters_read: outcome.chaptersRead,
            confusion_count: outcome.confusionCount,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Reader simulation failed: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}
