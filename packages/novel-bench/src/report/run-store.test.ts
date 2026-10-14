import { mkdtemp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newRunId, readRun, writeRun } from "./run-store.ts";
import { renderReport } from "./markdown.ts";
import { diffRuns, renderDiff } from "./diff.ts";
import type { CaseResultFile, RunManifest } from "../types.ts";

function resultFile(caseId: string, overall: number | null, status: CaseResultFile["status"] = "complete"): CaseResultFile {
  return {
    caseId,
    layer: "light",
    title: `案例 ${caseId}`,
    dimensionFocus: ["prose"],
    status,
    turns: [],
    projectId: "prj-1",
    docs: [{ path: "text/ch-001.md", type: "chapter-text", wordCount: 960 }],
    deterministic: {
      prose: { score: 10, findings: [], metrics: { words_min: 960 } },
    },
    judges: {
      prose: [
        {
          rubric: "prose_flavor",
          rubricVersion: 1,
          ok: status === "complete",
          items: [{ criterion: "ai_flavor", score: 7, evidence: "他攥紧了拳头" }],
          note: status === "complete" ? undefined : "judge LLM 500: exploded",
        },
      ],
    },
    aggregate: {
      overall,
      dimensions: [{ dimension: "prose", score: overall }],
    },
    cost: { tokensBefore: 100, tokensAfter: 350, wallMs: 61_000 },
  };
}

function manifest(runId: string, status: RunManifest["status"] = "complete"): RunManifest {
  return {
    runId,
    gitSha: "abc1234",
    startedAt: "2026-09-05T10:15:30.000Z",
    generator: { provider: "deepseek", model: "deepseek-v4-flash" },
    judge: { baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5" },
    judgeFallback: false,
    rubricVersion: 1,
    caseLibraryVersion: "6L+1H@abc1234",
    benchVersion: "0.1.0",
    costBasis: "credits-activity-delta（按天聚合，本地串行跑批）",
    status,
  };
}

describe("newRunId", () => {
  it("binds timestamp + git sha + model slug", () => {
    const id = newRunId("deepseek/deepseek-v4-flash", new Date(2026, 8, 5, 10, 15, 30), "abc1234");
    expect(id).toBe("2026-09-05T101530-abc1234-deepseek-deepseek-v4-flash");
  });
});

describe("writeRun/readRun roundtrip", () => {
  it("writes manifest, case files, artifacts and report; readRun loads them back", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "bench-runs-"));
    const m = manifest("run-a");
    const results = [resultFile("light/L001", 8.5)];
    const artifacts = {
      "light/L001": [
        { path: "text/ch-001.md", type: "chapter-text", content: "正文原文", wordCount: 4 },
      ],
    };
    const dir = await writeRun(runsDir, m, results, artifacts, "# 报告\n");
    await access(join(dir, "manifest.json"));
    await access(join(dir, "cases", "light__L001.json"));
    await access(join(dir, "artifacts", "light__L001", "text__ch-001.md"));
    await access(join(dir, "report.md"));
    const stored = await readRun(runsDir, "run-a");
    expect(stored.manifest.runId).toBe("run-a");
    expect(stored.results[0]?.aggregate.overall).toBe(8.5);
    expect(await readFile(join(dir, "artifacts", "light__L001", "text__ch-001.md"), "utf8")).toBe("正文原文");
  });
});

describe("renderReport", () => {
  it("renders summary rows, dimension means, findings and judge evidence", () => {
    const results = [
      resultFile("light/L001", 8.5),
      resultFile("light/L002", null, "failed"),
    ];
    const text = renderReport(manifest("run-a", "partial"), results);
    expect(text).toContain("novel-bench 报告：run-a");
    expect(text).toContain("| light/L001 | ✅ | 8.50 | — | — | **8.50** | 250 | 1.0min |");
    expect(text).toContain("❌");
    expect(text).toContain("评审失败：judge LLM 500");
    expect(text).toContain("证据：「他攥紧了拳头」");
    expect(text).toContain("维度均值（仅完整案例）");
    expect(text).toContain("| **overall** | **8.50** |");
  });
});

describe("diffRuns/renderDiff", () => {
  const runOf = (runId: string, cases: CaseResultFile[]) => ({
    manifest: manifest(runId),
    results: cases,
    dir: `/tmp/${runId}`,
  });

  it("computes dimension means, sorted case deltas and noise flags", () => {
    const a = runOf("run-a", [resultFile("light/L001", 8), resultFile("light/L002", 6)]);
    const b = runOf("run-b", [
      resultFile("light/L001", 8.4),
      resultFile("light/L002", 4),
      resultFile("light/L003", 9, "failed"), // incomplete: ignored
    ]);
    const diff = diffRuns(a, b, 1);
    expect(diff.dimensions.find((d) => d.dimension === "prose")?.delta).toBeCloseTo(-0.8, 5); // (8.4+4)/2 - 7
    expect(diff.cases.map((c) => c.caseId)).toEqual(["light/L002", "light/L001"]); // |−2| > |+0.4|
    expect(diff.cases.find((c) => c.caseId === "light/L001")?.noiseSuspect).toBe(true);
    expect(diff.cases.find((c) => c.caseId === "light/L002")?.noiseSuspect).toBe(false);
    expect(diff.tokensA).toBe(500);
    const text = renderDiff(diff, "run-a", "run-b", 1);
    expect(text).toContain("疑似噪声，建议 rerun");
    expect(text).toContain("实质变化");
    expect(text).toContain("+0.4");
  });
});
