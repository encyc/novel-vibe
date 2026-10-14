import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { randomUUID } from "node:crypto";
import type { ApiScope } from "../../novel-agents/auth/scopes.js";
import { requireScopes } from "./auth.js";
import { AgentClient } from "./agent-client.js";
import { requireContext } from "./context.js";
import { toToolErrorResult } from "./errors.js";
import type { FixedWindowRateLimiter } from "./rate-limit.js";
import type { AuditService, AuditEventInput } from "../../novel-agents/auth/audit-service.js";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

// All upstream failures flow through here so MCP clients receive the Agent
// API's structured payload (status, error code, conflict content) instead of
// the SDK's message-only serialization of a thrown error.
type ShapeOutput<Shape extends ZodRawShape> = {
  [K in keyof Shape]: z.output<Shape[K]>;
};

function defineTool<Args extends ZodRawShape>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema: Args },
  handler: (args: ShapeOutput<Args>) => Promise<CallToolResult>,
): void {
  const callback = async (args: ShapeOutput<Args>): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      return toToolErrorResult(error);
    }
  };
  // The SDK's conditional callback type cannot express per-call inference of
  // Args from config.inputSchema; Args is fixed at each defineTool call site,
  // so bridge the registration once here.
  server.registerTool(name, config, callback as never);
}

function toolContext(required: readonly ApiScope[]) {
  const context = requireContext();
  requireScopes(context.principal.scopes, required);
  return context;
}

const encodedPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export function registerTools(server: McpServer, client: AgentClient, agentLimiter?: FixedWindowRateLimiter, auditService?: AuditService): void {
  const audit = (input: Omit<AuditEventInput, "userId" | "tokenId">) => {
    const ctx = requireContext();
    if (ctx.principal.authType !== "api_token") return;
    void auditService?.record({ ...input, userId: ctx.principal.userId, tokenId: ctx.principal.tokenId }).catch(() => {});
  };
  defineTool(server, "list_projects", { description: "List the user's Novel Vibe projects.", inputSchema: { status: z.enum(["active", "archived", "trash"]).default("active") } }, async ({ status }) => {
    const ctx = toolContext(["projects:read"]);
    return result(await client.request(ctx.delegatedToken, `/api/projects?status=${status}`));
  });
  defineTool(server, "get_project", { description: "Read one Novel Vibe project.", inputSchema: { projectId: z.string().min(1) } }, async ({ projectId }) => {
    const ctx = toolContext(["projects:read"]);
    return result(await client.request(ctx.delegatedToken, `/api/projects/${encodeURIComponent(projectId)}`));
  });
  defineTool(server, "list_documents", { description: "List project documents.", inputSchema: { projectId: z.string().min(1), type: z.string().optional() } }, async ({ projectId, type }) => {
    const ctx = toolContext(["documents:read"]);
    const query = type ? `?type=${encodeURIComponent(type)}` : "";
    return result(await client.request(ctx.delegatedToken, `/api/documents/${encodeURIComponent(projectId)}${query}`));
  });
  defineTool(server, "read_document", { description: "Read a Markdown document.", inputSchema: { projectId: z.string().min(1), path: z.string().min(1) } }, async ({ projectId, path }) => {
    const ctx = toolContext(["documents:read"]);
    return result(await client.request(ctx.delegatedToken, `/api/documents/${encodeURIComponent(projectId)}/${encodedPath(path)}`));
  });
  defineTool(server, "write_document", { description: "Save a Markdown document using optimistic concurrency. On 409 conflict the structured error carries the current content and hash for re-reading.", inputSchema: { projectId: z.string().min(1), path: z.string().min(1), content: z.string(), baseHash: z.string().min(1) } }, async ({ projectId, path, content, baseHash }) => {
    const ctx = toolContext(["documents:write"]);
    const saved = await client.request(ctx.delegatedToken, `/api/documents/${encodeURIComponent(projectId)}/${encodedPath(path)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, base_hash: baseHash }) });
    audit({ operation: "document.write", status: "complete", projectId, metadata: { path } });
    return result(saved);
  });
  defineTool(server, "export_document", { description: "Export a document (membership feature; non-member tokens receive a 403 MEMBERSHIP_REQUIRED structured error). Binary data is returned as base64.", inputSchema: { projectId: z.string().min(1), path: z.string().min(1), format: z.enum(["md", "txt", "docx"]) } }, async ({ projectId, path, format }) => {
    const ctx = toolContext(["documents:export"]);
    const exported = await client.export(ctx.delegatedToken, `/api/documents/${encodeURIComponent(projectId)}/${encodedPath(path)}/export/${format}`);
    audit({ operation: "document.export", status: "complete", projectId, metadata: { path, format } });
    return result(exported);
  });
  defineTool(server, "list_sessions", { description: "List durable Chief Editor sessions.", inputSchema: { projectId: z.string().min(1), status: z.enum(["active", "archived"]).default("active"), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() } }, async ({ projectId, status, limit, cursor }) => {
    const ctx = toolContext(["sessions:read"]);
    const query = new URLSearchParams({ status }); if (limit) query.set("limit", String(limit)); if (cursor) query.set("cursor", cursor);
    return result(await client.request(ctx.delegatedToken, `/api/projects/${encodeURIComponent(projectId)}/sessions?${query}`));
  });
  defineTool(server, "create_session", { description: "Create a durable Chief Editor session.", inputSchema: { projectId: z.string().min(1) } }, async ({ projectId }) => {
    const ctx = toolContext(["sessions:write"]);
    return result(await client.request(ctx.delegatedToken, `/api/projects/${encodeURIComponent(projectId)}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
  });
  defineTool(server, "list_session_messages", { description: "Read display messages from a session.", inputSchema: { sessionId: z.string().min(1), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() } }, async ({ sessionId, limit, cursor }) => {
    const ctx = toolContext(["sessions:read"]);
    const query = new URLSearchParams(); if (limit) query.set("limit", String(limit)); if (cursor) query.set("cursor", cursor);
    return result(await client.request(ctx.delegatedToken, `/api/sessions/${encodeURIComponent(sessionId)}/messages?${query}`));
  });
  defineTool(server, "rename_session", { description: "Rename a session.", inputSchema: { sessionId: z.string().min(1), title: z.string().min(1).max(200) } }, async ({ sessionId, title }) => {
    const ctx = toolContext(["sessions:write"]);
    return result(await client.request(ctx.delegatedToken, `/api/sessions/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) }));
  });
  defineTool(server, "get_credit_summary", { description: "Read the user's credit summary.", inputSchema: {} }, async () => {
    const ctx = toolContext(["billing:read"]); return result(await client.request(ctx.delegatedToken, "/api/credits/summary"));
  });
  defineTool(server, "list_models", { description: "List models available for Agent runs.", inputSchema: {} }, async () => {
    const ctx = toolContext(["billing:read"]); return result(await client.request(ctx.delegatedToken, "/api/models"));
  });
  defineTool(server, "list_skills", { description: "List installed user skills.", inputSchema: {} }, async () => {
    const ctx = toolContext(["skills:read"]); return result(await client.request(ctx.delegatedToken, "/api/skills"));
  });
  defineTool(server, "get_agent_run", { description: "Read the current or final Chief Editor message for a run.", inputSchema: { sessionId: z.string().min(1), assistantMessageId: z.string().min(1) } }, async ({ sessionId, assistantMessageId }) => {
    const ctx = toolContext(["sessions:read"]);
    // MVP: scan the recent display-message window for the placeholder. A long
    // active session may push the target past this limit; in that case we
    // report "running" (a valid MessageStatus) rather than a fabricated value.
    // A future per-message lookup endpoint should replace this scan.
    const page = await client.request<{ items: Array<Record<string, unknown>> }>(ctx.delegatedToken, `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`);
    return result(page.items.find((item) => item.id === assistantMessageId) ?? { id: assistantMessageId, status: "running" });
  });

  defineTool(server, "respond_interaction", {
    description: "Answer a pending Chief Editor interaction question. Starts a new turn and consumes credits.",
    inputSchema: {
      projectId: z.string().min(1),
      sessionId: z.string().min(1),
      interactionId: z.string().min(1),
      answers: z.array(z.union([
        z.object({ fieldId: z.string(), type: z.enum(["radio", "text", "textarea"]), value: z.string() }),
        z.object({ fieldId: z.string(), type: z.literal("checkbox"), value: z.array(z.string()) }),
      ])).min(1),
      freeAnswer: z.string().optional(),
    },
  }, async ({ projectId, sessionId, interactionId, answers, freeAnswer }) => {
    const ctx = toolContext(["agents:run"]);
    agentLimiter?.check(ctx.principal.authType === "api_token" ? ctx.principal.tokenId : ctx.principal.userId);
    const started = await client.startAgentRun(ctx.delegatedToken, {
      project_id: projectId,
      session_id: sessionId,
      interaction_response: { schemaVersion: 1, interactionId, idempotencyKey: randomUUID(), answers, ...(freeAnswer ? { freeAnswer } : {}) },
    });
    audit({ operation: "agent.interaction_response", status: "accepted", projectId, sessionId });
    return result(started);
  });

  defineTool(server, "list_pending_interactions", {
    description: "List unanswered interaction questions in a session's recent 100-message window.",
    inputSchema: { sessionId: z.string().min(1) },
  }, async ({ sessionId }) => {
    const ctx = toolContext(["sessions:read"]);
    const page = await client.request<{ items: Array<Record<string, unknown>> }>(ctx.delegatedToken, `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`);
    const interactions = page.items.flatMap((item) => {
      const list = Array.isArray(item.interactions) ? item.interactions as Array<Record<string, unknown>> : [];
      return list.filter((entry) => entry.status === "pending")
        .map((entry) => ({ id: entry.id, assistantMessageId: item.id, status: entry.status, request: entry.request }));
    });
    return result({ interactions });
  });

  defineTool(server, "interrupt_session", {
    description: "Stop the Chief Editor's in-flight turn in a session. The partial assistant message is kept as interrupted.",
    inputSchema: { sessionId: z.string().min(1) },
  }, async ({ sessionId }) => {
    const ctx = toolContext(["sessions:write"]);
    const stopped = await client.request(ctx.delegatedToken, `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    audit({ operation: "session.interrupt", status: "complete", sessionId });
    return result(stopped);
  });

  defineTool(server, "set_session_status", {
    description: "Archive or restore a durable Chief Editor session.",
    inputSchema: { sessionId: z.string().min(1), action: z.enum(["archive", "restore"]) },
  }, async ({ sessionId, action }) => {
    const ctx = toolContext(["sessions:write"]);
    const updated = await client.request(ctx.delegatedToken, `/api/sessions/${encodeURIComponent(sessionId)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    audit({ operation: "session.lifecycle", status: "complete", sessionId, metadata: { action } });
    return result(updated);
  });

  const numericCursor = z.string().regex(/^\d+$/).optional();

  defineTool(server, "list_document_versions", {
    description: "List version history for a document, newest first (cursor pagination).",
    inputSchema: { projectId: z.string().min(1), path: z.string().min(1), limit: z.number().int().min(1).max(100).optional(), cursor: numericCursor },
  }, async ({ projectId, path, limit, cursor }) => {
    const ctx = toolContext(["documents:read"]);
    const query = new URLSearchParams();
    if (limit) query.set("limit", String(limit));
    if (cursor) query.set("cursor", cursor);
    const suffix = query.size ? `?${query}` : "";
    return result(await client.request(ctx.delegatedToken, `/api/documents/${encodeURIComponent(projectId)}/${encodedPath(path)}/versions${suffix}`));
  });

  defineTool(server, "get_document_version", {
    description: "Read one stored document version by id.",
    inputSchema: { versionId: z.string().min(1) },
  }, async ({ versionId }) => {
    const ctx = toolContext(["documents:read"]);
    return result(await client.request(ctx.delegatedToken, `/api/document-versions/${encodeURIComponent(versionId)}`));
  });

  defineTool(server, "get_document_version_diff", {
    description: "Read the paginated diff of a document version. 409 DOCUMENT_DIFF_UNAVAILABLE is repairable server-side.",
    inputSchema: { versionId: z.string().min(1), limit: z.number().int().min(1).max(100).optional(), cursor: numericCursor },
  }, async ({ versionId, limit, cursor }) => {
    const ctx = toolContext(["documents:read"]);
    const query = new URLSearchParams();
    if (limit) query.set("limit", String(limit));
    if (cursor) query.set("cursor", cursor);
    const suffix = query.size ? `?${query}` : "";
    return result(await client.request(ctx.delegatedToken, `/api/document-versions/${encodeURIComponent(versionId)}/diff${suffix}`));
  });

  defineTool(server, "delete_document", {
    description: "Delete a Markdown document together with its DB index and foreshadow entries. Requires the documents:delete scope.",
    inputSchema: { projectId: z.string().min(1), path: z.string().min(1) },
  }, async ({ projectId, path }) => {
    const ctx = toolContext(["documents:delete"]);
    const deleted = await client.request(ctx.delegatedToken, `/api/documents/${encodeURIComponent(projectId)}/${encodedPath(path)}`, { method: "DELETE" });
    audit({ operation: "document.delete", status: "complete", projectId, metadata: { path } });
    return result(deleted);
  });

  defineTool(server, "create_project", {
    description: "Create a Novel Vibe project. Free accounts are capped at 3 projects (403 PROJECT_LIMIT_REACHED).",
    inputSchema: { title: z.string().min(1).max(200), genre: z.string().optional(), synopsis: z.string().optional(), creativeLanguage: z.string().optional() },
  }, async ({ title, genre, synopsis, creativeLanguage }) => {
    const ctx = toolContext(["projects:write"]);
    const created = await client.request(ctx.delegatedToken, "/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, ...(genre ? { genre } : {}), ...(synopsis ? { synopsis } : {}), ...(creativeLanguage ? { creative_language: creativeLanguage } : {}) }) });
    audit({ operation: "project.write", status: "complete", metadata: { kind: "create" } });
    return result(created);
  });

  defineTool(server, "update_project", {
    description: "Update project title, genre, synopsis, writing stage, or creative language.",
    inputSchema: { projectId: z.string().min(1), title: z.string().min(1).max(200).optional(), genre: z.string().optional(), synopsis: z.string().optional(), writingStage: z.string().optional(), creativeLanguage: z.string().optional() },
  }, async ({ projectId, title, genre, synopsis, writingStage, creativeLanguage }) => {
    const ctx = toolContext(["projects:write"]);
    const updated = await client.request(ctx.delegatedToken, `/api/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(title !== undefined ? { title } : {}), ...(genre !== undefined ? { genre } : {}), ...(synopsis !== undefined ? { synopsis } : {}), ...(writingStage !== undefined ? { writing_stage: writingStage } : {}), ...(creativeLanguage !== undefined ? { creative_language: creativeLanguage } : {}) }) });
    audit({ operation: "project.write", status: "complete", projectId, metadata: { kind: "update" } });
    return result(updated);
  });

  defineTool(server, "set_project_status", {
    description: "Archive, trash, or restore a project. Archived/trashed projects are read-only for agent runs.",
    inputSchema: { projectId: z.string().min(1), action: z.enum(["archive", "trash", "restore"]) },
  }, async ({ projectId, action }) => {
    const ctx = toolContext(["projects:lifecycle"]);
    const updated = await client.request(ctx.delegatedToken, `/api/projects/${encodeURIComponent(projectId)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    audit({ operation: "project.lifecycle", status: "complete", projectId, metadata: { action } });
    return result(updated);
  });

  defineTool(server, "list_tasks", {
    description: "List the project's agent task board (newest first).",
    inputSchema: { projectId: z.string().min(1), limit: z.number().int().min(1).max(200).optional() },
  }, async ({ projectId, limit }) => {
    const ctx = toolContext(["projects:read"]);
    const query = new URLSearchParams({ project_id: projectId });
    if (limit) query.set("limit", String(limit));
    return result(await client.request(ctx.delegatedToken, `/api/tasks?${query}`));
  });

  defineTool(server, "list_delegation_messages", {
    description: "Read a sub-agent delegation transcript (callId comes from the parent message's trace).",
    inputSchema: { sessionId: z.string().min(1), callId: z.string().min(1), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() },
  }, async ({ sessionId, callId, limit, cursor }) => {
    const ctx = toolContext(["sessions:read"]);
    const query = new URLSearchParams();
    if (limit) query.set("limit", String(limit));
    if (cursor) query.set("cursor", cursor);
    const suffix = query.size ? `?${query}` : "";
    return result(await client.request(ctx.delegatedToken, `/api/sessions/${encodeURIComponent(sessionId)}/delegations/${encodeURIComponent(callId)}/messages${suffix}`));
  });

  defineTool(server, "run_agent", {
    description: "Send a task to the Chief Editor. Consumes credits; premium models require membership. May end with a pending interaction question — poll list_session_messages and answer via respond_interaction. On failure the error carries the server-side reason.",
    inputSchema: { projectId: z.string().min(1), sessionId: z.string().min(1), message: z.string().min(1).optional(), command: z.enum(["skill-creator", "lingqi"]).optional(), provider: z.string().optional(), model: z.string().optional() },
  }, async ({ projectId, sessionId, message, command, provider, model }) => {
    const ctx = toolContext(["agents:run"]);
    if (!message && !command) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ status: 400, error: "INVALID_CHAT_INPUT", message: "Provide message or command" }) }],
        structuredContent: { status: 400, error: "INVALID_CHAT_INPUT" },
      };
    }
    agentLimiter?.check(ctx.principal.authType === "api_token" ? ctx.principal.tokenId : ctx.principal.userId);
    const started = await client.startAgentRun(ctx.delegatedToken, { project_id: projectId, session_id: sessionId, message, provider, model, ...(command ? { command } : {}) });
    audit({ operation: "agent.run", status: "accepted", projectId, sessionId, turnId: typeof started.turn_id === "string" ? started.turn_id : undefined });
    return result(started);
  });
}
