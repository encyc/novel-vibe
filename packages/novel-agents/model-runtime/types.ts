export type RuntimeModelApi =
  | "anthropic-messages"
  | "google-generative-ai"
  | "openai-responses"
  | "openai-completions";

export type RuntimeModelStatus = "active" | "disabled" | "retired";
export type RuntimeModelSource = "pi-ai" | "opencode-dynamic";

export interface RuntimeModelRow {
  id: string;
  provider: string;
  modelId: string;
  name: string;
  api: RuntimeModelApi;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  inputModalities: string[];
  source: RuntimeModelSource;
  runtimeFingerprint: string;
  sourceHashes: Record<string, unknown>;
  status: RuntimeModelStatus;
  disabledReason: string | null;
  disabledAt: string | null;
  lastSeenAt: string;
}

export interface RuntimeModelApiRow {
  id: string;
  provider: string;
  model_id: string;
  name: string;
  api: RuntimeModelApi;
  base_url: string;
  context_window: number;
  max_tokens: number;
  reasoning: boolean;
  input_modalities: string[];
  source: RuntimeModelSource;
  runtime_fingerprint: string;
  source_hashes: Record<string, unknown> | null;
  status: RuntimeModelStatus;
  disabled_reason: string | null;
  disabled_at: string | null;
  last_seen_at: string;
}

export interface DisableRuntimeModelInput {
  provider: string;
  modelId: string;
  runtimeFingerprint: string;
  classification: string;
  errorCode?: string | null;
  errorSummary: string;
  requestId?: string | null;
  recipient?: string | null;
}

export function mapRuntimeModelRow(row: RuntimeModelApiRow): RuntimeModelRow {
  return {
    id: row.id,
    provider: row.provider,
    modelId: row.model_id,
    name: row.name,
    api: row.api,
    baseUrl: row.base_url,
    contextWindow: row.context_window,
    maxTokens: row.max_tokens,
    reasoning: row.reasoning,
    inputModalities: row.input_modalities,
    source: row.source,
    runtimeFingerprint: row.runtime_fingerprint,
    sourceHashes: row.source_hashes ?? {},
    status: row.status,
    disabledReason: row.disabled_reason,
    disabledAt: row.disabled_at,
    lastSeenAt: row.last_seen_at,
  };
}
