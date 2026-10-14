/**
 * Prose rules: word-count honesty, cliché phrase detection, and long-passage
 * repetition. All pure functions of (frontmatter, body).
 */
import { countWords } from "../../lib/frontmatter.js";
import { BANNED_PHRASES } from "../data/banned-phrases.js";
import { ENDING_SUMMARY_PHRASES } from "../data/ending-summary-phrases.js";
import { LINT_CONFIG } from "../config.js";
import type { LintFinding } from "../types.js";

export function checkWordCounts(
  docType: string,
  frontmatter: Record<string, unknown>,
  body: string,
): LintFinding[] {
  const findings: LintFinding[] = [];
  const actual = countWords(body);

  if (docType === "story-summary") {
    const max = LINT_CONFIG.storySummary.maxWords;
    if (actual > max) {
      findings.push({
        rule: "word.summary_limit",
        severity: "error",
        message: `故事摘要超出 ${max} 字上限（实际 ${actual} 字）`,
        hint: "压缩到只保留影响后续剧情的事实与状态变化",
      });
    }
    return findings;
  }

  if (docType === "chapter-text") {
    if (actual < LINT_CONFIG.chapterText.minWords) {
      findings.push({
        rule: "word.too_short",
        severity: "warning",
        message: `正文字数过少（${actual} 字），可能是生成被截断`,
      });
    }
    const declared = frontmatter.word_count;
    if (typeof declared === "number" && actual > 0) {
      const deviation = Math.abs(declared - actual) / actual;
      if (deviation > LINT_CONFIG.chapterText.declaredDeviationRatio) {
        findings.push({
          rule: "word.reported_mismatch",
          severity: "warning",
          message: `frontmatter.word_count 声明 ${declared} 字，正文实际约 ${actual} 字（偏差 ${(deviation * 100).toFixed(0)}%）`,
          hint: "以真实字数更新 word_count，虚假声明会破坏下游字数核对",
        });
      }
    }
  }
  return findings;
}

export function checkBannedPhrases(body: string): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const phrase of BANNED_PHRASES) {
    let count = 0;
    let idx = body.indexOf(phrase);
    while (idx !== -1) {
      count++;
      idx = body.indexOf(phrase, idx + phrase.length);
    }
    if (count > 0) {
      findings.push({
        rule: "prose.banned_phrase",
        severity: "warning",
        message: `命中 AI 高频套话："${phrase}" ×${count}`,
        hint: "替换为具体化的动作、感官细节或直接删减",
      });
      if (findings.length >= LINT_CONFIG.bannedPhrases.maxFindings) break;
    }
  }
  return findings;
}

export interface RepeatedPassage {
  snippet: string;
  occurrences: number;
}

/**
 * Detect near-fill loops: identical substrings of at least `minLength` chars
 * occurring `minOccurrences`+ times in the whitespace-stripped body.
 * Greedy maximal extension collapses nested repeats into their longest form;
 * snippets must contain CJK characters so markdown separators don't trigger.
 */
export function findRepeatedPassages(body: string): RepeatedPassage[] {
  const cfg = LINT_CONFIG.repetition;
  const text = body.replace(/\s+/g, "");
  const n = text.length;
  if (n < cfg.minLength * cfg.minOccurrences) return [];

  const startsBySeed = new Map<string, number[]>();
  for (let i = 0; i + cfg.minLength <= n; i++) {
    const seed = text.slice(i, i + cfg.minLength);
    const list = startsBySeed.get(seed);
    if (list) list.push(i);
    else startsBySeed.set(seed, [i]);
  }

  const kept: RepeatedPassage[] = [];
  for (const [, starts] of startsBySeed) {
    if (starts.length < cfg.minOccurrences) continue;
    let len = cfg.minLength;
    outer: while (len < cfg.maxSpan && starts[0] + len < n) {
      const ch = text[starts[0] + len];
      for (let k = 1; k < starts.length; k++) {
        if (starts[k] + len >= n || text[starts[k] + len] !== ch) break outer;
      }
      len++;
    }
    kept.push({ snippet: text.slice(starts[0], starts[0] + len), occurrences: starts.length });
  }

  // Drop candidates contained inside an already-kept longer repeat.
  kept.sort((a, b) => b.snippet.length - a.snippet.length);
  const deduped: RepeatedPassage[] = [];
  for (const candidate of kept) {
    if (deduped.some((k) => k.snippet.includes(candidate.snippet))) continue;
    const cjk = (candidate.snippet.match(/[一-鿿㐀-䶿]/g) ?? []).length;
    if (cjk < cfg.minCjkChars) continue;
    deduped.push(candidate);
    if (deduped.length >= cfg.maxFindings) break;
  }
  return deduped;
}

export function checkRepetition(body: string): LintFinding[] {
  return findRepeatedPassages(body).map((r) => ({
    rule: "prose.repetition",
    severity: "warning" as const,
    message: `检测到重复片段 ×${r.occurrences}：「${r.snippet.slice(0, 60)}${r.snippet.length > 60 ? "…" : ""}」`,
    hint: "同一桥段反复出现通常是水文信号，压缩或改写为递进",
  }));
}

/**
 * Flag chapters whose final paragraph closes on a summary/moralizing beat
 * instead of ending pull (章末拉力). Only chapter-text is scanned and only the
 * tail of the last non-empty line, so quiet-aftermath endings (余韵) pass.
 */
export function checkEndingSummary(docType: string, body: string): LintFinding[] {
  if (docType !== "chapter-text") return [];
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const last = lines[lines.length - 1];
  const tail = last.length > LINT_CONFIG.endingSummary.tailChars
    ? last.slice(-LINT_CONFIG.endingSummary.tailChars)
    : last;
  for (const phrase of ENDING_SUMMARY_PHRASES) {
    if (tail.includes(phrase)) {
      return [{
        rule: "prose.ending_summary",
        severity: "warning",
        message: `章末段命中总结/说理句式："${phrase}"`,
        hint: "章末应停在变化上（新危机/被迫选择/关系变化/真相揭开一角），不收在总结句或道理",
      }];
    }
  }
  return [];
}
