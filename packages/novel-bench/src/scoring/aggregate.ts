import type { BenchCase, CollectedDoc, Dimension, DimensionScore, JudgeResult } from "../types.ts";
import { scoreContinuity, scoreDesign, scoreProse } from "./deterministic.ts";
import type { DeterministicResult } from "../types.ts";

function mean(items: Array<{ score: number }>): number | null {
  if (items.length === 0) return null;
  return items.reduce((acc, item) => acc + item.score, 0) / items.length;
}

function judgeMean(judges: JudgeResult[]): number | null {
  const okItems = judges.filter((j) => j.ok).flatMap((j) => j.items);
  return mean(okItems);
}

function mix(deterministic: number | null, judged: number | null): number | null {
  if (deterministic !== null && judged !== null) return deterministic * 0.5 + judged * 0.5;
  if (deterministic !== null) return deterministic;
  return judged;
}

/** Which judges feed each dimension (rubric ids). */
export const DIMENSION_RUBRICS: Record<Dimension, string[]> = {
  prose: ["prose_flavor", "prose_structure"],
  design: ["design_outline", "design_worldbuilding"],
  continuity: ["continuity_review"],
};

export function deterministicFor(dimension: Dimension, docs: CollectedDoc[], c: BenchCase["constraints"]): DeterministicResult | null {
  switch (dimension) {
    case "prose":
      return scoreProse(docs, c);
    case "design":
      return scoreDesign(docs, c);
    case "continuity":
      return scoreContinuity(docs, c);
  }
}

export interface CaseJudgeOutput {
  dimensions: DimensionScore[];
  overall: number | null;
}

/**
 * Combine deterministic scorers and LLM judges into per-dimension scores and
 * a rubric-weighted case overall. Dimensions with no signal at all are null
 * and skipped by the weighted mean.
 */
export function aggregateCase(
  docs: CollectedDoc[],
  benchCase: BenchCase,
  judgesByDimension: Record<Dimension, JudgeResult[]>,
): CaseJudgeOutput {
  // Seeded setup documents are inputs, not outputs: prose/design must only
  // score what the system generated. Continuity keeps them — the seeded
  // foreshadow docs are the live tracking surface the agents update.
  const setupPaths = new Set(benchCase.setup.map((s) => s.path));
  const generatedDocs = docs.filter((doc) => !setupPaths.has(doc.path));
  const dimensions: DimensionScore[] = (["prose", "design", "continuity"] as Dimension[]).map((dimension) => {
    const deterministic = deterministicFor(
      dimension,
      dimension === "continuity" ? docs : generatedDocs,
      benchCase.constraints,
    );
    const judges = judgesByDimension[dimension] ?? [];
    const detScore = deterministic?.score ?? null;
    const judgedScore = judgeMean(judges);
    return {
      dimension,
      deterministic,
      judges,
      score: mix(detScore, judgedScore),
    };
  });

  const weights = benchCase.rubricWeights;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const dimension of dimensions) {
    if (dimension.score === null) continue;
    const weight = weights[dimension.dimension];
    if (weight !== undefined) {
      weightedSum += dimension.score * weight;
      weightTotal += weight;
    }
  }
  // No explicit weights (or all weight on null dimensions): fall back to the
  // plain mean of available dimension scores.
  let overall: number | null;
  if (weightTotal > 0) {
    overall = weightedSum / weightTotal;
  } else {
    overall = mean(dimensions.filter((d) => d.score !== null).map((d) => ({ score: d.score! })));
  }

  return { dimensions, overall: overall === null ? null : Math.round(overall * 100) / 100 };
}
