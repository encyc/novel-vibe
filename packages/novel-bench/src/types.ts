/** Domain types shared across the bench package. */

export type Dimension = "prose" | "design" | "continuity";

export interface CaseSetupDoc {
  /** Storage-relative path, e.g. `outline/ch-002.md`. Must match `type`'s directory. */
  path: string;
  type: string;
  /** Fixture file relative to the case YAML file. */
  fixture: string;
}

export interface CaseExpect {
  docType?: string;
  path?: string;
  minCount?: number;
}

export interface CaseScriptStep {
  text: string;
  expect?: CaseExpect;
}

export interface CaseConstraints {
  minWords?: number;
  chapterNums?: number[];
  requiredDocTypes?: string[];
  /** Foreshadow ids seeded in setup; recovery rate is measured against these. */
  foreshadowIds?: string[];
}

export interface BenchCase {
  id: string;
  title: string;
  layer: "light" | "heavy";
  dimensionFocus: Dimension[];
  setup: CaseSetupDoc[];
  script: CaseScriptStep[];
  constraints: CaseConstraints;
  rubricWeights: { prose?: number; design?: number; continuity?: number };
}

export interface DocumentIndexRow {
  doc_path: string;
  doc_type: string;
  name?: string;
  status?: string;
  chapter_num?: number | null;
  volume_num?: number | null;
  word_count?: number | null;
  checksum?: string;
}

export interface CollectedDoc {
  path: string;
  type: string;
  content: string;
  wordCount: number;
}

export type TurnOutcome =
  | { kind: "complete"; startedAt: number; endedAt: number }
  | { kind: "failed"; reason: string; startedAt: number; endedAt: number };

export interface TurnRecord {
  step: number;
  outcome: TurnOutcome;
  expect?: { ok: boolean; detail: string };
}

export interface CaseExecution {
  caseId: string;
  status: "complete" | "partial" | "failed";
  projectId?: string;
  sessionId?: string;
  turns: TurnRecord[];
  docs: CollectedDoc[];
  cost: { tokensBefore: number; tokensAfter: number; wallMs: number };
  error?: string;
}

export interface CheckFinding {
  check: string;
  severity: "error" | "warning";
  message: string;
}

export interface DeterministicResult {
  score: number | null;
  findings: CheckFinding[];
  metrics: Record<string, number>;
}

export interface JudgeItem {
  criterion: string;
  score: number;
  evidence: string;
}

export interface JudgeResult {
  rubric: string;
  rubricVersion: number;
  ok: boolean;
  items: JudgeItem[];
  note?: string;
}

export interface DimensionScore {
  dimension: Dimension;
  deterministic: DeterministicResult | null;
  judges: JudgeResult[];
  score: number | null;
}

export interface CaseAggregate {
  dimensions: DimensionScore[];
  overall: number | null;
}

/** One `cases/<case-id>.json` file inside a run directory. */
export interface CaseResultFile {
  caseId: string;
  layer: BenchCase["layer"];
  title: string;
  dimensionFocus: Dimension[];
  status: CaseExecution["status"];
  turns: TurnRecord[];
  projectId?: string;
  sessionId?: string;
  docs: Array<{ path: string; type: string; wordCount: number }>;
  deterministic: Partial<Record<Dimension, DeterministicResult>>;
  judges: Partial<Record<Dimension, JudgeResult[]>>;
  aggregate: { overall: number | null; dimensions: Array<{ dimension: Dimension; score: number | null }> };
  cost: CaseExecution["cost"];
  error?: string;
}

export interface RunManifest {
  runId: string;
  gitSha: string;
  startedAt: string;
  generator: { provider: string; model: string };
  judge: { baseUrl: string; model: string };
  judgeFallback: boolean;
  rubricVersion: number;
  caseLibraryVersion: string;
  benchVersion: string;
  costBasis: string;
  status: "complete" | "partial";
}
