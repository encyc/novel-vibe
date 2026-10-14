import { describe, beforeEach } from "vitest";
import { createDbTestContext } from "./test-kit.js";

let ctx: ReturnType<typeof createDbTestContext>;

beforeEach(() => {
  ctx = createDbTestContext();
});

describe("dynamic model runtime operations", () => {
    it("reads and maps one runtime model by provider and model id", async () => {
      ctx.mockOkRaw([{
        id: "runtime-1",
        provider: "opencode",
        model_id: "gpt-5.6-sol",
        name: "GPT 5.6 Sol",
        api: "openai-responses",
        base_url: "https://opencode.ai/zen/v1",
        context_window: 272000,
        max_tokens: 64000,
        reasoning: false,
        input_modalities: ["text"],
        source: "opencode-dynamic",
        runtime_fingerprint: "sha256:runtime",
        source_hashes: { models: "sha256:models" },
        status: "active",
        disabled_reason: null,
        disabled_at: null,
        last_seen_at: "2026-08-18T00:00:00.000Z",
      }]);

      await expect(ctx.db.getRuntimeModel("opencode", "gpt-5.6-sol")).resolves.toMatchObject({
        modelId: "gpt-5.6-sol",
        baseUrl: "https://opencode.ai/zen/v1",
        contextWindow: 272000,
        maxTokens: 64000,
        runtimeFingerprint: "sha256:runtime",
        status: "active",
      });
      expect(String(ctx.fetchMock.mock.calls[0][0])).toContain(
        "/model_runtime_catalog?provider=eq.opencode&model_id=eq.gpt-5.6-sol&limit=1",
      );
    });

    it("returns null when no runtime model matches", async () => {
      ctx.mockOkRaw([]);
      await expect(ctx.db.getRuntimeModel("opencode", "missing/model")).resolves.toBeNull();
      expect(String(ctx.fetchMock.mock.calls[0][0])).toContain("model_id=eq.missing%2Fmodel");
    });

    it("uses the atomic disable RPC and returns whether it transitioned", async () => {
      ctx.mockOkRaw(true);
      await expect(ctx.db.disableRuntimeModel({
        provider: "opencode",
        modelId: "gpt-5.6-sol",
        runtimeFingerprint: "sha256:runtime",
        classification: "model_not_found",
        errorCode: "404",
        errorSummary: "upstream rejected the configured model",
        requestId: "req-1",
        recipient: "ops@example.com",
      })).resolves.toBe(true);

      const [url, options] = ctx.fetchMock.mock.calls[0];
      expect(String(url)).toContain("/rpc/disable_dynamic_model");
      expect(JSON.parse(options.body)).toEqual({
        p_provider: "opencode",
        p_model_id: "gpt-5.6-sol",
        p_runtime_fingerprint: "sha256:runtime",
        p_classification: "model_not_found",
        p_error_code: "404",
        p_error_summary: "upstream rejected the configured model",
        p_request_id: "req-1",
        p_recipient: "ops@example.com",
      });
    });
  });
