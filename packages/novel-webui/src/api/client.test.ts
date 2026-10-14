import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NovelApiClient } from "./client";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("NovelApiClient", () => {
  it("serializes verified registration requests", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(
      String(input).endsWith("/code") ? { accepted: true, retryAfterSeconds: 60 }
        : String(input).endsWith("/verify") ? { ticket: "ticket", expiresInSeconds: 900 }
          : { ok: true },
    ), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NovelApiClient();
    await client.sendRegistrationCode("u@example.com", "AB12CD34");
    await client.verifyRegistrationCode("u@example.com", "123456", "AB12CD34");
    await client.signup("u@example.com", "secret", "ticket", "AB12CD34");
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/registration/code", "/api/auth/registration/verify", "/api/auth",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      email: "u@example.com", code: "123456", inviteCode: "AB12CD34",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      email: "u@example.com", password: "secret", mode: "signup",
      registrationTicket: "ticket", inviteCode: "AB12CD34",
    });
  });

  it("serializes referral preview, dashboard, campaign update, and review requests", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(
      String(input).endsWith("/bindings") ? { items: [] } : {},
    ), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NovelApiClient();
    await client.getReferralPreview(" abcd2345 ");
    await client.getReferralDashboard();
    await client.updateReferralCampaign({ bindingEndsAt: "2026-09-01T00:00:00Z", reason: "extend" });
    await client.reviewReferralBinding("binding/1", "approve", "reviewed");
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/referrals/preview/ABCD2345", "/api/referrals/me", "/api/referrals/admin/campaign",
      "/api/referrals/admin/bindings/binding%2F1/approve",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      bindingEndsAt: "2026-09-01T00:00:00Z", reason: "extend",
    });
  });

  it("lists, creates, and revokes profile API tokens through the BFF", async () => {
    const token = {
      id: "token-1", public_id: "abcdefghijklmnop", user_id: "user-1", name: "Claude Desktop",
      scopes: ["projects:read"], expires_at: "2026-10-06T00:00:00.000Z", last_used_at: null,
      revoked_at: null, created_at: "2026-07-08T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ ...token, token: "lingqi_public_secret" }), { status: 201 });
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ tokens: [token] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new NovelApiClient();

    await expect(client.listApiTokens()).resolves.toEqual([token]);
    await expect(client.createApiToken({
      name: "Claude Desktop", lifetimeDays: 90, presets: ["read", "agent:run"],
    })).resolves.toEqual({ ...token, token: "lingqi_public_secret" });
    await expect(client.revokeApiToken("token/1")).resolves.toEqual({ ok: true });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/profile/tokens",
      "/api/profile/tokens",
      "/api/profile/tokens/token%2F1",
    ]);
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      name: "Claude Desktop", lifetimeDays: 90, presets: ["read", "agent:run"],
    });
    expect(fetchMock.mock.calls[2][1]).toEqual(expect.objectContaining({ method: "DELETE" }));
  });

  it("serializes profile updates and credit purchases", async () => {
    localStorage.setItem("novel-vibe:interface-locale", "zh-CN");
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(
      String(input).endsWith("/purchases")
        ? { orderNo: "NOVEL1", payUrl: "https://pay.test" }
        : { id: "user-1", email: "u@example.com", displayName: "墨白", avatarUrl: null },
    ), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NovelApiClient();
    await client.updateProfile({ displayName: "墨白", locale: "en" });
    await client.createCreditPurchase("pkg-1");
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/profile", "/api/credits/purchases"]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ displayName: "墨白", locale: "en" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ packageId: "pkg-1" });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("X-Interface-Locale")).toBe("zh-CN");
  });
  it("returns null for an unauthenticated user", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(new NovelApiClient().me()).resolves.toBeNull();
  });

  it("lists projects through the BFF", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      projects: [{ id: "project-1", title: "Novel" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new NovelApiClient().listProjects()).resolves.toEqual([{ id: "project-1", title: "Novel" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({
      credentials: "same-origin",
    }));
  });

  it("serializes project creative language for create and update", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      project: { id: "project-1", title: "English novel", creative_language: "en" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NovelApiClient();

    await client.createProject({ title: "English novel", creative_language: "en" });
    await client.updateProject("project-1", { creative_language: "zh-CN" });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      title: "English novel", creative_language: "en",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ creative_language: "zh-CN" });
  });

  it("lists models and maps provider+model fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      models: [
        { id: "glm-5", name: "GLM 5", provider: "opencode", input_rate: 70000, output_rate: 224000 },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(new NovelApiClient().listModels()).resolves.toEqual([
      { id: "opencode:glm-5", name: "GLM 5", provider: "opencode", model: "glm-5", inputRate: 70000, outputRate: 224000 },
    ]);
  });

  it("includes provider and model in the chat stream body when provided", async () => {
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return sseResponse(['data: {"version":1,"runId":"run-1","seq":1,"timestamp":1,"type":"run_finished","durationMs":0}\n\n']);
    }));

    await new NovelApiClient().streamChat(
      { projectId: "p1", message: "hi", sessionId: "s1", provider: "opencode", model: "glm-5" },
      () => {},
    );
    expect(requestBody).toMatchObject({ provider: "opencode", model: "glm-5" });
  });

  it("omits provider and model from the chat stream body when not set", async () => {
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return sseResponse(['data: {"version":1,"runId":"run-1","seq":1,"timestamp":1,"type":"run_finished","durationMs":0}\n\n']);
    }));

    await new NovelApiClient().streamChat(
      { projectId: "p1", message: "hi", sessionId: "s1" },
      () => {},
    );
    expect(requestBody).not.toHaveProperty("provider");
    expect(requestBody).not.toHaveProperty("model");
  });

  it("serializes a typed interaction response instead of a free-form message", async () => {
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return sseResponse(['data: {"version":1,"runId":"run-1","seq":1,"timestamp":1,"type":"interaction_resolved","interactionId":"interaction-1","answers":[],"freeAnswer":"Proceed"}\n\n', 'data: {"version":1,"runId":"run-1","seq":2,"timestamp":2,"type":"run_finished","durationMs":0}\n\n']);
    }));
    const events: string[] = [];
    await new NovelApiClient().streamChat({
      projectId: "p1",
      sessionId: "s1",
      interactionResponse: {
        schemaVersion: 1, interactionId: "interaction-1", idempotencyKey: "key-1", answers: [], freeAnswer: "Proceed",
      },
    }, (event) => events.push(event.type));
    expect(requestBody).toMatchObject({ interaction_response: expect.objectContaining({ interactionId: "interaction-1" }) });
    expect(requestBody).not.toHaveProperty("message");
    expect(events).toContain("interaction_resolved");
  });

  it("passes an AbortSignal to the chat stream request", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      'data: {"version":1,"runId":"run-1","seq":1,"timestamp":1,"type":"run_finished","durationMs":0}\n\n',
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await new NovelApiClient().streamChat(
      { projectId: "p1", message: "hi", sessionId: "s1" },
      () => {},
      { signal: controller.signal },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/stream",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("interrupts a session through the BFF", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ interrupted: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new NovelApiClient().interruptSession("session/1"))
      .resolves.toEqual({ interrupted: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session%2F1/interrupt",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("loads one Project for direct and archived routes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      project: { id: "project-1", title: "Novel", lifecycle_status: "archived" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new NovelApiClient().getProject("project/1")).resolves.toMatchObject({
      id: "project-1",
      lifecycle_status: "archived",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project%2F1", expect.any(Object));
  });

  it("scopes Project lists by lifecycle status and sends lifecycle commands", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const path = String(input);
      return new Response(JSON.stringify(
        path.includes("/archive")
          ? { project: { id: "project-1", lifecycle_status: "archived" } }
          : { projects: [] },
      ), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new NovelApiClient();

    await client.listProjects("archived");
    await client.archiveProject("project-1");
    await client.trashProject("project-1");
    await client.restoreProject("project-1");

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/projects?status=archived",
      "/api/projects/project-1/archive",
      "/api/projects/project-1/trash",
      "/api/projects/project-1/restore",
    ]);
    expect(fetchMock.mock.calls.slice(1).every(([, init]) => init?.method === "POST")).toBe(true);
  });

  it("preserves structured Project lifecycle conflicts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "RESOURCE_BUSY",
      message: "Project has a Session that is still processing",
      details: { sessionId: "session-1" },
    }), { status: 409, headers: { "Content-Type": "application/json" } })));

    await expect(new NovelApiClient().archiveProject("project-1")).rejects.toMatchObject({
      status: 409,
      data: { error: "RESOURCE_BUSY", details: { sessionId: "session-1" } },
    });
  });

  it("throws structured API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Nope" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(new NovelApiClient().request("/api/x")).rejects.toMatchObject({
      status: 403,
      message: "Nope",
      data: { error: "Nope" },
    });
  });

  it("normalizes the nested error contract into code and details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: "DOCUMENT_CONFLICT",
        message: "Do not render this server message",
        details: { current_hash: "hash-2", content: "# Remote" },
      },
    }), { status: 409, headers: { "Content-Type": "application/json" } })));

    await expect(new NovelApiClient().request("/api/x")).rejects.toMatchObject({
      status: 409,
      code: "DOCUMENT_CONFLICT",
      details: { current_hash: "hash-2", content: "# Remote" },
    });
  });

  it.each([
    [{ code: "PROJECT_READ_ONLY", message: "legacy coded", details: { projectId: "p1" } }, "PROJECT_READ_ONLY"],
    [{ error: "DOCUMENT_CONFLICT", message: "legacy conflict", details: { current_hash: "h2" } }, "DOCUMENT_CONFLICT"],
  ])("keeps compatibility with legacy API error shapes", async (body, code) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(new NovelApiClient().request("/api/x")).rejects.toMatchObject({
      code,
      details: body.details,
    });
  });

  it("keeps string and non-JSON error responses as unknown API errors", async () => {
    const client = new NovelApiClient();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify("upstream unavailable"), { status: 502 })));
    await expect(client.request("/api/string")).rejects.toMatchObject({ status: 502, code: null });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    await expect(client.request("/api/html")).rejects.toMatchObject({ status: 502, code: null });
  });

  it("reads a document source with its hash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      content: "# Chapter",
      hash: "hash-1",
      path: "text/chapter-001.md",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(new NovelApiClient().readDocument("project-1", "text/chapter-001.md"))
      .resolves.toEqual({ content: "# Chapter", hash: "hash-1", path: "text/chapter-001.md" });
  });

  it("saves a document with its base hash", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Response(
      JSON.stringify({ ok: true, changed: true, hash: "hash-2", path: "text/chapter-001.md", indexed: true, versionId: "v1", versionNo: 1 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new NovelApiClient().saveDocument(
      "project-1",
      "text/chapter-001.md",
      "# Updated",
      "hash-1",
    )).resolves.toMatchObject({ hash: "hash-2" });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      content: "# Updated",
      base_hash: "hash-1",
    });
  });

  it("reads encoded document history and diff pages", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/diff")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("/document-versions/")) return new Response(JSON.stringify({ id: "v1" }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new NovelApiClient();

    await api.listDocumentVersions("p1", "text/第一章.md", null, 20);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/documents/p1/text/%E7%AC%AC%E4%B8%80%E7%AB%A0.md/versions?limit=20");
    await api.getDocumentVersion("v1");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/document-versions/v1");
    await api.getDocumentVersionDiff("v1", "2", 10);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/document-versions/v1/diff?limit=10&cursor=2");
  });

  it("sends only the active document path as chat context", async () => {
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return sseResponse([
        'data: {"version":1,"runId":"run-1","seq":1,"timestamp":1,"type":"run_finished","durationMs":0}\n\n',
      ]);
    }));

    await new NovelApiClient().streamChat({
      projectId: "project-1",
      message: "继续",
      sessionId: "session-1",
      activeDocumentPath: "text/chapter-001.md",
    }, vi.fn());

    expect(requestBody).toMatchObject({
      project_id: "project-1",
      message: "继续",
      session_id: "session-1",
      active_document_path: "text/chapter-001.md",
    });
    expect(requestBody).not.toHaveProperty("content");
  });

  it("uses reviewed Skill draft APIs and structured creator commands", async () => {
    const calls: Array<{ path: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ path: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(input) === "/api/chat/stream") return sseResponse([
        'data: {"type":"turn_complete","turn_id":"t1","assistant_message_id":"a1"}\n\n',
      ]);
      return new Response(JSON.stringify(String(input).endsWith("/review")
        ? { draft: { id: "d1" }, review: { id: "r1" } }
        : { draft: { id: "d1" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const client = new NovelApiClient();
    await client.createSkillDraft({ source: "paste", slug: "style", content: "body", roles: ["writer"] });
    await client.reviewSkillDraft("d1", 1);
    await client.streamChat({ projectId: "p1", sessionId: "s1", message: "", command: "skill-creator" }, vi.fn());

    expect(calls[0]).toEqual({ path: "/api/skill-drafts", body: { source: "paste", slug: "style", content: "body", roles: ["writer"] } });
    expect(calls[1]).toEqual({ path: "/api/skill-drafts/d1/review", body: { version: 1 } });
    expect(calls[2].body).toMatchObject({ command: "skill-creator", project_id: "p1", session_id: "s1" });
  });

  it("lists project sessions with encoded cursor and search", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      items: [],
      nextCursor: null,
      activeSessionId: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await new NovelApiClient().listSessions("project/1", {
      cursor: "a+b/c=",
      limit: 20,
      search: "人物 关系",
      status: "archived",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project%2F1/sessions?limit=20&cursor=a%2Bb%2Fc%3D&search=%E4%BA%BA%E7%89%A9+%E5%85%B3%E7%B3%BB&status=archived",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("creates, opens, renames, archives, restores and deletes sessions", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      session: { id: "session-1", title: "新对话" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NovelApiClient();

    await client.createSession("project-1");
    await client.openSession("session-1");
    await client.renameSession("session-1", "人物线");
    await client.archiveSession("session-1");
    await client.restoreSession("session-1");
    await client.deleteSession("session-1");

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/projects/project-1/sessions",
      "/api/sessions/session-1",
      "/api/sessions/session-1",
      "/api/sessions/session-1",
      "/api/sessions/session-1",
      "/api/sessions/session-1",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ action: "open" });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ title: "人物线" });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({ action: "archive" });
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({ action: "restore" });
    expect(fetchMock.mock.calls[5]?.[1]).toEqual(expect.objectContaining({ method: "DELETE" }));
  });

  it("lists persisted messages with an encoded cursor", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      items: [], nextCursor: "next",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await new NovelApiClient().listSessionMessages("session/1", { cursor: "seq+1", limit: 50 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session%2F1/messages?limit=50&cursor=seq%2B1",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("parses structured chat stream errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "SESSION_BUSY",
      message: "Session is processing",
    }), { status: 409, headers: { "Content-Type": "application/json" } })));

    await expect(new NovelApiClient().streamChat({
      projectId: "project-1",
      sessionId: "session-1",
      message: "继续",
    }, vi.fn())).rejects.toMatchObject({
      status: 409,
      message: "SESSION_BUSY",
      data: { error: "SESSION_BUSY", message: "Session is processing" },
    });
  });

  it("parses versioned events split across chunks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      'data: {"version":1,"runId":"run-1","seq":1,"timestamp":1,"type":"run_sta',
      'rted"}\n\ndata: {"version":1,"runId":"run-1","seq":2,"timestamp":2,"type":"run_finished","durationMs":1}\n\n',
    ])));
    const events: unknown[] = [];

    await new NovelApiClient().streamChat(
      { projectId: "project-1", sessionId: "session-1", message: "hello" },
      (event) => events.push(event),
    );

    expect(events).toEqual([
      expect.objectContaining({ type: "run_started", seq: 1 }),
      expect.objectContaining({ type: "run_finished", seq: 2 }),
    ]);
  });

  it("ignores turn_started control frames without interrupting answer deltas", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      'data: {"type":"turn_started","session_id":"session-1","turn_id":"turn-server","assistant_message_id":"reply-server"}\n\n',
      'data: {"version":1,"runId":"run-1","seq":1,"timestamp":1,"type":"answer_delta","agentId":"chief_editor","delta":"你好"}\n\n',
      'data: {"version":1,"runId":"run-1","seq":2,"timestamp":2,"type":"run_finished","durationMs":1}\n\n',
      'data: {"type":"turn_complete","turn_id":"turn-server","assistant_message_id":"reply-server"}\n\n',
    ])));
    const events: unknown[] = [];

    await expect(new NovelApiClient().streamChat(
      { projectId: "project-1", sessionId: "session-1", message: "hello" },
      (event) => events.push(event),
    )).resolves.toEqual({ turnId: "turn-server", assistantMessageId: "reply-server" });

    expect(events).toEqual([
      expect.objectContaining({ type: "answer_delta", delta: "你好" }),
      expect.objectContaining({ type: "run_finished", seq: 2 }),
    ]);
  });

  it("returns the canonical turn and assistant message identifiers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      'data: {"version":1,"runId":"run-1","seq":1,"timestamp":1,"type":"run_finished","durationMs":0}\n\n',
      'data: {"type":"turn_complete","turn_id":"turn-server","assistant_message_id":"reply-server"}\n\n',
    ])));

    await expect(new NovelApiClient().streamChat(
      { projectId: "project-1", sessionId: "session-1", message: "hello" },
      vi.fn(),
    )).resolves.toEqual({ turnId: "turn-server", assistantMessageId: "reply-server" });
  });

  it("rejects a stream that ends without a terminal event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      'data: {"version":1,"runId":"run-1","seq":1,"timestamp":1,"type":"run_started"}\n\n',
    ])));

    await expect(new NovelApiClient().streamChat(
      { projectId: "project-1", sessionId: "session-1", message: "hello" },
      vi.fn(),
    )).rejects.toThrow("Chat stream ended before a terminal event");
  });

  it("rejects malformed JSON and unsupported protocol versions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(['data: {broken}\n\n'])));
    await expect(new NovelApiClient().streamChat(
      { projectId: "project-1", sessionId: "session-1", message: "hello" },
      vi.fn(),
    )).rejects.toBeInstanceOf(SyntaxError);

    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      'data: {"version":2,"runId":"run-1","seq":1,"timestamp":1,"type":"run_finished","durationMs":0}\n\n',
    ])));
    await expect(new NovelApiClient().streamChat(
      { projectId: "project-1", sessionId: "session-1", message: "hello" },
      vi.fn(),
    )).rejects.toThrow("Unsupported chat stream version: 2");
  });

  describe("streamChat retry", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("retries a transient TypeError then succeeds, without spurious onEvent", async () => {
      let chatCalls = 0;
      vi.stubGlobal("fetch", vi.fn(async () => {
        chatCalls += 1;
        if (chatCalls === 1) throw new TypeError("Failed to fetch");
        return sseResponse([
          'data: {"type":"turn_complete","turn_id":"t1","assistant_message_id":"a1"}\n\n',
        ]);
      }));

      const onEvent = vi.fn();
      const promise = new NovelApiClient().streamChat(
        { projectId: "p1", message: "hi", sessionId: "s1" },
        onEvent,
      );
      // Drive past the retry backoff(s): a 500ms base sleep precedes attempt 2.
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;

      expect(result).toEqual({ turnId: "t1", assistantMessageId: "a1" });
      expect(chatCalls).toBe(2);
      expect(onEvent).not.toHaveBeenCalled(); // no events ever emitted
    });

    it("gives up after MAX_ATTEMPTS consecutive TypeError failures", async () => {
      const fetchMock = vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      });
      vi.stubGlobal("fetch", fetchMock);

      const promise = new NovelApiClient().streamChat(
        { projectId: "p1", message: "hi", sessionId: "s1" },
        vi.fn(),
      );
      // Attach the rejection handler before driving the fake clock so the
      // asynchronously-settled rejection is never briefly "unhandled".
      const assertion = expect(promise).rejects.toThrow("Failed to fetch");
      // Advance through all retry backoffs (500 + 1000 + 2000 ms).
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("retries 5xx responses then succeeds on a later attempt", async () => {
      const ok = sseResponse(['data: {"type":"turn_complete","turn_id":"t1","assistant_message_id":"a1"}\n\n']);
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "upstream down" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }));
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "upstream down" }), {
          status: 503, headers: { "Content-Type": "application/json" },
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "upstream down" }), {
          status: 503, headers: { "Content-Type": "application/json" },
        }))
        .mockResolvedValueOnce(ok);
      vi.stubGlobal("fetch", fetchMock);

      const promise = new NovelApiClient().streamChat(
        { projectId: "p1", message: "hi", sessionId: "s1" },
        vi.fn(),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;
      expect(result).toEqual({ turnId: "t1", assistantMessageId: "a1" });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("does NOT retry 401 (notifies unauthorized immediately)", async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      }));
      vi.stubGlobal("fetch", fetchMock);
      const dispatched = vi.fn();
      window.addEventListener("novel-vibe:unauthorized", dispatched);

      await expect(new NovelApiClient().streamChat(
        { projectId: "p1", message: "hi", sessionId: "s1" },
        vi.fn(),
      )).rejects.toMatchObject({ status: 401 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(dispatched).toHaveBeenCalledTimes(1);
      window.removeEventListener("novel-vibe:unauthorized", dispatched);
    });

    it("does NOT retry when the stream breaks after data was received", async () => {
      // A stream that delivers one frame and then closes cleanly WITHOUT a
      // terminal event. Data was received, so this is a mid-stream situation:
      // it must surface ChatStreamInterruptedError rather than replaying the
      // (already partially-processed) request.
      vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
        'data: {"version":1,"runId":"run-1","seq":1,"timestamp":1,"type":"run_started"}\n\n',
      ])));

      const onEvent = vi.fn();
      await expect(new NovelApiClient().streamChat(
        { projectId: "p1", message: "hi", sessionId: "s1" },
        onEvent,
      )).rejects.toThrow("Chat stream ended before a terminal event");
      // The frame was processed before the stream died.
      expect(onEvent).toHaveBeenCalledTimes(1);
    });
  });

  it("serializes community kind filters and admin actions", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NovelApiClient();

    await client.listCommunityArticles({
      kind: "feature_request",
      sort: "ranked",
      search: "模型",
      featured: true,
      tag: "工具工作流",
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/community/articles?kind=feature_request&tag=%E5%B7%A5%E5%85%B7%E5%B7%A5%E4%BD%9C%E6%B5%81&sort=ranked&search=%E6%A8%A1%E5%9E%8B&featured=true");

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await client.setCommunityArticleFeatured("a/1", true);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/community/articles/a%2F1/feature");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await client.updateCommunityFeedbackStatus("r1", "planned");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/community/articles/r1/feedback-status");
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "PATCH" });
  });
});
