import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandler } from "./server.js";
import type { ApiScope } from "../../novel-agents/auth/scopes.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

const ALL_SCOPES: ApiScope[] = ["projects:read", "documents:read", "documents:write", "documents:export", "sessions:read", "sessions:write", "billing:read", "skills:read", "agents:run"];

async function listen(authenticated: boolean, agentServerUrl = "http://127.0.0.1:1", scopes: Set<ApiScope> = new Set(ALL_SCOPES)) {
  const server = createServer(createMcpHandler({
    agentServerUrl,
    authenticator: { authenticate: async () => authenticated ? {
      principal: {
        userId: "user-1", authType: "api_token" as const, tokenId: "token-1",
        scopes,
      },
      delegatedToken: "delegated-jwt",
    } : null },
  }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return new URL(`http://127.0.0.1:${port}/mcp`);
}

function makeCall(url: URL) {
  return async (body: unknown) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer lingqi_public_secret", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    expect({ status: response.status, text }).toEqual(expect.objectContaining({ status: 200 }));
    const data = text.startsWith("event:")
      ? JSON.parse(text.split("\n").find((line) => line.startsWith("data: "))!.slice(6))
      : JSON.parse(text);
    return data;
  };
}

async function startUpstream(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
  const upstream = createServer(handler);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  servers.push(upstream);
  return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
}

function sseUpstream(onRequest: (body: Record<string, unknown>) => void, sseFrame: string) {
  return startUpstream((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk; });
    req.on("end", () => {
      onRequest(body ? JSON.parse(body) : {});
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sseFrame);
    });
  });
}

const HANDSHAKE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };

describe("remote MCP server", () => {
  it("rejects missing or invalid bearer credentials", async () => {
    const url = await listen(false);
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "AUTH_INVALID" });
  });

  it("initializes and exposes application tools only", async () => {
    const url = await listen(true);
    const call = makeCall(url);
    await call(HANDSHAKE);
    const toolsResult = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = toolsResult.result.tools as Array<{ name: string }>;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["list_projects", "read_document", "write_document", "list_sessions", "run_agent"]));
    expect(names).not.toEqual(expect.arrayContaining(["read_doc", "write_doc", "delete_doc", "delegate_to_agent", "load_skill"]));
  });

  it("respond_interaction posts the interaction envelope and waits for the turn", async () => {
    const received: Array<Record<string, unknown>> = [];
    const upstreamUrl = await sseUpstream(
      (body) => received.push(body),
      `data: ${JSON.stringify({ type: "turn_started", turn_id: "t9", assistant_message_id: "m9" })}\n\n`,
    );
    const url = await listen(true, upstreamUrl);
    const call = makeCall(url);
    await call(HANDSHAKE);
    const out = await call({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "respond_interaction", arguments: {
      projectId: "p1", sessionId: "s1", interactionId: "i1",
      answers: [{ fieldId: "f1", type: "radio", value: "opt-a" }],
    } } });
    expect(out.result.isError).toBeFalsy();
    expect(received[0]).toMatchObject({
      project_id: "p1", session_id: "s1",
      interaction_response: { schemaVersion: 1, interactionId: "i1", answers: [{ fieldId: "f1", type: "radio", value: "opt-a" }] },
    });
    const envelope = received[0].interaction_response as Record<string, unknown>;
    expect(typeof envelope.idempotencyKey).toBe("string");
  });

  it("list_pending_interactions flattens pending entries from the recent message window", async () => {
    const upstreamUrl = await startUpstream((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: [
        { id: "m1", interactions: [{ id: "i1", status: "pending", request: { question: "选一个" } }] },
        { id: "m2", interactions: [{ id: "i2", status: "answered", request: {} }] },
      ] }));
    });
    const url = await listen(true, upstreamUrl);
    const call = makeCall(url);
    await call(HANDSHAKE);
    const out = await call({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "list_pending_interactions", arguments: { sessionId: "s1" } } });
    expect(out.result.isError).toBeFalsy();
    expect(out.result.structuredContent).toEqual({ interactions: [
      { id: "i1", assistantMessageId: "m1", status: "pending", request: { question: "选一个" } },
    ] });
  });

  it("interrupt_session posts to the interrupt endpoint", async () => {
    const hits: Array<{ method: string; url: string }> = [];
    const upstreamUrl = await startUpstream((req, res) => {
      hits.push({ method: req.method ?? "", url: req.url ?? "" });
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "interrupted" }));
    });
    const url = await listen(true, upstreamUrl);
    const call = makeCall(url);
    await call(HANDSHAKE);
    const out = await call({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "interrupt_session", arguments: { sessionId: "s1" } } });
    expect(out.result.isError).toBeFalsy();
    expect(hits[0]).toEqual({ method: "POST", url: "/api/sessions/s1/interrupt" });
  });

  it("set_session_status posts the archive action", async () => {
    const hits: Array<{ method: string; url: string }> = [];
    const upstreamUrl = await startUpstream((req, res) => {
      hits.push({ method: req.method ?? "", url: req.url ?? "" });
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ session: { id: "s1" } }));
    });
    const url = await listen(true, upstreamUrl);
    const call = makeCall(url);
    await call(HANDSHAKE);
    const out = await call({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "set_session_status", arguments: { sessionId: "s1", action: "archive" } } });
    expect(out.result.isError).toBeFalsy();
    expect(hits[0]).toEqual({ method: "POST", url: "/api/sessions/s1/archive" });
  });

  it("list_document_versions hits the encoded versions path", async () => {
    const hits: Array<{ url: string }> = [];
    const upstreamUrl = await startUpstream((req, res) => {
      hits.push({ url: req.url ?? "" });
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: [], cursor: null }));
    });
    const url = await listen(true, upstreamUrl);
    const call = makeCall(url);
    await call(HANDSHAKE);
    const out = await call({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "list_document_versions", arguments: { projectId: "p1", path: "novels/世界 观/worldview.md", limit: 5 } } });
    expect(out.result.isError).toBeFalsy();
    expect(hits[0]?.url).toBe("/api/documents/p1/novels/%E4%B8%96%E7%95%8C%20%E8%A7%82/worldview.md/versions?limit=5");
  });

  it("get_document_version_diff surfaces the repairable 409 as a structured tool error", async () => {
    const upstreamUrl = await startUpstream((req, res) => {
      req.resume();
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "DOCUMENT_DIFF_UNAVAILABLE", repairable: true }));
    });
    const url = await listen(true, upstreamUrl);
    const call = makeCall(url);
    await call(HANDSHAKE);
    const out = await call({ jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "get_document_version_diff", arguments: { versionId: "v1" } } });
    expect(out.result.isError).toBe(true);
    expect(out.result.structuredContent).toMatchObject({ status: 409, error: "DOCUMENT_DIFF_UNAVAILABLE", repairable: true });
  });

  it("delete_document is scope-gated and sends DELETE when allowed", async () => {
    const hits: Array<{ method: string; url: string }> = [];
    const upstreamUrl = await startUpstream((req, res) => {
      hits.push({ method: req.method ?? "", url: req.url ?? "" });
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, deleted: true }));
    });
    // Default preset scopes do not include documents:delete.
    const gatedUrl = await listen(true, upstreamUrl);
    const gatedCall = makeCall(gatedUrl);
    await gatedCall(HANDSHAKE);
    const gated = await gatedCall({ jsonrpc: "2.0", id: 16, method: "tools/call", params: { name: "delete_document", arguments: { projectId: "p1", path: "novels/p1/chapters/ch1.md" } } });
    expect(gated.result.isError).toBe(true);
    expect(gated.result.content[0].text).toBe("SCOPE_REQUIRED: documents:delete");

    const allowedUrl = await listen(true, upstreamUrl, new Set<ApiScope>(["documents:delete"]));
    const allowedCall = makeCall(allowedUrl);
    await allowedCall(HANDSHAKE);
    const allowed = await allowedCall({ jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "delete_document", arguments: { projectId: "p1", path: "novels/p1/chapters/ch1.md" } } });
    expect(allowed.result.isError).toBeFalsy();
    expect(hits[0]).toEqual({ method: "DELETE", url: "/api/documents/p1/novels/p1/chapters/ch1.md" });
  });

  it("create_project maps camelCase fields to the API body", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const upstreamUrl = await startUpstream((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        bodies.push(JSON.parse(body));
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ project: { id: "p-new" } }));
      });
    });
    const url = await listen(true, upstreamUrl, new Set<ApiScope>(["projects:write"]));
    const call = makeCall(url);
    await call(HANDSHAKE);
    const out = await call({ jsonrpc: "2.0", id: 18, method: "tools/call", params: { name: "create_project", arguments: { title: "新小说", creativeLanguage: "zh" } } });
    expect(out.result.isError).toBeFalsy();
    expect(bodies[0]).toEqual({ title: "新小说", creative_language: "zh" });
  });

  it("run_agent accepts a command without a message and rejects an empty instruction", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const upstreamUrl = await sseUpstream(
      (body) => bodies.push(body),
      `data: ${JSON.stringify({ type: "turn_started", turn_id: "t1", assistant_message_id: "m1" })}\n\n`,
    );
    const url = await listen(true, upstreamUrl);
    const call = makeCall(url);
    await call(HANDSHAKE);
    const commandRun = await call({ jsonrpc: "2.0", id: 19, method: "tools/call", params: { name: "run_agent", arguments: { projectId: "p1", sessionId: "s1", command: "skill-creator" } } });
    expect(commandRun.result.isError).toBeFalsy();
    expect(bodies[0]).toEqual({ project_id: "p1", session_id: "s1", command: "skill-creator" });

    const invalid = await call({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "run_agent", arguments: { projectId: "p1", sessionId: "s1" } } });
    expect(invalid.result.isError).toBe(true);
    expect(invalid.result.structuredContent).toEqual({ status: 400, error: "INVALID_CHAT_INPUT" });
  });

  it("list_tasks and list_delegation_messages hit their read paths", async () => {
    const urls: string[] = [];
    const upstreamUrl = await startUpstream((req, res) => {
      urls.push(req.url ?? "");
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: [] }));
    });
    const url = await listen(true, upstreamUrl);
    const call = makeCall(url);
    await call(HANDSHAKE);
    const tasks = await call({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "list_tasks", arguments: { projectId: "p1" } } });
    expect(tasks.result.isError).toBeFalsy();
    const delegations = await call({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "list_delegation_messages", arguments: { sessionId: "s1", callId: "call-1" } } });
    expect(delegations.result.isError).toBeFalsy();
    expect(urls).toEqual(["/api/tasks?project_id=p1", "/api/sessions/s1/delegations/call-1/messages"]);
  });

  it("rejects tools whose scopes the token lacks, as structured tool errors", async () => {
    const url = await listen(true, "http://127.0.0.1:1", new Set<ApiScope>(["projects:read"]));
    const call = makeCall(url);
    await call(HANDSHAKE);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["write_document", { projectId: "p", path: "x", content: "c", baseHash: "h" }],
      ["export_document", { projectId: "p", path: "x", format: "md" }],
      ["respond_interaction", { projectId: "p", sessionId: "s", interactionId: "i", answers: [{ fieldId: "f", type: "radio", value: "a" }] }],
      ["interrupt_session", { sessionId: "s" }],
      ["set_session_status", { sessionId: "s", action: "archive" }],
      ["list_document_versions", { projectId: "p", path: "x" }],
      ["delete_document", { projectId: "p", path: "x" }],
      ["create_project", { title: "t" }],
      ["set_project_status", { projectId: "p", action: "archive" }],
    ];
    for (const [index, [name, args]] of cases.entries()) {
      const out = await call({ jsonrpc: "2.0", id: 30 + index, method: "tools/call", params: { name, arguments: args } });
      const block = out.result.content?.[0];
      expect(`${name}: ${out.result.isError}`).toBe(`${name}: true`);
      expect(`${name}: ${block?.type === "text" ? block.text : ""}`).toMatch(new RegExp(`^${name}: SCOPE_REQUIRED:`));
    }
  });
});
