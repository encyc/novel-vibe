import { describe, expect, it, vi } from "vitest";
import type { OpenCodeCandidate } from "./opencode-source.js";
import {
  applyCatalogChangeSet,
  buildCatalogChangeSet,
  convertOfficialRates,
  reenableOpenCodeModel,
  type CurrentCatalogState,
} from "./catalog-reconcile.js";

const dynamicRuntime = (runtimeFingerprint: string, source: "pi-ai" | "opencode-dynamic" = "opencode-dynamic") => ({
  endpoint: "https://opencode.ai/zen/v1/responses",
  api: "openai-responses" as const,
  baseUrl: "https://opencode.ai/zen/v1",
  contextWindow: 272000,
  maxTokens: 64000,
  reasoning: false as const,
  inputModalities: ["text"] as ["text"],
  source,
  runtimeFingerprint,
});

const candidate: OpenCodeCandidate = {
  parserVersion: "2",
  sourceHashes: { models: "models", pricing: "pricing" },
  observedModelIds: ["new-model", "peak-model", "unsupported-model", "unpriced-model"],
  unsupportedEndpointModelIds: ["unsupported-model"],
  unsupportedModelIds: ["unsupported-model"],
  unpricedRuntimeModelIds: ["unpriced-model"],
  models: [
    {
      id: "new-model",
      name: "New Model",
      baseRates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
      timeWindows: [],
      contextTiers: [{
        label: "over_200k",
        minContextTokens: 200001,
        maxContextTokens: null,
        rates: { input: 2, output: 3, cacheRead: 0.2, cacheWrite: 0 },
      }],
      runtime: dynamicRuntime("fingerprint-new"),
    },
    {
      id: "peak-model",
      name: "Peak Model",
      baseRates: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0 },
      timeWindows: [{
        label: "peak_1",
        startMinuteUtc: 60,
        endMinuteUtc: 240,
        rates: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0 },
      }],
      contextTiers: [],
      runtime: dynamicRuntime("fingerprint-peak", "pi-ai"),
    },
  ],
};

const current: CurrentCatalogState = {
  rates: [
    {
      id: "rate-peak",
      name: "Old Peak Model",
      modelId: "peak-model",
      providerPattern: "opencode",
      rates: { input: 0.02, output: 0.04, cacheRead: 0.002, cacheWrite: 0 },
      priority: 50,
      isActive: true,
    },
    {
      id: "rate-removed",
      name: "Removed",
      modelId: "removed-model",
      providerPattern: "opencode",
      rates: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      priority: 50,
      isActive: true,
    },
    {
      id: "rate-wildcard",
      name: "Wildcard",
      modelId: "claude-sonnet-%",
      providerPattern: "opencode",
      rates: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      priority: 1,
      isActive: true,
    },
    {
      id: "rate-unpriced",
      name: "Unpriced",
      modelId: "unpriced-model",
      providerPattern: "opencode",
      rates: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      priority: 50,
      isActive: true,
    },
  ],
  timeWindows: [],
  contextTiers: [],
  runtimes: [
    {
      id: "runtime-peak", provider: "opencode", modelId: "peak-model",
      source: "pi-ai", runtimeFingerprint: "fingerprint-peak", status: "active",
    },
    {
      id: "runtime-removed", provider: "opencode", modelId: "removed-model",
      source: "opencode-dynamic", runtimeFingerprint: "fingerprint-removed", status: "active",
    },
    {
      id: "runtime-unpriced", provider: "opencode", modelId: "unpriced-model",
      source: "opencode-dynamic", runtimeFingerprint: "fingerprint-unpriced", status: "active",
    },
  ],
};

describe("catalog reconciliation", () => {
  it("activates a fully priced unknown GPT model through synthesized runtime metadata", () => {
    const spark: OpenCodeCandidate = {
      parserVersion: "2",
      sourceHashes: { models: "models", pricing: "pricing" },
      observedModelIds: ["gpt-5.3-codex-spark"],
      unsupportedEndpointModelIds: [],
      unsupportedModelIds: [],
      unpricedRuntimeModelIds: [],
      models: [{
        id: "gpt-5.3-codex-spark",
        name: "GPT 5.3 Codex Spark",
        baseRates: { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 0 },
        timeWindows: [],
        contextTiers: [],
        runtime: dynamicRuntime("fingerprint-spark"),
      }],
    };
    const result = buildCatalogChangeSet(spark, {
      rates: [], timeWindows: [], contextTiers: [], runtimes: [],
    });
    expect(result.runtimeUpserts).toEqual([
      expect.objectContaining({ modelId: "gpt-5.3-codex-spark", status: "active" }),
    ]);
    expect(result.upserts).toEqual([
      expect.objectContaining({ modelId: "gpt-5.3-codex-spark" }),
    ]);
  });

  it("converts official per-million USD prices using the exact 0.07 factor", () => {
    expect(convertOfficialRates({ input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 }))
      .toEqual({ input: 0.0462, output: 0.1386, cacheRead: 0.00154, cacheWrite: 0 });
  });

  it("adds, updates, and deactivates exact rows while preserving wildcards", () => {
    const changeSet = buildCatalogChangeSet(candidate, current);

    expect(changeSet.upserts.map((mutation) => mutation.modelId)).toEqual(["new-model", "peak-model"]);
    expect(changeSet.runtimeUpserts.map((mutation) => mutation.modelId)).toEqual(["new-model"]);
    expect(changeSet.retireRuntimeIds).toEqual(["runtime-removed", "runtime-unpriced"]);
    expect(changeSet.deactivateRateIds).toEqual(["rate-removed", "rate-unpriced"]);
    expect(changeSet.changes.map((change) => [change.kind, change.modelId])).toEqual([
      ["dynamic_discovered", "new-model"],
      ["dynamic_activated", "new-model"],
      ["added", "new-model"],
      ["price_updated", "peak-model"],
      ["peak_updated", "peak-model"],
      ["dynamic_retired", "removed-model"],
      ["dynamic_retired", "unpriced-model"],
      ["deactivated", "removed-model"],
      ["deactivated", "unpriced-model"],
    ]);
    expect(changeSet.report.preservedWildcardModelIds).toEqual(["claude-sonnet-%"]);
    expect(changeSet.report.unsupportedEndpointModelIds).toEqual(["unsupported-model"]);
    expect(changeSet.report.unpricedRuntimeModelIds).toEqual(["unpriced-model"]);
    expect(changeSet.upserts[0]?.contextTiers[0]?.rates.input).toBe(0.14);
  });

  it("produces no mutations when persisted pricing already matches", () => {
    const desired = buildCatalogChangeSet(candidate, { rates: [], timeWindows: [], contextTiers: [], runtimes: [] });
    const matching: CurrentCatalogState = {
      rates: desired.upserts.map((model, index) => ({
        id: `rate-${index}`,
        name: model.name,
        modelId: model.modelId,
        providerPattern: "opencode",
        rates: model.rates,
        priority: 50,
        isActive: true,
      })),
      timeWindows: desired.upserts.flatMap((model, index) => model.timeWindows.map((window, windowIndex) => ({
        id: `window-${windowIndex}`,
        creditRateId: `rate-${index}`,
        ...window,
      }))),
      contextTiers: desired.upserts.flatMap((model, index) => model.contextTiers.map((tier, tierIndex) => ({
        id: `tier-${tierIndex}`,
        creditRateId: `rate-${index}`,
        creditRateTimeWindowId: null,
        ...tier,
      }))),
      runtimes: desired.runtimeUpserts.map((runtime, index) => ({
        id: `runtime-${index}`,
        provider: "opencode",
        modelId: runtime.modelId,
        source: runtime.source,
        runtimeFingerprint: runtime.runtimeFingerprint,
        status: "active",
      })),
    };

    const changeSet = buildCatalogChangeSet(candidate, matching);
    expect(changeSet.upserts).toEqual([]);
    expect(changeSet.deactivateRateIds).toEqual([]);
    expect(changeSet.runtimeUpserts).toEqual([]);
    expect(changeSet.retireRuntimeIds).toEqual([]);
    expect(changeSet.changes).toEqual([]);
  });

  it("keeps the same disabled fingerprint offline even when only pricing changes", () => {
    const oneModel = { ...candidate, models: [candidate.models[0]!], observedModelIds: ["new-model"] };
    const disabledState: CurrentCatalogState = {
      rates: [{
        id: "rate-new", name: "New Model", modelId: "new-model", providerPattern: "opencode",
        rates: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 }, priority: 50, isActive: false,
      }],
      timeWindows: [], contextTiers: [],
      runtimes: [{
        id: "runtime-new", provider: "opencode", modelId: "new-model",
        source: "opencode-dynamic", runtimeFingerprint: "fingerprint-new", status: "disabled",
      }],
    };
    const result = buildCatalogChangeSet(oneModel, disabledState);
    expect(result.runtimeUpserts).toEqual([]);
    expect(result.upserts).toEqual([]);
    expect(result.report.disabledRuntimeModelIds).toEqual(["new-model"]);
  });

  it("reenables a disabled dynamic model after its runtime fingerprint changes", () => {
    const oneModel = { ...candidate, models: [candidate.models[0]!], observedModelIds: ["new-model"] };
    const result = buildCatalogChangeSet(oneModel, {
      rates: [], timeWindows: [], contextTiers: [],
      runtimes: [{
        id: "runtime-new", provider: "opencode", modelId: "new-model",
        source: "opencode-dynamic", runtimeFingerprint: "old-fingerprint", status: "disabled",
      }],
    });
    expect(result.runtimeUpserts).toHaveLength(1);
    expect(result.changes).toContainEqual({ kind: "dynamic_reenabled", modelId: "new-model" });
  });

  it("lets a pi-ai built-in supersede a disabled synthesized definition", () => {
    const builtin = {
      ...candidate.models[0]!, runtime: dynamicRuntime("fingerprint-new", "pi-ai"),
    };
    const result = buildCatalogChangeSet(
      { ...candidate, models: [builtin], observedModelIds: [builtin.id] },
      {
        rates: [], timeWindows: [], contextTiers: [],
        runtimes: [{
          id: "runtime-new", provider: "opencode", modelId: builtin.id,
          source: "opencode-dynamic", runtimeFingerprint: "fingerprint-new", status: "disabled",
        }],
      },
    );
    expect(result.runtimeUpserts[0]).toMatchObject({ source: "pi-ai", status: "active" });
    expect(result.report.disabledRuntimeModelIds).toEqual([]);
  });

  it("persists runtime activation before its billable credit rate", async () => {
    const changeSet = buildCatalogChangeSet(
      { ...candidate, models: [candidate.models[0]!], observedModelIds: ["new-model"] },
      { rates: [], timeWindows: [], contextTiers: [], runtimes: [] },
    );
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("RETURNING id") ? [{ id: "rate-new" }] : [],
    }));

    await applyCatalogChangeSet({ query } as never, changeSet);

    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements.findIndex((sql) => sql.includes("INSERT INTO novel.model_runtime_catalog")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("INSERT INTO novel.credit_rates")));
  });

  it("deactivates special pricing before deactivating its base rates", async () => {
    const changeSet = buildCatalogChangeSet(candidate, current);
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("RETURNING id") ? [{ id: "rate-new" }] : [],
    }));

    await applyCatalogChangeSet({ query } as never, changeSet);

    const statements = query.mock.calls.map(([sql]) => sql);
    const tierIndex = statements.findIndex((sql) => sql.includes("UPDATE novel.credit_rate_context_tiers"));
    const windowIndex = statements.findIndex((sql) => sql.includes("UPDATE novel.credit_rate_time_windows"));
    const rateIndex = statements.findIndex((sql) => sql.includes("UPDATE novel.credit_rates")
      && sql.includes("is_active = false"));
    expect(tierIndex).toBeGreaterThanOrEqual(0);
    expect(windowIndex).toBeGreaterThanOrEqual(0);
    expect(tierIndex).toBeLessThan(rateIndex);
    expect(windowIndex).toBeLessThan(rateIndex);
    expect(query.mock.calls[tierIndex]?.[1]).toEqual([changeSet.deactivateRateIds]);
    expect(query.mock.calls[windowIndex]?.[1]).toEqual([changeSet.deactivateRateIds]);
  });

  it("manually reenables only the validated disabled fingerprint with pricing and one email", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE novel.model_runtime_catalog AS runtime")) return { rows: [{ id: "runtime-new" }] };
      if (sql.includes("FROM novel.model_runtime_catalog")) return { rows: [{
        id: "runtime-new", provider: "opencode", model_id: "new-model",
        source: "opencode-dynamic", runtime_fingerprint: "fingerprint-new", status: "active",
      }] };
      if (sql.includes("FROM novel.credit_rates")) return { rows: [{
        id: "rate-new", name: "New Model", model_pattern: "new-model", provider_pattern: "opencode",
        input_rate: 0.07, output_rate: 0.14, cache_read_rate: 0.007, cache_write_rate: 0,
        priority: 50, is_active: false,
      }] };
      return { rows: [] };
    });

    await expect(reenableOpenCodeModel(
      { query } as never,
      { ...candidate, models: [candidate.models[0]!] },
      "new-model",
      "ops@example.com",
    )).resolves.toBe(true);

    const statements = query.mock.calls.map(([sql]) => sql);
    const runtimeIndex = statements.findIndex((sql) => sql.includes("UPDATE novel.model_runtime_catalog AS runtime"));
    const rateIndex = statements.findIndex((sql) => sql.includes("UPDATE novel.credit_rates"));
    const emailIndex = statements.findIndex((sql) => sql.includes("INSERT INTO novel.system_email_outbox"));
    expect(runtimeIndex).toBeLessThan(rateIndex);
    expect(rateIndex).toBeLessThan(emailIndex);
    expect(query.mock.calls[runtimeIndex]?.[1]?.[9]).toBe("fingerprint-new");
  });

  it("does nothing when the disabled fingerprint no longer matches", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(reenableOpenCodeModel(
      { query } as never,
      { ...candidate, models: [candidate.models[0]!] },
      "new-model",
      "ops@example.com",
    )).resolves.toBe(false);
    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects duplicate exact model rows instead of choosing one", () => {
    expect(() => buildCatalogChangeSet(candidate, {
      ...current,
      rates: [...current.rates, { ...current.rates[0]!, id: "duplicate" }],
    })).toThrow("Duplicate exact OpenCode credit rate");
  });
});
