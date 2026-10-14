import { describe, expect, it, vi } from "vitest";
import type { ResolvedRuntimeModel } from "./model-resolver.js";
import { RuntimeModelHealthService } from "./health-service.js";

const dynamicResolved = (): ResolvedRuntimeModel => ({
  source: "opencode-dynamic",
  runtimeCatalogId: "runtime-1",
  runtimeFingerprint: "fingerprint",
  model: {
    id: "future-model", name: "Future", api: "openai-responses", provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272000, maxTokens: 64000,
  },
});

function setup(transitioned = true) {
  const repository = { disableRuntimeModel: vi.fn().mockResolvedValue(transitioned) };
  const resolver = { invalidate: vi.fn() };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const service = new RuntimeModelHealthService({
    repository,
    resolver,
    recipient: "ops@example.com",
    logger,
  });
  return { repository, resolver, logger, service };
}

describe("RuntimeModelHealthService", () => {
  it("ignores pi-ai built-ins and non-deterministic failures", async () => {
    const { service, repository } = setup();
    await service.observeFailure({ ...dynamicResolved(), source: "pi-ai" }, {
      status: 404, code: "model_not_found", message: "missing",
    }, "req-1");
    await service.observeFailure(dynamicResolved(), {
      status: 429, code: "rate_limit_exceeded", message: "busy",
    }, "req-2");
    expect(repository.disableRuntimeModel).not.toHaveBeenCalled();
  });

  it("atomically disables one exact deterministic fingerprint and invalidates its cache", async () => {
    const { service, repository, resolver, logger } = setup();
    const error = { status: 404, code: "model_not_found", message: "missing" };
    await Promise.all([
      service.observeFailure(dynamicResolved(), error, "req-1"),
      service.observeFailure(dynamicResolved(), error, "req-1"),
    ]);

    expect(repository.disableRuntimeModel).toHaveBeenCalledOnce();
    expect(repository.disableRuntimeModel).toHaveBeenCalledWith({
      provider: "opencode",
      modelId: "future-model",
      runtimeFingerprint: "fingerprint",
      classification: "model_not_found",
      errorCode: "model_not_found",
      errorSummary: "missing",
      requestId: "req-1",
      recipient: "ops@example.com",
    });
    expect(resolver.invalidate).toHaveBeenCalledWith("opencode", "future-model", "fingerprint");
    expect(logger.info).toHaveBeenCalledWith("dynamic_model_disabled", expect.objectContaining({
      modelId: "future-model", classification: "model_not_found",
    }));
  });

  it("does not invalidate when the fingerprint transition lost its race", async () => {
    const { service, resolver } = setup(false);
    await service.observeFailure(dynamicResolved(), {
      status: 400, code: "tools_not_supported", message: "tools unsupported",
    });
    expect(resolver.invalidate).not.toHaveBeenCalled();
  });

  it("contains database failures so the caller can preserve the original model error", async () => {
    const { service, repository, logger } = setup();
    repository.disableRuntimeModel.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(service.observeFailure(dynamicResolved(), {
      status: 404, code: "model_not_found", message: "missing",
    })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith("dynamic_model_disable_failed", expect.any(Object));
  });
});
