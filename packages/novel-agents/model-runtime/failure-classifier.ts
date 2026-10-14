export type DeterministicModelFailureCategory =
  | "model_not_found"
  | "tools_unsupported"
  | "api_unsupported"
  | "protocol_mismatch";

export type ModelFailureCategory = DeterministicModelFailureCategory | "unknown";

export interface ModelFailureClassification {
  deterministic: boolean;
  category: ModelFailureCategory;
  status: number | null;
  errorCode: string | null;
  summary: string;
}

const NON_DISABLING_CODES = new Set([
  "rate_limit_exceeded", "too_many_requests",
  "etimedout", "econnreset", "econnrefused", "enotfound", "eai_again", "abort_err",
  "invalid_api_key", "unauthorized", "forbidden",
  "insufficient_balance", "insufficient_quota", "payment_required", "user_insufficient_credits",
  "context_length_exceeded", "max_tokens_exceeded",
  "invalid_tool_schema", "invalid_request", "bad_request", "not_found",
]);

const DETERMINISTIC_CODES = new Map<string, DeterministicModelFailureCategory>([
  ["model_not_found", "model_not_found"],
  ["unknown_model", "model_not_found"],
  ["tools_not_supported", "tools_unsupported"],
  ["tool_use_not_supported", "tools_unsupported"],
  ["unsupported_tools", "tools_unsupported"],
  ["unsupported_api", "api_unsupported"],
  ["api_not_supported", "api_unsupported"],
  ["unsupported_endpoint", "api_unsupported"],
  ["protocol_mismatch", "protocol_mismatch"],
]);

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string" || value instanceof Error) {
    const message = typeof value === "string" ? value : value.message;
    const formatted = message.match(/^(?:OpenAI API error \((\d{3})\)|(\d{3})):\s*(\{.*\})$/s);
    if (formatted) {
      try {
        const body = JSON.parse(formatted[3]!) as unknown;
        const parsed = body && typeof body === "object" ? body as Record<string, unknown> : {};
        const nested = parsed.error && typeof parsed.error === "object"
          ? parsed.error as Record<string, unknown>
          : {};
        return { message, status: Number(formatted[1] ?? formatted[2]), ...parsed, ...nested };
      } catch {
        return { message };
      }
    }
    return { message };
  }
  if (!value || typeof value !== "object") return {};
  const outer = value as Record<string, unknown>;
  const nested = outer.error && typeof outer.error === "object"
    ? outer.error as Record<string, unknown>
    : {};
  return { ...outer, ...nested };
}

function normalizedCode(record: Record<string, unknown>): string | null {
  const raw = record.code ?? record.type ?? record.error_code;
  return typeof raw === "string"
    ? raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 80)
    : null;
}

function numericStatus(record: Record<string, unknown>): number | null {
  const raw = record.status ?? record.statusCode;
  const status = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(status) ? status : null;
}

function safeSummary(error: unknown, record: Record<string, unknown>): string {
  const raw = typeof record.message === "string"
    ? record.message
    : error instanceof Error
      ? error.message
      : String(error);
  return raw
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

export function classifyModelFailure(error: unknown): ModelFailureClassification {
  const record = asRecord(error);
  const status = numericStatus(record);
  const errorCode = normalizedCode(record);
  const summary = safeSummary(error, record);
  const unknown = (): ModelFailureClassification => ({
    deterministic: false,
    category: "unknown",
    status,
    errorCode,
    summary,
  });

  if (status === 401 || status === 402 || status === 403 || status === 429 || (status !== null && status >= 500)) {
    return unknown();
  }
  if (errorCode && NON_DISABLING_CODES.has(errorCode)) return unknown();

  let category = errorCode ? DETERMINISTIC_CODES.get(errorCode) : undefined;
  if (errorCode === "invalid_response_schema") {
    category = record.validatedProtocolMismatch === true ? "protocol_mismatch" : undefined;
  }
  if (!category) return unknown();

  return {
    deterministic: true,
    category,
    status,
    errorCode,
    summary,
  };
}
