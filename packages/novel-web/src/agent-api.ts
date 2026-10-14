import { normalizeUpstreamError } from "./upstream-error.js";

export class AgentApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: Record<string, unknown>,
  ) {
    super(typeof payload.error === "string" ? payload.error : `Agent request failed: ${status}`);
    this.name = "AgentApiError";
  }
}

function parseErrorPayload(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return normalizeUpstreamError(parsed);
  } catch {
    // Fall through to the text response.
  }
  return normalizeUpstreamError(null);
}

export class AgentApi {
  constructor(private readonly baseUrl: string) {}

  async requestAnonymous<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, init);
    if (!res.ok) {
      const text = await res.text();
      throw new AgentApiError(res.status, parseErrorPayload(text));
    }
    return await res.json() as T;
  }

  async request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    return (await this.requestWithStatus<T>(token, path, init)).data;
  }

  async requestWithStatus<T>(
    token: string,
    path: string,
    init: RequestInit = {},
  ): Promise<{ data: T; status: number }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        // An empty token means "local mode": the request must reach the agent
        // server WITHOUT an Authorization header so its local issuer injects
        // the local identity. A hosted caller always passes a real token.
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new AgentApiError(res.status, parseErrorPayload(text));
    }

    return { data: await res.json() as T, status: res.status };
  }
}
