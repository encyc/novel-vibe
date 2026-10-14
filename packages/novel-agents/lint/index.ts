/**
 * Prose-Lint entry point: pure-function aggregation over (path, content).
 * No storage, DB, or model I/O — the offline harness grades artifacts through
 * this same entry point (verifier-stack spec ADR-5).
 */
import { parseFrontmatter } from "../lib/frontmatter.js";
import { LINT_CONFIG } from "./config.js";
import { checkFrontmatter } from "./rules/frontmatter.js";
import { checkBannedPhrases, checkEndingSummary, checkRepetition, checkWordCounts } from "./rules/prose.js";
import { checkChapterMeta } from "./rules/chapter-meta.js";
import type { LintFinding, ProseLintReport } from "./types.js";

export function runProseLint(path: string, content: string): ProseLintReport {
  const { frontmatter, body } = parseFrontmatter(content);
  const rawType = frontmatter.type ?? frontmatter.doc_type;
  const docType = typeof rawType === "string" ? rawType : null;

  const findings: LintFinding[] = [...checkFrontmatter(frontmatter)];

  if (docType) {
    // Word rules internally no-op unless docType is chapter-text or story-summary.
    findings.push(...checkWordCounts(docType, frontmatter, body));
    // Self-scopes to chapter-text: ending pull check.
    findings.push(...checkEndingSummary(docType, body));
    if (docType === "chapter-text") {
      findings.push(...checkChapterMeta(frontmatter));
    }
    if (LINT_CONFIG.narrativeTypes.has(docType)) {
      findings.push(...checkBannedPhrases(body));
      findings.push(...checkRepetition(body));
    }
  }

  return {
    path,
    docType,
    findings: sortFindings(findings),
  };
}

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1 };

function sortFindings(findings: LintFinding[]): LintFinding[] {
  return [...findings].sort((a, b) =>
    (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || a.rule.localeCompare(b.rule),
  );
}

export { formatLintReport, countFindings } from "./types.js";
export type { LintFinding, LintSeverity, ProseLintReport } from "./types.js";
