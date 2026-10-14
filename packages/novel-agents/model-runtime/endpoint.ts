import { createHash } from "node:crypto";
import type { RuntimeModelApi } from "./types.js";

const OPENCODE_ORIGIN = "https://opencode.ai";
const OPENCODE_BASE_URL = `${OPENCODE_ORIGIN}/zen/v1`;

export interface RuntimeDefaults {
  endpoint: string;
  api: RuntimeModelApi;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: false;
  inputModalities: ["text"];
}

export interface RuntimeFingerprintInput {
  modelId: string;
  endpoint: string;
  api: RuntimeModelApi;
  parserVersion: string;
}

function unsupported(endpoint: string): never {
  throw new Error(`Unsupported OpenCode endpoint: ${endpoint}`);
}

export function parseOpenCodeEndpoint(modelId: string, endpoint: string): RuntimeDefaults {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return unsupported(endpoint);
  }
  if (url.origin !== OPENCODE_ORIGIN
    || url.username
    || url.password
    || url.search
    || url.hash) {
    return unsupported(endpoint);
  }

  let api: RuntimeModelApi;
  let contextWindow: number;
  let maxTokens: number;
  if (url.pathname === "/zen/v1/messages") {
    api = "anthropic-messages";
    contextWindow = 200_000;
    maxTokens = 64_000;
  } else if (url.pathname === `/zen/v1/models/${encodeURIComponent(modelId)}`) {
    api = "google-generative-ai";
    contextWindow = 1_048_576;
    maxTokens = 65_536;
  } else if (url.pathname === "/zen/v1/responses") {
    api = "openai-responses";
    contextWindow = 272_000;
    maxTokens = 64_000;
  } else if (url.pathname === "/zen/v1/chat/completions") {
    api = "openai-completions";
    contextWindow = 128_000;
    maxTokens = 32_000;
  } else {
    return unsupported(endpoint);
  }

  return {
    endpoint: url.href,
    api,
    baseUrl: OPENCODE_BASE_URL,
    contextWindow,
    maxTokens,
    reasoning: false,
    inputModalities: ["text"],
  };
}

export function runtimeFingerprint(input: RuntimeFingerprintInput): string {
  return createHash("sha256").update(JSON.stringify({
    modelId: input.modelId,
    endpoint: input.endpoint,
    api: input.api,
    parserVersion: input.parserVersion,
  })).digest("hex");
}
