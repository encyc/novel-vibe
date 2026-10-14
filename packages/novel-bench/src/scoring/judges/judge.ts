import type { BenchConfig } from "../../config.ts";
import type { JudgeItem, JudgeResult } from "../../types.ts";
import { getRubric } from "../rubrics.ts";

export type ChatComplete = typeof import("./llm.ts").chatComplete;

interface ParsedJudge {
  items?: Array<{ criterion?: unknown; score?: unknown; evidence?: unknown }>;
}

function extractJson(text: string): ParsedJudge | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as ParsedJudge;
  } catch {
    return null;
  }
}

function clampScore(value: unknown): number | null {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(10, Math.round(num)));
}

/**
 * Run one rubric as an LLM judge over a document payload. Strict JSON out;
 * one retry on unparsable output; ok:false after the second failure.
 */
export async function runJudge(
  llm: ChatComplete,
  cfg: Pick<BenchConfig, "judgeBaseUrl" | "judgeModel" | "judgeApiKey">,
  rubricId: string,
  payload: string,
): Promise<JudgeResult> {
  const rubric = getRubric(rubricId);
  const criteriaText = rubric.criteria.map((c, i) => `${i + 1}. key="${c.key}"：${c.description}`).join("\n");
  const system = rubric.system;
  const user = [
    `评审项（共 ${rubric.criteria.length} 项，评分 0-10）：`,
    criteriaText,
    "",
    `以下是${rubric.payloadHint}：`,
    "```",
    payload.slice(0, 24_000),
    "```",
  ].join("\n");

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await llm({
        baseUrl: cfg.judgeBaseUrl,
        apiKey: cfg.judgeApiKey,
        model: cfg.judgeModel,
        system,
        user: attempt === 0 ? user : `${user}\n\n（再次提醒：只输出 JSON 对象，不要任何其它文字。）`,
      });
      const parsed = extractJson(text);
      if (!parsed?.items || !Array.isArray(parsed.items) || parsed.items.length === 0) {
        lastError = "no items in judge output";
        continue;
      }
      const items: JudgeItem[] = [];
      for (const raw of parsed.items) {
        const score = clampScore(raw.score);
        const criterion = typeof raw.criterion === "string" ? raw.criterion : "";
        if (score === null || !criterion) continue;
        items.push({ criterion, score, evidence: typeof raw.evidence === "string" ? raw.evidence : "" });
      }
      if (items.length === 0) {
        lastError = "all judge items unparsable";
        continue;
      }
      return { rubric: rubric.id, rubricVersion: rubric.version, ok: true, items };
    } catch (err) {
      lastError = String(err instanceof Error ? err.message : err);
    }
  }
  return { rubric: rubric.id, rubricVersion: rubric.version, ok: false, items: [], note: lastError };
}
