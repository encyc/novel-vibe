import { parseFrontmatter } from "../../../../novel-agents/lib/frontmatter.ts";
import type { BenchConfig } from "../../config.ts";
import type { BenchCase, CollectedDoc, Dimension, JudgeResult } from "../../types.ts";
import { chatComplete } from "./llm.ts";
import { runJudge } from "./judge.ts";
import { DIMENSION_RUBRICS } from "../aggregate.ts";

/**
 * Chapter sampling for judge cost control: ≤3 chapters judge all, else
 * first/middle/last only.
 */
export function sampleChapterDocs(docs: CollectedDoc[]): CollectedDoc[] {
  const chapters = docs
    .filter((d) => d.type === "chapter-text")
    .map((d) => ({ doc: d, chapter: parseFrontmatter(d.content).frontmatter.chapter }))
    .sort((x, y) => (typeof x.chapter === "number" ? x.chapter : 0) - (typeof y.chapter === "number" ? y.chapter : 0))
    .map((entry) => entry.doc);
  if (chapters.length <= 3) return chapters;
  const mid = Math.floor(chapters.length / 2);
  return [chapters[0]!, chapters[mid]!, chapters[chapters.length - 1]!];
}

function joinDocs(docs: CollectedDoc[], maxChars = 48_000): string {
  let out = "";
  for (const doc of docs) {
    const section = `\n\n===== ${doc.path} =====\n${doc.content}`;
    if (out.length + section.length > maxChars) break;
    out += section;
  }
  return out.trim();
}

function docsForDimension(dimension: Dimension, benchCase: BenchCase, docs: CollectedDoc[]): CollectedDoc[] {
  switch (dimension) {
    case "prose":
      return sampleChapterDocs(docs);
    case "design":
      return docs.filter((d) => ["chapter-card", "volume", "chapter-skeleton", "worldview", "character", "director-script"].includes(d.type));
    case "continuity":
      return [...sampleChapterDocs(docs), ...docs.filter((d) => ["story-summary", "foreshadow"].includes(d.type))];
  }
}

export interface JudgeOptions {
  skip?: boolean;
  /** Seeded setup doc paths — inputs, not outputs; excluded from judged payloads. */
  excludePaths?: Set<string>;
}

/** Run all rubric judges for a case, grouped by dimension. */
export async function runJudgesForCase(
  config: BenchConfig,
  benchCase: BenchCase,
  docs: CollectedDoc[],
  options: JudgeOptions = {},
): Promise<Record<Dimension, JudgeResult[]>> {
  const result: Record<Dimension, JudgeResult[]> = { prose: [], design: [], continuity: [] };
  if (options.skip) return result;
  const exclude = options.excludePaths ?? new Set<string>();
  for (const dimension of ["prose", "design", "continuity"] as Dimension[]) {
    const relevant = docsForDimension(dimension, benchCase, docs).filter(
      (doc) => dimension === "continuity" || !exclude.has(doc.path),
    );
    if (relevant.length === 0) continue;
    for (const rubricId of DIMENSION_RUBRICS[dimension]) {
      result[dimension].push(await runJudge(chatComplete, config, rubricId, joinDocs(relevant)));
    }
  }
  return result;
}
