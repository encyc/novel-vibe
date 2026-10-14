import type { Dimension } from "../types.ts";
import type { StoredRun } from "./run-store.ts";

export interface DimensionDelta {
  dimension: Dimension;
  meanA: number | null;
  meanB: number | null;
  delta: number | null;
}

export interface CaseDelta {
  caseId: string;
  overallA: number | null;
  overallB: number | null;
  delta: number | null;
  noiseSuspect: boolean;
}

export interface DiffReport {
  dimensions: DimensionDelta[];
  cases: CaseDelta[];
  tokensA: number;
  tokensB: number;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function dimensionMean(run: StoredRun, dimension: Dimension): number | null {
  const scores = run.results
    .filter((r) => r.status === "complete")
    .map((r) => r.aggregate.dimensions.find((d) => d.dimension === dimension)?.score)
    .filter((v): v is number => typeof v === "number");
  return mean(scores);
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

/** Compare two runs. Only complete cases count toward means and case deltas. */
export function diffRuns(a: StoredRun, b: StoredRun, noiseDelta: number): DiffReport {
  const dimensions = (["prose", "design", "continuity"] as Dimension[]).map((dimension) => {
    const meanA = dimensionMean(a, dimension);
    const meanB = dimensionMean(b, dimension);
    return {
      dimension,
      meanA: round(meanA),
      meanB: round(meanB),
      delta: meanA !== null && meanB !== null ? round(meanB - meanA) : null,
    };
  });

  const idsA = new Map(a.results.filter((r) => r.status === "complete").map((r) => [r.caseId, r]));
  const idsB = new Map(b.results.filter((r) => r.status === "complete").map((r) => [r.caseId, r]));
  const cases: CaseDelta[] = [];
  for (const [caseId, resultA] of idsA) {
    const resultB = idsB.get(caseId);
    if (!resultB) continue;
    const overallA = resultA.aggregate.overall;
    const overallB = resultB.aggregate.overall;
    const delta = overallA !== null && overallB !== null ? Math.round((overallB - overallA) * 100) / 100 : null;
    cases.push({
      caseId,
      overallA,
      overallB,
      delta,
      noiseSuspect: delta !== null && Math.abs(delta) < noiseDelta,
    });
  }
  cases.sort((x, y) => Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0));

  const tokens = (run: StoredRun) =>
    run.results.reduce((acc, r) => acc + (r.cost.tokensAfter - r.cost.tokensBefore), 0);

  return { dimensions, cases, tokensA: tokens(a), tokensB: tokens(b) };
}

export function renderDiff(diff: DiffReport, aId: string, bId: string, noiseDelta: number): string {
  const lines: string[] = [];
  lines.push(`# 回归对比：${aId} → ${bId}`, "");
  lines.push("## 维度均值", "");
  lines.push("| 维度 | A | B | Δ |", "|---|---|---|---|");
  for (const d of diff.dimensions) {
    lines.push(`| ${d.dimension} | ${d.meanA ?? "—"} | ${d.meanB ?? "—"} | ${d.delta === null ? "—" : signed(d.delta)} |`);
  }
  lines.push("", "## 逐案例 overall（按 |Δ| 降序）", "");
  lines.push(`|Δ| < ${noiseDelta} 标记为疑似噪声。`, "");
  lines.push("| 案例 | A | B | Δ | 判定 |", "|---|---|---|---|---|");
  for (const c of diff.cases) {
    lines.push(
      `| ${c.caseId} | ${c.overallA ?? "—"} | ${c.overallB ?? "—"} | ${c.delta === null ? "—" : signed(c.delta)} | ${c.noiseSuspect ? "疑似噪声，建议 rerun" : "实质变化"} |`,
    );
  }
  lines.push("", `## 成本`, "");
  lines.push(`- tokens：${diff.tokensA} → ${diff.tokensB}（${signed(diff.tokensB - diff.tokensA)}）`);
  return lines.join("\n");
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}
