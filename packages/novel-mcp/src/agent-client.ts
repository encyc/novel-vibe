export class AgentApiError extends Error {
  constructor(public readonly status: number, public readonly payload: unknown) {
    super(`Agent API request failed (${status})`);
  }
}

export class AgentClient {
  constructor(private readonly baseUrl: string) {}

  async request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const text = await response.text();
      let payload: unknown = { error: text };
      try { payload = JSON.parse(text); } catch { /* retain redacted text payload */ }
      throw new AgentApiError(response.status, payload);
    }
    return response.json() as Promise<T>;
  }

  async export(token: string, path: string): Promise<{ contentType: string; data: string }> {
    const response = await fetch(`${this.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new AgentApiError(response.status, { error: "Export failed" });
    return {
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      data: Buffer.from(await response.arrayBuffer()).toString("base64"),
    };
  }

  async startAgentRun(token: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      let payload: unknown = { error: text || "Agent run failed to start" };
      try { payload = JSON.parse(text); } catch { /* retain redacted text payload */ }
      throw new AgentApiError(response.status, payload);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let failureMessage: string | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (event.type === "turn_started") {
          // The turn keeps running server-side after disconnect; release the
          // socket instead of holding it for the whole generation.
          await reader.cancel().catch(() => {});
          return event;
        }
        if (event.type === "run_failed" && typeof event.message === "string") {
          failureMessage = event.message;
        }
      }
    }
    throw new Error(failureMessage ?? "Agent run ended before it started");
  }
}
