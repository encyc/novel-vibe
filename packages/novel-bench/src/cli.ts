import { parseArgs } from "node:util";
import { loadBenchConfig, type BenchConfig } from "./config.ts";
import { loadCaseLibrary } from "./cases/load.ts";
import { BffClient } from "./runner/bff-client.ts";
import { executeCase } from "./runner/execute.ts";
import { aggregateCase } from "./scoring/aggregate.ts";
import { RUBRIC_VERSION } from "./scoring/rubrics.ts";
import { RUBRICS } from "./scoring/rubrics.ts";
import { runJudgesForCase } from "./scoring/judges/pipeline.ts";
import { chatComplete } from "./scoring/judges/llm.ts";
import { currentGitSha, newRunId, readRun, writeRun } from "./report/run-store.ts";
import { renderReport } from "./report/markdown.ts";
import { diffRuns, renderDiff } from "./report/diff.ts";
import type { CaseResultFile, CollectedDoc, Dimension, RunManifest } from "./types.ts";

const BENCH_VERSION = "0.1.0";

function log(message: string): void {
  console.error(`[bench] ${message}`);
}

function die(message: string): never {
  console.error(`[bench] 错误：${message}`);
  process.exit(1);
}

async function pickJudgeConfig(config: BenchConfig): Promise<{ config: BenchConfig; fallback: boolean }> {
  const deepseekKey = process.env.DEEPSEEK_API_KEY ?? "";
  if (!config.judgeApiKey) {
    if (deepseekKey) {
      log("未配置外部评审 key，回退到 deepseek-chat 自评（报告中已标注）");
      return {
        config: { ...config, judgeBaseUrl: "https://api.deepseek.com/v1", judgeModel: "deepseek-chat", judgeApiKey: deepseekKey },
        fallback: true,
      };
    }
    log("未配置评审 key 且无 DEEPSEEK_API_KEY 可回退，评审将以失败项呈现");
    return { config, fallback: false };
  }
  try {
    await chatComplete({
      baseUrl: config.judgeBaseUrl,
      apiKey: config.judgeApiKey,
      model: config.judgeModel,
      system: "ping",
      user: "回复 ok",
    });
    return { config, fallback: false };
  } catch (err) {
    if (!deepseekKey) {
      log(`评审模型探测失败（${String(err)}）且无 DEEPSEEK_API_KEY 可回退，评审将以失败项呈现`);
      return { config, fallback: false };
    }
    log(`评审模型探测失败（${String(err)}），回退到 deepseek-chat 自评（报告中已标注）`);
    return {
      config: { ...config, judgeBaseUrl: "https://api.deepseek.com/v1", judgeModel: "deepseek-chat", judgeApiKey: deepseekKey },
      fallback: true,
    };
  }
}

async function commandCases(values: Record<string, unknown>): Promise<void> {
  const config = loadBenchConfig();
  const lib = await loadCaseLibrary(config.casesDir);
  for (const benchCase of [...lib.light, ...lib.heavy]) {
    console.log(`${benchCase.id}\t${benchCase.title}\t[${benchCase.dimensionFocus.join(",")}]\tsteps=${benchCase.script.length}`);
  }
  console.error(`[bench] 共 ${lib.light.length} 轻 + ${lib.heavy.length} 重（dir=${values.dir ?? config.casesDir}）`);
}

async function commandRun(values: Record<string, unknown>): Promise<void> {
  const config = loadBenchConfig();
  const layer = (values.layer as string | undefined) ?? "all";
  const onlyCase = values.case as string | undefined;
  const skipJudges = values["skip-judges"] === true;
  const limit = values.limit ? Number(values.limit) : undefined;

  const health = await fetch(`${config.bffUrl}/health`).catch(() => null);
  if (!health || !health.ok) {
    die(`BFF 不可达（${config.bffUrl}）——先起本地全栈（npm start 或 scripts/start.sh）`);
  }
  if (!config.email || !config.password) {
    die("缺少 BENCH_EMAIL / BENCH_PASSWORD（bench 用户凭据）");
  }

  const lib = await loadCaseLibrary(config.casesDir);
  let selected = [...lib.light, ...lib.heavy];
  if (layer === "light") selected = lib.light;
  else if (layer === "heavy") selected = lib.heavy;
  if (onlyCase) selected = selected.filter((c) => c.id === onlyCase);
  if (limit !== undefined) selected = selected.slice(0, limit);
  if (selected.length === 0) die("没有选中的案例（检查 --layer / --case）");

  const client = new BffClient(config.bffUrl);
  await client.login(config.email, config.password);
  const judgePick = await pickJudgeConfig(config);
  const judgeConfig = judgePick.config;

  const gitSha = await currentGitSha(new URL("../..", import.meta.url).pathname);
  const runId = newRunId(config.model, new Date(), gitSha);
  const caseLibraryVersion = `${lib.light.length}L+${lib.heavy.length}H@${gitSha}`;
  log(`run ${runId}：${selected.length} 个案例，生成 ${config.provider}/${config.model}，评审 ${judgeConfig.judgeModel}`);

  const results: CaseResultFile[] = [];
  const artifacts: Record<string, CollectedDoc[]> = {};
  const runOne = async (index: number, benchCase: (typeof selected)[number]): Promise<CaseResultFile> => {
    // Fresh BFF session cookie per case: stale refreshed tokens (clock skew,
    // JWTIssuedAtFuture) 500 the whole setup otherwise.
    await client.login(config.email, config.password);
    log(`(${index + 1}/${selected.length}) ${benchCase.id} 开始`);
    const execution = await executeCase(
      {
        client,
        provider: config.provider,
        model: config.model,
        turnTimeoutMs: config.turnTimeoutMs,
        stallTimeoutMs: config.stallTimeoutMs,
      },
      runId,
      benchCase,
      config.casesDir,
    );
    const judges = await runJudgesForCase(judgeConfig, benchCase, execution.docs, {
      skip: skipJudges || execution.docs.length === 0,
      excludePaths: new Set(benchCase.setup.map((s) => s.path)),
    });
    const aggregate = aggregateCase(execution.docs, benchCase, judges);
    artifacts[benchCase.id] = execution.docs;
    const result: CaseResultFile = {
      caseId: benchCase.id,
      layer: benchCase.layer,
      title: benchCase.title,
      dimensionFocus: benchCase.dimensionFocus,
      status: execution.status,
      turns: execution.turns,
      projectId: execution.projectId,
      sessionId: execution.sessionId,
      docs: execution.docs.map((d) => ({ path: d.path, type: d.type, wordCount: d.wordCount })),
      deterministic: Object.fromEntries(
        aggregate.dimensions.filter((d) => d.deterministic).map((d) => [d.dimension, d.deterministic!]),
      ) as CaseResultFile["deterministic"],
      judges: Object.fromEntries(
        (Object.entries(judges) as Array<[Dimension, typeof judges.prose]>).filter(([, v]) => v.length > 0),
      ) as CaseResultFile["judges"],
      aggregate: {
        overall: aggregate.overall,
        dimensions: aggregate.dimensions.map((d) => ({ dimension: d.dimension, score: d.score })),
      },
      cost: execution.cost,
      error: execution.error,
    };
    log(`(${index + 1}/${selected.length}) ${benchCase.id} ${execution.status} overall=${aggregate.overall}`);
    return result;
  };

  for (const [index, benchCase] of selected.entries()) {
    results.push(await runOne(index, benchCase));
  }

  // Transient upstream failures (stream cuts, provider hiccups) shouldn't cost
  // a round its case: re-run each non-complete case once from a fresh sandbox.
  const retries = values.retries === undefined ? 1 : Number(values.retries);
  for (let attempt = 1; attempt <= retries; attempt++) {
    const redo = results.filter((r) => r.status !== "complete");
    if (redo.length === 0) break;
    log(`重试轮 ${attempt}/${retries}：${redo.map((r) => r.caseId).join("、")}`);
    for (const stale of redo) {
      const index = selected.findIndex((c) => c.id === stale.caseId);
      if (index === -1) continue;
      const retried = await runOne(index, selected[index]!);
      const at = results.findIndex((r) => r.caseId === stale.caseId);
      results[at] = retried;
    }
  }

  const manifest: RunManifest = {
    runId,
    gitSha,
    startedAt: new Date().toISOString(),
    generator: { provider: config.provider, model: config.model },
    judge: { baseUrl: judgeConfig.judgeBaseUrl, model: judgeConfig.judgeModel },
    judgeFallback: judgePick.fallback,
    rubricVersion: RUBRIC_VERSION,
    caseLibraryVersion,
    benchVersion: BENCH_VERSION,
    costBasis: "credits-activity-delta（按天聚合，本地串行跑批）",
    status: results.every((r) => r.status === "complete") && results.length > 0 ? "complete" : "partial",
  };
  const report = renderReport(manifest, results);
  const runDir = await writeRun(config.runsDir, manifest, results, artifacts, report);
  console.log(runDir);
  log(`完成：${manifest.status}，报告 ${runDir}/report.md`);
}

async function commandReport(positionals: string[]): Promise<void> {
  const config = loadBenchConfig();
  const runId = positionals[1];
  if (!runId) die("用法：bench report <runId>");
  const run = await readRun(config.runsDir, runId);
  console.log(renderReport(run.manifest, run.results));
}

async function commandDiff(positionals: string[]): Promise<void> {
  const config = loadBenchConfig();
  const [, a, b] = positionals;
  if (!a || !b) die("用法：bench diff <runIdA> <runIdB>");
  const noiseDelta = config.noiseDelta;
  const diff = diffRuns(await readRun(config.runsDir, a), await readRun(config.runsDir, b), noiseDelta);
  console.log(renderDiff(diff, a, b, noiseDelta));
}

async function commandClean(positionals: string[]): Promise<void> {
  const config = loadBenchConfig();
  const runId = positionals[1];
  if (!runId) die("用法：bench clean <runId>");
  if (!config.email || !config.password) die("缺少 BENCH_EMAIL / BENCH_PASSWORD");
  const run = await readRun(config.runsDir, runId);
  const projectIds = run.results.map((r) => (r as CaseResultFile & { projectId?: string }).projectId).filter((id): id is string => Boolean(id));
  if (projectIds.length === 0) {
    log("该 run 没有记录 projectId，无需清理（v1 的 run 未持久化项目 id 时请手动清理）");
    return;
  }
  const client = new BffClient(config.bffUrl);
  await client.login(config.email, config.password);
  for (const projectId of projectIds) {
    await client.trashProject(projectId);
    log(`已删除项目 ${projectId}`);
  }
}

function usage(): never {
  console.log(`novel-bench — 网文生成能力基准

用法：
  npm run bench -- cases                       列出并校验案例库
  npm run bench -- run [--layer light|heavy|all] [--case <id>] [--limit N] [--skip-judges]
  npm run bench -- report <runId>              重渲染某轮报告
  npm run bench -- diff <runIdA> <runIdB>      两轮回归对比
  npm run bench -- clean <runId>               删除该 run 的沙箱项目`);
  process.exit(0);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      layer: { type: "string" },
      case: { type: "string" },
      limit: { type: "string" },
      "skip-judges": { type: "boolean" },
      retries: { type: "string" },
      dir: { type: "string" },
    },
  });
  const command = positionals[0];
  if (command === "cases") await commandCases(values);
  else if (command === "run") await commandRun(values);
  else if (command === "report") await commandReport(positionals);
  else if (command === "diff") await commandDiff(positionals);
  else if (command === "clean") await commandClean(positionals);
  else usage();
}

main().catch((err) => die(String(err instanceof Error ? err.stack ?? err.message : err)));
