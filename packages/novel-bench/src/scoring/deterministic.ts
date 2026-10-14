import { Value } from "@sinclair/typebox/value";
import { runProseLint } from "../../../novel-agents/lint/index.ts";
import { parseFrontmatter } from "../../../novel-agents/lib/frontmatter.ts";
import { frontmatterSchemas } from "../../../novel-agents/schemas/frontmatter.ts";
import type { BenchCase, CheckFinding, CollectedDoc, DeterministicResult } from "../types.ts";

type Constraints = BenchCase["constraints"];

function clamp(value: number): number {
  return Math.max(0, Math.min(10, value));
}

function result(score: number | null, findings: CheckFinding[], metrics: Record<string, number>): DeterministicResult {
  return { score, findings, metrics };
}

/** prose: prose-lint findings + word-count constraints on chapter-text docs. */
export function scoreProse(docs: CollectedDoc[], c: Constraints): DeterministicResult {
  const chapters = docs.filter((doc) => doc.type === "chapter-text");
  if (chapters.length === 0) {
    return result(null, [], {});
  }
  const findings: CheckFinding[] = [];
  const metrics: Record<string, number> = {};
  const scores: number[] = [];
  for (const doc of chapters) {
    const report = runProseLint(doc.path, doc.content);
    let score = 10;
    for (const finding of report.findings) {
      const penalty = finding.severity === "error" ? 2 : 0.5;
      score -= penalty;
      findings.push({ check: `lint:${finding.rule}`, severity: finding.severity, message: `${doc.path}: ${finding.message}` });
    }
    metrics[`lint_${doc.path}`] = clamp(score);
    scores.push(clamp(score));
  }
  const words = chapters.map((doc) => doc.wordCount);
  metrics.words_total = words.reduce((a, b) => a + b, 0);
  metrics.words_min = Math.min(...words);
  if (c.minWords) {
    const short = chapters.filter((doc) => doc.wordCount < c.minWords!);
    if (short.length > 0) {
      for (const doc of short) {
        findings.push({
          check: "words.min",
          severity: "error",
          message: `${doc.path}: ${doc.wordCount} 字，低于下限 ${c.minWords}`,
        });
      }
    }
  }
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  // A hard constraint miss caps the dimension — lint polish cannot offset it.
  const capped = findings.some((f) => f.check === "words.min") ? Math.min(avg, 4) : avg;
  return result(clamp(capped), findings, metrics);
}

const DESIGN_DOC_TYPES = new Set(["worldview", "character", "relationships", "volume", "chapter-skeleton", "chapter-card", "director-script"]);

/** design: required doc types, chapter-card schema validity, chapter coverage. */
export function scoreDesign(docs: CollectedDoc[], c: Constraints): DeterministicResult {
  const findings: CheckFinding[] = [];
  const metrics: Record<string, number> = {};
  const designDocs = docs.filter((doc) => DESIGN_DOC_TYPES.has(doc.type));
  if (designDocs.length === 0) {
    return result(null, findings, metrics);
  }
  let score = 10;
  const presentTypes = new Set(docs.map((doc) => doc.type));
  for (const type of c.requiredDocTypes ?? []) {
    if (!presentTypes.has(type)) {
      score -= 3;
      findings.push({ check: "design.required_type", severity: "error", message: `缺少必产文档类型 ${type}` });
    }
  }
  metrics.cards_total = docs.filter((doc) => doc.type === "chapter-card").length;
  for (const doc of docs.filter((d) => d.type === "chapter-card")) {
    const { frontmatter } = parseFrontmatter(doc.content);
    const schema = frontmatterSchemas["chapter-card"];
    if (schema && !Value.Check(schema, frontmatter)) {
      score -= 2;
      findings.push({ check: "design.card_schema", severity: "error", message: `${doc.path}: 章卡 frontmatter 不合 schema` });
    }
  }
  const presentChapters = new Set(
    docs
      .filter((doc) => doc.type === "chapter-text" || doc.type === "chapter-card")
      .map((doc) => parseFrontmatter(doc.content).frontmatter.chapter)
      .filter((n): n is number => typeof n === "number"),
  );
  metrics.chapters_present = presentChapters.size;
  for (const chapter of c.chapterNums ?? []) {
    if (!presentChapters.has(chapter)) {
      score -= 3;
      findings.push({ check: "design.chapter_missing", severity: "error", message: `缺第 ${chapter} 章的章纲/正文` });
    }
  }
  return result(clamp(score), findings, metrics);
}

/** continuity: foreshadow recovery rate against the case's seeded id list. */
export function scoreContinuity(docs: CollectedDoc[], c: Constraints): DeterministicResult {
  const findings: CheckFinding[] = [];
  const metrics: Record<string, number> = {};
  const expected = c.foreshadowIds ?? [];
  const foreshadows = docs.filter((doc) => doc.type === "foreshadow");
  const hasLongRangeInput = expected.length > 0 || foreshadows.length > 0 || docs.some((d) => d.type === "chapter-text");
  if (!hasLongRangeInput) {
    return result(null, findings, metrics);
  }
  const states = new Map<string, { status: string | null; actualResolve: number | null }>();
  for (const doc of foreshadows) {
    const { frontmatter } = parseFrontmatter(doc.content);
    const id = typeof frontmatter.id === "string" ? frontmatter.id : null;
    if (!id) continue;
    states.set(id, {
      status: typeof frontmatter.status === "string" ? frontmatter.status : null,
      actualResolve: typeof frontmatter.actual_resolve === "number" ? frontmatter.actual_resolve : null,
    });
  }
  if (expected.length > 0) {
    let resolved = 0;
    for (const id of expected) {
      const state = states.get(id);
      if (state?.status === "resolved" || state?.actualResolve != null) {
        resolved += 1;
      } else if (!state) {
        findings.push({ check: "continuity.foreshadow_missing", severity: "warning", message: `伏笔 ${id} 无对应文档` });
      } else {
        findings.push({
          check: "continuity.foreshadow_unresolved",
          severity: "warning",
          message: `伏笔 ${id} 状态 ${state.status ?? "unknown"}，未回收`,
        });
      }
    }
    metrics.foreshadow_expected = expected.length;
    metrics.foreshadow_resolved = resolved;
    return result(clamp((resolved / expected.length) * 10), findings, metrics);
  }
  // No seeded list: continuity via summary presence only (soft signals).
  const hasSummary = docs.some((doc) => doc.type === "story-summary");
  if (!hasSummary && docs.some((doc) => doc.type === "chapter-text")) {
    findings.push({ check: "continuity.summary_missing", severity: "warning", message: "多章产出缺少 story-summary 前情文档" });
  }
  return result(null, findings, metrics);
}
