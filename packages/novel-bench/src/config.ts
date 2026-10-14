import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface BenchConfig {
  bffUrl: string;
  email: string;
  password: string;
  /** Generator model pinned for a whole run (per-request override to the chat API). */
  provider: string;
  model: string;
  judgeBaseUrl: string;
  judgeModel: string;
  judgeApiKey: string;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
  noiseDelta: number;
  runsDir: string;
  casesDir: string;
}

function packageDir(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

/** Minimal .env loader (KEY=VALUE lines) so credentials can live next to the CLI. */
function loadEnvFile(env: Record<string, string | undefined>, file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1]!;
    // An inherited EMPTY shell variable counts as unset for backfill purposes.
    if (env[key] === undefined || env[key] === "") {
      env[key] = match[2]!.replace(/^["']|["']$/g, "");
    }
  }
}

function loadDotEnv(env: Record<string, string | undefined>): void {
  // bench-local credentials win; the agent server's .env backfills provider
  // keys (OPENROUTER/DEEPSEEK) that the bench judge shares with the stack.
  loadEnvFile(env, `${packageDir()}.env`);
  loadEnvFile(env, `${packageDir()}../novel-agents/.env`);
}

/** First value that is neither undefined nor empty — env files legitimately
 *  carry placeholder empty lines (e.g. OPENROUTER_API_KEY=) that must not
 *  short-circuit fallback chains the way nullish-coalescing does. */
function firstNonEmpty(...vals: Array<string | undefined>): string {
  return vals.find((v) => v !== undefined && v !== "") ?? "";
}

export function loadBenchConfig(
  rawEnv: Record<string, string | undefined> = process.env,
  options: { dotenv?: boolean } = {},
): BenchConfig {
  const env = { ...rawEnv };
  if (options.dotenv !== false) {
    loadDotEnv(env);
  }
  return {
    bffUrl: env.BENCH_BFF_URL ?? "http://localhost:9120",
    email: env.BENCH_EMAIL ?? "",
    password: env.BENCH_PASSWORD ?? "",
    provider: firstNonEmpty(env.BENCH_PROVIDER, env.LLM_PROVIDER, "deepseek"),
    model: firstNonEmpty(env.BENCH_MODEL, env.LLM_MODEL, "deepseek-flash"),
    judgeBaseUrl: firstNonEmpty(env.BENCH_JUDGE_BASE_URL, "https://openrouter.ai/api/v1"),
    judgeModel: firstNonEmpty(env.BENCH_JUDGE_MODEL, "anthropic/claude-sonnet-4.5"),
    judgeApiKey: firstNonEmpty(env.BENCH_JUDGE_API_KEY, env.OPENROUTER_API_KEY, env.OPENCODE_API_KEY, env.MIMO_API_KEY),
    turnTimeoutMs: Number(env.BENCH_TURN_TIMEOUT_MS ?? 1_800_000),
    stallTimeoutMs: Number(env.BENCH_STALL_TIMEOUT_MS ?? 180_000),
    noiseDelta: Number(env.BENCH_NOISE_DELTA ?? 1),
    runsDir: env.BENCH_RUNS_DIR ?? `${packageDir()}runs`,
    casesDir: env.BENCH_CASES_DIR ?? `${packageDir()}cases`,
  };
}
