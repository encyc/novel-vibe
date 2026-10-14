import { describe, expect, it, vi } from "vitest";
import {
  fetchOpenCodeSources,
  parseOpenCodeCandidate,
} from "./opencode-source.js";

const pricingMarkdown = `
## Endpoints

| Model | Model ID | Endpoint | AI SDK Package |
| --- | --- | --- | --- |
| Plain Model | plain-model | \`https://opencode.ai/zen/v1/responses\` | sdk |
| DeepSeek V4 Pro | deepseek-v4-pro | \`https://opencode.ai/zen/v1/chat/completions\` | sdk |
| Tier Model | tier-model | \`https://opencode.ai/zen/v1/responses\` | sdk |
| Future Model | future-model | \`https://opencode.ai/zen/v1/responses\` | sdk |
| GPT 5.3 Codex Spark | gpt-5.3-codex-spark | \`https://opencode.ai/zen/v1/responses\` | sdk |
| Unpriced Model | unpriced-model | \`https://opencode.ai/zen/v1/responses\` | sdk |
| Unsupported Endpoint | unsupported-endpoint | \`https://opencode.ai/zen/v1/unknown\` | sdk |

## Pricing

We support a pay-as-you-go model. Below are the prices **per 1M tokens**.

| Model | Input | Output | Cached Read | Cached Write |
| --- | --- | --- | --- | --- |
| Plain Model | $1.00 | $2.00 | $0.10 | - |
| DeepSeek V4 Pro (Off-Peak) | $0.66 | $1.98 | $0.022 | - |
| DeepSeek V4 Pro (Peak) | $1.32 | $3.96 | $0.044 | - |
| Tier Model (≤ 200K tokens) | $3.00 | $15.00 | $0.30 | $3.75 |
| Tier Model (> 200K tokens) | $6.00 | $22.50 | $0.60 | $7.50 |
| Future Model | Free | Free | Free | - |
| GPT 5.3 Codex Spark | $1.50 | $6.00 | $0.15 | - |
| Unsupported Endpoint | $1.00 | $2.00 | $0.10 | - |

**DeepSeek V4 Flash / Pro:** Peak hours are 01:00-04:00 and 06:00-10:00 UTC; all other hours are Off-Peak.
`;

describe("parseOpenCodeCandidate", () => {
  it("parses normal, peak, context-tier, unsupported, and unpriced models", () => {
    const candidate = parseOpenCodeCandidate({
      modelsJson: {
        object: "list",
        data: [
          { id: "plain-model" },
          { id: "deepseek-v4-pro" },
          { id: "tier-model" },
          { id: "future-model" },
          { id: "gpt-5.3-codex-spark" },
          { id: "unpriced-model" },
          { id: "unsupported-endpoint" },
        ],
      },
      pricingMarkdown,
      runtimeModelIds: new Set([
        "plain-model",
        "deepseek-v4-pro",
        "tier-model",
        "unpriced-model",
      ]),
    });

    expect(candidate.observedModelIds).toEqual([
      "deepseek-v4-pro",
      "future-model",
      "gpt-5.3-codex-spark",
      "plain-model",
      "tier-model",
      "unpriced-model",
      "unsupported-endpoint",
    ]);
    expect(candidate.unsupportedEndpointModelIds).toEqual(["unsupported-endpoint"]);
    expect(candidate.unpricedRuntimeModelIds).toEqual(["unpriced-model"]);
    expect(candidate.models).toHaveLength(5);

    const plain = candidate.models.find((model) => model.id === "plain-model");
    expect(plain?.baseRates).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 });
    expect(plain?.runtime).toMatchObject({
      endpoint: "https://opencode.ai/zen/v1/responses",
      api: "openai-responses",
      source: "pi-ai",
    });

    const dynamic = candidate.models.find((model) => model.id === "gpt-5.3-codex-spark");
    expect(dynamic?.runtime).toMatchObject({
      endpoint: "https://opencode.ai/zen/v1/responses",
      api: "openai-responses",
      source: "opencode-dynamic",
      contextWindow: 272000,
      maxTokens: 64000,
    });
    expect(dynamic?.runtime.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const peak = candidate.models.find((model) => model.id === "deepseek-v4-pro");
    expect(peak?.baseRates).toEqual({ input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 });
    expect(peak?.timeWindows).toEqual([
      { label: "peak_1", startMinuteUtc: 60, endMinuteUtc: 240, rates: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 } },
      { label: "peak_2", startMinuteUtc: 360, endMinuteUtc: 600, rates: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 } },
    ]);

    const tiered = candidate.models.find((model) => model.id === "tier-model");
    expect(tiered?.baseRates.input).toBe(3);
    expect(tiered?.contextTiers).toEqual([
      { label: "over_200k", minContextTokens: 200001, maxContextTokens: null, rates: { input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 } },
    ]);
    expect(candidate.sourceHashes.models).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate.sourceHashes.pricing).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects structurally invalid sources before producing a candidate", () => {
    expect(() => parseOpenCodeCandidate({
      modelsJson: { object: "list", data: "wrong" },
      pricingMarkdown,
      runtimeModelIds: new Set(),
    })).toThrow("OpenCode models response");

    expect(() => parseOpenCodeCandidate({
      modelsJson: { object: "list", data: [{ id: "plain-model" }] },
      pricingMarkdown: "# no pricing table",
      runtimeModelIds: new Set(["plain-model"]),
    })).toThrow("table");

    expect(() => parseOpenCodeCandidate({
      modelsJson: { object: "list", data: [] },
      pricingMarkdown,
      runtimeModelIds: new Set(),
    })).toThrow("empty model list");
  });

  it("rejects ambiguous and unsafe price structures", () => {
    expect(() => parseOpenCodeCandidate({
      modelsJson: { object: "list", data: [{ id: "plain-model" }] },
      pricingMarkdown: pricingMarkdown.replace("| Plain Model | $1.00", "| Plain Model | -"),
      runtimeModelIds: new Set(["plain-model"]),
    })).toThrow("Invalid OpenCode price");

    expect(() => parseOpenCodeCandidate({
      modelsJson: { object: "list", data: [{ id: "plain-model" }] },
      pricingMarkdown: pricingMarkdown.replace(
        "| Plain Model | $1.00 | $2.00 | $0.10 | - |",
        "| Plain Model | $1.00 | $2.00 | $0.10 | - |\n| Plain Model | $1.00 | $2.00 | $0.10 | - |",
      ),
      runtimeModelIds: new Set(["plain-model"]),
    })).toThrow("Duplicate OpenCode pricing qualifier");

    expect(() => parseOpenCodeCandidate({
      modelsJson: { object: "list", data: [{ id: "deepseek-v4-pro" }] },
      pricingMarkdown: pricingMarkdown.replace(
        "01:00-04:00 and 06:00-10:00",
        "01:00-07:00 and 06:00-10:00",
      ),
      runtimeModelIds: new Set(["deepseek-v4-pro"]),
    })).toThrow("overlap");
  });
});

describe("fetchOpenCodeSources", () => {
  it("retries transient failures and requires HTTPS final URLs", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(pricingMarkdown, { status: 200 }));

    const sources = await fetchOpenCodeSources({ fetcher, retryDelaysMs: [0] });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      redirect: "follow",
      signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ "user-agent": expect.stringContaining("Novel-Vibe") }),
    }));
    expect(sources.pricingMarkdown).toContain("## Pricing");
  });
});
