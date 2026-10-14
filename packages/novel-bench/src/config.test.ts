import { describe, expect, it } from "vitest";
import { loadBenchConfig } from "./config.ts";

describe("loadBenchConfig", () => {
  it("falls back to defaults on empty env", () => {
    const cfg = loadBenchConfig({}, { dotenv: false });
    expect(cfg.bffUrl).toBe("http://localhost:9120");
    expect(cfg.provider).toBe("deepseek");
    expect(cfg.model).toBe("deepseek-flash");
    expect(cfg.judgeBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.judgeModel).toBe("anthropic/claude-sonnet-4.5");
    expect(cfg.judgeApiKey).toBe("");
    expect(cfg.turnTimeoutMs).toBe(1_800_000);
    expect(cfg.stallTimeoutMs).toBe(180_000);
    expect(cfg.noiseDelta).toBe(1);
    expect(cfg.runsDir.endsWith("runs")).toBe(true);
    expect(cfg.casesDir.endsWith("cases")).toBe(true);
  });

  it("BENCH_* overrides win over LLM_* fallbacks", () => {
    const cfg = loadBenchConfig({
      BENCH_BFF_URL: "http://127.0.0.1:9999",
      BENCH_PROVIDER: "openai",
      BENCH_MODEL: "gpt-x",
      LLM_PROVIDER: "deepseek",
      LLM_MODEL: "deepseek-v4-flash",
      BENCH_JUDGE_API_KEY: "sk-judge",
      BENCH_TURN_TIMEOUT_MS: "1234",
      BENCH_NOISE_DELTA: "0.5",
      BENCH_EMAIL: "bench@example.com",
      BENCH_PASSWORD: "secret",
    }, { dotenv: false });
    expect(cfg.bffUrl).toBe("http://127.0.0.1:9999");
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-x");
    expect(cfg.judgeApiKey).toBe("sk-judge");
    expect(cfg.turnTimeoutMs).toBe(1234);
    expect(cfg.noiseDelta).toBe(0.5);
    expect(cfg.email).toBe("bench@example.com");
    expect(cfg.password).toBe("secret");
  });

  it("falls back to LLM_* and OPENROUTER/OPENCODE keys when BENCH_* unset", () => {
    const cfg = loadBenchConfig({ LLM_PROVIDER: "moonshot", LLM_MODEL: "kimi-k3", OPENROUTER_API_KEY: "sk-or" }, { dotenv: false });
    expect(cfg.provider).toBe("moonshot");
    expect(cfg.model).toBe("kimi-k3");
    expect(cfg.judgeApiKey).toBe("sk-or");
    const cfg2 = loadBenchConfig({ OPENCODE_API_KEY: "sk-oc" }, { dotenv: false });
    expect(cfg2.judgeApiKey).toBe("sk-oc");
  });
});
