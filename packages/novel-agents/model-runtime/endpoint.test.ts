import { describe, expect, it } from "vitest";
import {
  parseOpenCodeEndpoint,
  runtimeFingerprint,
} from "./endpoint.js";

describe("parseOpenCodeEndpoint", () => {
  it.each([
    ["claude-sonnet-5", "https://opencode.ai/zen/v1/messages", {
      api: "anthropic-messages", contextWindow: 200_000, maxTokens: 64_000,
    }],
    ["gemini-3.7-flash", "https://opencode.ai/zen/v1/models/gemini-3.7-flash", {
      api: "google-generative-ai", contextWindow: 1_048_576, maxTokens: 65_536,
    }],
    ["gpt-5.6-sol", "https://opencode.ai/zen/v1/responses", {
      api: "openai-responses", contextWindow: 272_000, maxTokens: 64_000,
    }],
    ["deepseek-v4-pro", "https://opencode.ai/zen/v1/chat/completions", {
      api: "openai-completions", contextWindow: 128_000, maxTokens: 32_000,
    }],
  ])("maps %s through its documented protocol", (modelId, endpoint, expected) => {
    expect(parseOpenCodeEndpoint(modelId, endpoint)).toEqual({
      ...expected,
      endpoint,
      baseUrl: "https://opencode.ai/zen/v1",
      reasoning: false,
      inputModalities: ["text"],
    });
  });

  it.each([
    "http://opencode.ai/zen/v1/responses",
    "https://evil.example/zen/v1/responses",
    "https://opencode.ai/zen/v1/unknown",
    "https://opencode.ai/zen/v1/models/other-model",
    "https://opencode.ai/zen/v1/responses?override=1",
    "https://user@opencode.ai/zen/v1/responses",
    "https://opencode.ai/zen/v1/responses#override",
  ])("rejects an untrusted endpoint: %s", (endpoint) => {
    expect(() => parseOpenCodeEndpoint("gpt-5.6-sol", endpoint)).toThrow(
      "Unsupported OpenCode endpoint",
    );
  });
});

describe("runtimeFingerprint", () => {
  it("is stable and includes the protocol parser version", () => {
    const input = {
      modelId: "gpt-5.6-sol",
      endpoint: "https://opencode.ai/zen/v1/responses",
      api: "openai-responses" as const,
      parserVersion: "2",
    };
    expect(runtimeFingerprint(input)).toBe(
      "b1e183374f876876c27cebe20e1a136e8f18953b4a1280f0a713b14d5bcbcc2e",
    );
    expect(runtimeFingerprint({ ...input, parserVersion: "3" })).not.toBe(
      runtimeFingerprint(input),
    );
  });
});
