export interface StructuredErrorEnvelope extends Record<string, unknown> {
  error: {
    code: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

const STABLE_ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;
const UPSTREAM_ERROR: StructuredErrorEnvelope = {
  error: {
    code: "UPSTREAM_ERROR",
    message: "The upstream service rejected the request",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function envelope(
  code: unknown,
  message: unknown,
  details: unknown,
): StructuredErrorEnvelope | null {
  if (typeof code !== "string" || !STABLE_ERROR_CODE.test(code)) return null;
  return {
    error: {
      code,
      ...(typeof message === "string" ? { message } : {}),
      ...(isRecord(details) ? { details } : {}),
    },
  };
}

export function normalizeUpstreamError(payload: unknown): StructuredErrorEnvelope {
  if (!isRecord(payload)) return UPSTREAM_ERROR;

  if (isRecord(payload.error)) {
    return envelope(payload.error.code, payload.error.message, payload.error.details)
      ?? UPSTREAM_ERROR;
  }

  const legacyCode = typeof payload.code === "string"
    ? payload.code
    : payload.error;
  return envelope(legacyCode, payload.message, payload.details) ?? UPSTREAM_ERROR;
}
