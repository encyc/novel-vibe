import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
  ModelResolutionError,
  ModelResolver,
  isOpenCodeDynamicModelsEnabled,
} from "./model-resolver.js";
import type { RuntimeModelRow } from "./types.js";

const builtin: Model<any> = {
  id: "builtin-model", name: "Built in", api: "openai-responses", provider: "opencode",
  baseUrl: "https://opencode.ai/zen/v1", reasoning: true, input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000, maxTokens: 100,
};

const runtimeRow = (overrides: Partial<RuntimeModelRow> = {}): RuntimeModelRow => ({
  id: "runtime-1", provider: "opencode", modelId: "gpt-5.6-sol", name: "GPT 5.6 Sol",
  api: "openai-responses", baseUrl: "https://opencode.ai/zen/v1",
  contextWindow: 272000, maxTokens: 64000, reasoning: false, inputModalities: ["text"],
  source: "opencode-dynamic", runtimeFingerprint: "fingerprint", sourceHashes: {},
  status: "active", disabledReason: null, disabledAt: null, lastSeenAt: "2026-08-18T00:00:00Z",
  ...overrides,
});

function setup(options: {
  row?: RuntimeModelRow | null;
  dynamicEnabled?: boolean;
  now?: () => number;
  builtinLookup?: (provider: string, modelId: string) => Model<any> | undefined;
} = {}) {
  const repository = { getRuntimeModel: vi.fn().mockResolvedValue(options.row ?? runtimeRow()) };
  const resolver = new ModelResolver({
    repository,
    dynamicEnabled: options.dynamicEnabled ?? true,
    ttlMs: 60_000,
    now: options.now ?? (() => 0),
    builtinLookup: options.builtinLookup ?? (() => undefined),
  });
  return { repository, resolver };
}

describe("ModelResolver", () => {
  it("always prefers a pi-ai built-in without reading the repository", async () => {
    const { resolver, repository } = setup({ builtinLookup: () => builtin });
    await expect(resolver.resolve("opencode", "builtin-model")).resolves.toEqual({
      model: builtin, source: "pi-ai",
    });
    expect(repository.getRuntimeModel).not.toHaveBeenCalled();
  });

  it("enables the dynamic fallback only for the exact true flag", () => {
    expect(isOpenCodeDynamicModelsEnabled({ OPENCODE_DYNAMIC_MODELS_ENABLED: "true" })).toBe(true);
    expect(isOpenCodeDynamicModelsEnabled({ OPENCODE_DYNAMIC_MODELS_ENABLED: "TRUE" })).toBe(false);
    expect(isOpenCodeDynamicModelsEnabled({ OPENCODE_DYNAMIC_MODELS_ENABLED: "1" })).toBe(false);
    expect(isOpenCodeDynamicModelsEnabled({})).toBe(false);
  });

  it("allows fallback only for OpenCode and only when enabled", async () => {
    await expect(setup({ dynamicEnabled: false }).resolver.resolve("opencode", "gpt-5.6-sol"))
      .rejects.toMatchObject({ code: "dynamic_disabled" });
    await expect(setup().resolver.resolve("openai", "gpt-5.6-sol"))
      .rejects.toMatchObject({ code: "model_not_found" });
  });

  it("constructs a conservative pi-ai model from an active trusted row", async () => {
    const result = await setup().resolver.resolve("opencode", "gpt-5.6-sol");
    expect(result).toMatchObject({
      source: "opencode-dynamic", runtimeCatalogId: "runtime-1", runtimeFingerprint: "fingerprint",
      model: {
        id: "gpt-5.6-sol", provider: "opencode", api: "openai-responses",
        reasoning: false, input: ["text"], contextWindow: 272000, maxTokens: 64000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });
  });

  it.each(["disabled", "retired"] as const)("rejects a %s runtime row", async (status) => {
    await expect(setup({ row: runtimeRow({ status }) }).resolver.resolve("opencode", "gpt-5.6-sol"))
      .rejects.toMatchObject({ code: "runtime_unavailable" });
  });

  it.each([
    { baseUrl: "https://evil.example/v1" },
    { contextWindow: 0 },
    { maxTokens: -1 },
    { reasoning: true },
    { inputModalities: ["text", "image"] },
    { source: "pi-ai" },
  ] satisfies Partial<RuntimeModelRow>[]) ("rejects malformed dynamic metadata: %j", async (override) => {
    await expect(setup({ row: runtimeRow(override) }).resolver.resolve("opencode", "gpt-5.6-sol"))
      .rejects.toMatchObject({ code: "invalid_runtime" });
  });

  it("caches both successful and missing resolutions for sixty seconds", async () => {
    let now = 0;
    const positive = setup({ now: () => now });
    await positive.resolver.resolve("opencode", "gpt-5.6-sol");
    await positive.resolver.resolve("opencode", "gpt-5.6-sol");
    expect(positive.repository.getRuntimeModel).toHaveBeenCalledTimes(1);
    now = 60_001;
    await positive.resolver.resolve("opencode", "gpt-5.6-sol");
    expect(positive.repository.getRuntimeModel).toHaveBeenCalledTimes(2);

    const negative = setup({ row: null });
    await expect(negative.resolver.resolve("opencode", "missing")).rejects.toBeInstanceOf(ModelResolutionError);
    await expect(negative.resolver.resolve("opencode", "missing")).rejects.toBeInstanceOf(ModelResolutionError);
    expect(negative.repository.getRuntimeModel).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent repository reads", async () => {
    let release!: (row: RuntimeModelRow) => void;
    const pending = new Promise<RuntimeModelRow>((resolve) => { release = resolve; });
    const repository = { getRuntimeModel: vi.fn().mockReturnValue(pending) };
    const resolver = new ModelResolver({
      repository,
      dynamicEnabled: true,
      builtinLookup: () => undefined,
    });
    const first = resolver.resolve("opencode", "gpt-5.6-sol");
    const second = resolver.resolve("opencode", "gpt-5.6-sol");
    release(runtimeRow());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(repository.getRuntimeModel).toHaveBeenCalledTimes(1);
  });

  it("serves a stale positive value when a refresh read fails", async () => {
    let now = 0;
    const { resolver, repository } = setup({ now: () => now });
    const initial = await resolver.resolve("opencode", "gpt-5.6-sol");
    now = 60_001;
    repository.getRuntimeModel.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(resolver.resolve("opencode", "gpt-5.6-sol")).resolves.toEqual(initial);
  });
});

describe("byok provider namespace", () => {
  it("resolves byok providers against the builtin base-provider catalog", async () => {
    const deepseekBuiltin: Model<any> = { ...builtin, id: "deepseek-chat", provider: "deepseek" };
    const { resolver } = setup({
      builtinLookup: (provider, modelId) =>
        provider === "deepseek" && modelId === "deepseek-chat" ? deepseekBuiltin : undefined,
    });
    const resolved = await resolver.resolve("byok-deepseek", "deepseek-chat");
    expect(resolved.source).toBe("pi-ai");
    expect(resolved.model.provider).toBe("deepseek");
  });

  it("rejects unknown byok bases and unknown models", async () => {
    const { resolver } = setup({});
    await expect(resolver.resolve("byok-not-a-provider", "x")).rejects.toMatchObject({ code: "model_not_found" });
    await expect(resolver.resolve("byok-deepseek", "no-such-model")).rejects.toMatchObject({ code: "model_not_found" });
  });
});
