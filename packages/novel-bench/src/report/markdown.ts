import type { CaseResultFile, Dimension, RunManifest } from "../types.ts";

const DIMENSIONS: Dimension[] = ["prose", "design", "continuity"];

function fmtScore(value: number | null | undefined): string {
  return typeof value === "number" ? value.toFixed(2) : "—";
}

function statusMark(status: CaseResultFile["status"]): string {
  return status === "complete" ? "✅" : status === "partial" ? "⚠️" : "❌";
}

export function renderReport(manifest: RunManifest, results: CaseResultFile[]): string {
  const lines: string[] = [];
  lines.push(`# novel-bench 报告：${manifest.runId}`, "");
  lines.push(
    `- 生成模型：\`${manifest.generator.provider}/${manifest.generator.model}\``,
    `- 评审模型：\`${manifest.judge.model}\`（${manifest.judgeFallback ? "回退配置" : "独立配置"}）`,
    `- git SHA：\`${manifest.gitSha}\` · 量规版本 v${manifest.rubricVersion} · 案例库 ${manifest.caseLibraryVersion}`,
    `- 成本口径：${manifest.costBasis} · 状态：${manifest.status}`,
    "",
  );

  lines.push("## 汇总", "");
  lines.push("| 案例 | 状态 | prose | design | continuity | overall | tokens | 耗时 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const result of results) {
    const score = (d: Dimension) => result.aggregate.dimensions.find((x) => x.dimension === d)?.score ?? null;
    const minutes = (result.cost.wallMs / 60_000).toFixed(1);
    lines.push(
      `| ${result.caseId} | ${statusMark(result.status)} | ${fmtScore(score("prose"))} | ${fmtScore(score("design"))} | ${fmtScore(score("continuity"))} | **${fmtScore(result.aggregate.overall)}** | ${result.cost.tokensAfter - result.cost.tokensBefore} | ${minutes}min |`,
    );
  }
  lines.push("");

  const complete = results.filter((r) => r.status === "complete");
  if (complete.length > 0) {
    lines.push("### 维度均值（仅完整案例）", "");
    lines.push("| 维度 | 均分 |", "|---|---|");
    for (const dimension of DIMENSIONS) {
      const scores = complete
        .map((r) => r.aggregate.dimensions.find((x) => x.dimension === dimension)?.score)
        .filter((v): v is number => typeof v === "number");
      const mean = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
      lines.push(`| ${dimension} | ${fmtScore(mean)} |`);
    }
    const overalls = complete.map((r) => r.aggregate.overall).filter((v): v is number => typeof v === "number");
    const overallMean = overalls.length > 0 ? overalls.reduce((a, b) => a + b, 0) / overalls.length : null;
    lines.push(`| **overall** | **${fmtScore(overallMean)}** |`);
    lines.push("");
  }

  for (const result of results) {
    lines.push(`## ${result.caseId} ${statusMark(result.status)}`, "");
    if (result.error) {
      lines.push(`> 错误：${result.error}`, "");
    }
    if (result.turns.length > 0) {
      lines.push(
        `turns：${result.turns.map((t) => `#${t.step} ${t.outcome.kind}${t.expect ? (t.expect.ok ? "/expect✓" : "/expect✗") : ""}`).join("，")}`,
        "",
      );
    }
    for (const dimension of DIMENSIONS) {
      const det = result.deterministic[dimension];
      if (det) {
        lines.push(`### ${dimension} · 确定性（${fmtScore(det.score)}）`, "");
        if (det.findings.length === 0) {
          lines.push("- 无发现");
        } else {
          for (const finding of det.findings) {
            lines.push(`- [${finding.severity}] ${finding.check}：${finding.message}`);
          }
        }
        lines.push("");
      }
      const judges = result.judges[dimension] ?? [];
      for (const judge of judges) {
        lines.push(`### ${dimension} · 评审 ${judge.rubric} v${judge.rubricVersion}${judge.ok ? "" : "（失败，标黄）"}`, "");
        if (!judge.ok) {
          lines.push(`- 评审失败：${judge.note ?? "unknown"}`, "");
          continue;
        }
        for (const item of judge.items) {
          lines.push(`- ${item.criterion}：**${item.score}** — 证据：「${item.evidence.slice(0, 80)}」`);
        }
        lines.push("");
      }
    }
    if (result.docs.length > 0) {
      lines.push(`产出文档：${result.docs.map((d) => `${d.path}(${d.wordCount}字)`).join("、")}`, "");
    }
  }
  return lines.join("\n");
}
