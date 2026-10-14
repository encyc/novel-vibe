import type { DocumentIndexRow } from "../types.ts";

export class BffError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(`BFF ${status} ${code}: ${message}`);
  }
}

export interface ProjectDto {
  id: string;
  title?: string;
}

export interface SessionDto {
  id: string;
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

export class BffClient {
  private cookie: string | null = null;

  constructor(
    private readonly bffUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async login(email: string, password: string): Promise<void> {
    const res = await this.fetchImpl(`${this.bffUrl}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, mode: "login" }),
    });
    if (!res.ok) {
      throw await this.toError(res);
    }
    const raw = this.readSetCookie(res);
    if (!raw) {
      throw new BffError(res.status, "NO_SESSION_COOKIE", "login response carried no session cookie");
    }
    this.cookie = raw.split(";")[0] ?? null;
  }

  get authenticated(): boolean {
    return this.cookie !== null;
  }

  async createProject(input: { title: string; genre: string; synopsis: string }): Promise<ProjectDto> {
    const body = await this.requestJson("POST", "/api/projects", input);
    return body.project as ProjectDto;
  }

  async createSession(projectId: string): Promise<SessionDto> {
    const body = await this.requestJson("POST", `/api/projects/${projectId}/sessions`, {});
    return body.session as SessionDto;
  }

  async listDocuments(projectId: string, docType?: string): Promise<DocumentIndexRow[]> {
    const suffix = docType ? `?type=${encodeURIComponent(docType)}` : "";
    const body = await this.requestJson("GET", `/api/documents/${projectId}${suffix}`);
    return (body.documents ?? []) as DocumentIndexRow[];
  }

  async readDocument(projectId: string, docPath: string): Promise<string> {
    const body = await this.requestJson("GET", `/api/documents/${projectId}/${this.encodePath(docPath)}`);
    return body.content as string;
  }

  async writeDocument(projectId: string, docPath: string, content: string): Promise<void> {
    await this.requestJson("PUT", `/api/documents/${projectId}/${this.encodePath(docPath)}`, {
      content,
      base_hash: "",
    });
  }

  async creditsActivity(): Promise<Array<{ date: string; creditsConsumed: number; totalTokens: number }>> {
    const year = new Date().getFullYear();
    const body = await this.requestJson("GET", `/api/credits/activity?year=${year}&timezone=Asia/Shanghai`);
    return (body.days ?? []) as Array<{ date: string; creditsConsumed: number; totalTokens: number }>;
  }

  /** Trash then permanently delete a project (bench cleanup). */
  async trashProject(projectId: string): Promise<void> {
    await this.requestJson("POST", `/api/projects/${projectId}/trash`, {});
    await this.requestJson("DELETE", `/api/projects/${projectId}/permanent`, {});
  }

  /** Issue an SSE chat turn; returns the raw Response for stream consumption. */
  async chatStream(
    input: {
      projectId: string;
      sessionId: string;
      message: string;
      provider?: string;
      model?: string;
    },
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.fetchImpl(`${this.bffUrl}/api/chat/stream`, {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        project_id: input.projectId,
        session_id: input.sessionId,
        message: input.message,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
      }),
    });
  }

  private encodePath(docPath: string): string {
    return docPath.split("/").map(encodeURIComponent).join("/");
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cookie) {
      headers.cookie = this.cookie;
    }
    return headers;
  }

  private readSetCookie(res: Response): string | null {
    const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
    if (typeof anyHeaders.getSetCookie === "function") {
      const list = anyHeaders.getSetCookie();
      return list.find((c) => c.length > 0) ?? null;
    }
    return res.headers.get("set-cookie");
  }

  private async toError(res: Response): Promise<BffError> {
    let code = "HTTP_ERROR";
    let message = `status ${res.status}`;
    try {
      const body = (await res.json()) as ErrorBody;
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // keep defaults
    }
    return new BffError(res.status, code, message);
  }

  private async requestJson(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.bffUrl}${path}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw await this.toError(res);
    }
    return (await res.json()) as Record<string, unknown>;
  }
}
