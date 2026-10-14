import { describe, expect, it, vi } from "vitest";
import { BYOK_PROVIDER_PREFIX, mergeByokModels } from "./settings.js";

const byokConfig = {
  enabled: true,
  providers: [
    { id: "deepseek", label: "DeepSeek", models: [{ id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128000 }] },
  ],
};

describe("mergeByokModels", () => {
  const platform = [{ id: "m1", name: "M1", provider: "deepseek", model: "m1" }];

  it("appends byok models only for entitled members with a saved key", () => {
    const merged = mergeByokModels(platform, byokConfig, [{ provider: "deepseek" }], true);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      provider: `${BYOK_PROVIDER_PREFIX}deepseek`,
      model: "deepseek-chat",
      providerLabel: "DeepSeek",
    });
  });

  it("omits providers without a saved key", () => {
    expect(mergeByokModels(platform, byokConfig, [], true)).toHaveLength(1);
  });

  it("omits everything for non-members", () => {
    expect(mergeByokModels(platform, byokConfig, [{ provider: "deepseek" }], false)).toHaveLength(1);
  });

  it("no-ops when byok is disabled", () => {
    expect(mergeByokModels(platform, { enabled: false, providers: [] }, [{ provider: "deepseek" }], true)).toHaveLength(1);
  });

  it("leaves platform models untouched", () => {
    const merged = mergeByokModels(platform, byokConfig, [{ provider: "deepseek" }], true);
    expect(merged[0]).toBe(platform[0]);
  });

  it("does not list a model twice when the platform list already offers it", () => {
    // Local mode: /api/models returns the BYOK catalog, so `listModels` maps it to the
    // same `byok-<provider>:<model>` id this merge would build. Before the filter the
    // selector showed every model twice and rendered a duplicate list key.
    const alreadyByok: typeof platform = [{
      id: `${BYOK_PROVIDER_PREFIX}deepseek:deepseek-chat`,
      name: "DeepSeek Chat",
      provider: `${BYOK_PROVIDER_PREFIX}deepseek`,
      model: "deepseek-chat",
    }];

    const merged = mergeByokModels(alreadyByok, byokConfig, [{ provider: "deepseek" }], true);

    expect(merged).toHaveLength(1);
    expect(new Set(merged.map((model) => model.id)).size).toBe(merged.length);
  });

  it("still appends byok models that the platform list does not offer", () => {
    const unrelated: typeof platform = [{ id: "deepseek:m1", name: "M1", provider: "deepseek", model: "m1" }];

    const merged = mergeByokModels(unrelated, byokConfig, [{ provider: "deepseek" }], true);

    expect(merged).toHaveLength(2);
    expect(merged[1]?.id).toBe(`${BYOK_PROVIDER_PREFIX}deepseek:deepseek-chat`);
  });
});
