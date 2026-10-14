import { detectBrowserLocale, readStoredLocale } from "../i18n/locale";

export class ApiError extends Error {
  public readonly code: string | null;
  public readonly details: unknown;

  constructor(
    public readonly status: number,
    public readonly data: unknown,
  ) {
    const record = data && typeof data === "object" ? data as Record<string, unknown> : null;
    const nestedError = record?.error && typeof record.error === "object"
      ? record.error as Record<string, unknown>
      : null;
    const code = typeof nestedError?.code === "string"
      ? nestedError.code
      : typeof record?.code === "string"
        ? record.code
        : typeof record?.error === "string" && /^[A-Z][A-Z0-9_]+$/.test(record.error)
          ? record.error
          : null;
    const details = nestedError && "details" in nestedError ? nestedError.details : record?.details;
    const message = typeof nestedError?.message === "string"
      ? nestedError.message
      : typeof record?.error === "string"
          ? record.error
          : typeof record?.message === "string"
            ? record.message
            : typeof data === "string"
              ? data
              : `Request failed with ${status}`;
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

export class ChatStreamInterruptedError extends Error {
  constructor() {
    super("Chat stream ended before a terminal event");
    this.name = "ChatStreamInterruptedError";
  }
}

export function notifyUnauthorized() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("novel-vibe:unauthorized"));
  }
}

export function isRetryableFetchError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return false;
  return err instanceof TypeError;
}

export function sleepWithJitter(baseMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, baseMs + Math.random() * 200));
}

export async function parseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    throw new ApiError(res.status, data);
  }

  return data as T;
}

export function interfaceLocaleHeaders(initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  headers.set("X-Interface-Locale", readStoredLocale() ?? detectBrowserLocale());
  return headers;
}
