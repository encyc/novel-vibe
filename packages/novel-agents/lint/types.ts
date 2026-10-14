/**
 * Prose-Lint finding model.
 * Pure data — no storage, DB, or model access. See
 * docs/superpowers/specs/2026-08-27-novel-harness-verifier-stack-design.md (ADR-5).
 */

export type LintSeverity = "error" | "warning";

export interface LintFinding {
  /** Stable rule id, e.g. "frontmatter.schema", "prose.banned_phrase". */
  rule: string;
  severity: LintSeverity;
  message: string;
  hint?: string;
}

export interface ProseLintReport {
  path: string;
  docType: string | null;
  findings: LintFinding[];
}

export function countFindings(report: ProseLintReport): { errors: number; warnings: number } {
  return {
    errors: report.findings.filter((f) => f.severity === "error").length,
    warnings: report.findings.filter((f) => f.severity === "warning").length,
  };
}

/** Human/agent-readable rendering returned as the lint_doc tool result. */
export function formatLintReport(report: ProseLintReport): string {
  const { errors, warnings } = countFindings(report);
  if (report.findings.length === 0) {
    return `Lint OK：${report.path}（${report.docType ?? "未知类型"}）未发现问题。`;
  }
  const lines = [
    `Lint report for ${report.path}（${report.docType ?? "未知类型"}）：${errors} error(s), ${warnings} warning(s)`,
    ...report.findings.map((f) =>
      `[${f.severity}] ${f.rule}: ${f.message}${f.hint ? `\n        建议：${f.hint}` : ""}`,
    ),
  ];
  return lines.join("\n");
}
