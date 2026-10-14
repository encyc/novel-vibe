import type {
  InteractionRpcResult,
  SessionInteractionRow,
} from "../../interactions/repository.js";
import type { AgentId, MemoryJobRow, SessionMessageRow, SessionRow } from "../../session/types.js";
import type { InteractionResponseV1 } from "../../interactions/types.js";

import { createLogger } from "../logger.js";

import type { DbRequestContext } from "./context.js";

import { ownsProject } from "./projects.js";

const log = createLogger("db");

export async function listProjectSessionIds(ctx: DbRequestContext, projectId: string): Promise<string[]> {
    const res = await fetch(`${ctx.pgUrl}/sessions?project_id=eq.${encodeURIComponent(projectId)}&select=id`, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List project sessions failed [${res.status}]: ${await res.text()}`);
    return (await res.json() as Array<{ id: string }>).map((row) => row.id);
  }

export async function createSession(ctx: DbRequestContext, params: {
    id: string;
    projectId: string;
    title: string;
  }): Promise<void> {
    const res = await fetch(`${ctx.pgUrl}/sessions`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({
        id: params.id,
        project_id: params.projectId,
        title: params.title,
        messages: [],
        is_processing: false,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      log.error(`createSession failed [${res.status}]: ${text}`);
    }
  }

export async function listSessions(ctx: DbRequestContext, ownerId?: string): Promise<any[]> {
    let projectIds: string[] | null = null;
    if (ownerId) {
      const projectsUrl = `${ctx.pgUrl}/projects?owner_id=eq.${ownerId}&select=id`;
      const projectRes = await fetch(projectsUrl, { headers: ctx.headers() });
      if (!projectRes.ok) throw new Error(`List projects failed [${projectRes.status}]: ${await projectRes.text()}`);
      const projects = await projectRes.json();
      const ids = projects.map((p: any) => p.id).filter(Boolean);
      if (ids.length === 0) return [];
      projectIds = ids;
    }

    let url = `${ctx.pgUrl}/sessions?order=last_message_at.desc`;
    if (projectIds) url += `&project_id=in.(${projectIds.join(",")})`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List sessions failed [${res.status}]: ${await res.text()}`);
    const sessions = await res.json();

    // Load messages for each session
    for (const session of sessions) {
      const msgRes = await fetch(
        `${ctx.pgUrl}/session_messages?session_id=eq.${session.id}&order=timestamp.asc`,
        { headers: ctx.headers() },
      );
      if (msgRes.ok) {
        session.messages = await msgRes.json();
      } else {
        session.messages = [];
      }
    }
    return sessions;
  }

export async function updateSession(ctx: DbRequestContext, sessionId: string, updates: {
    title?: string;
    isProcessing?: boolean;
    lastMessageAt?: string;
  }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (updates.title !== undefined) body.title = updates.title;
    if (updates.isProcessing !== undefined) body.is_processing = updates.isProcessing;
    if (updates.lastMessageAt !== undefined) body.last_message_at = updates.lastMessageAt;

    const url = `${ctx.pgUrl}/sessions?id=eq.${sessionId}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: ctx.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) log.error(`updateSession failed [${res.status}]: ${await res.text()}`);
  }

export async function addMessage(ctx: DbRequestContext, sessionId: string, msg: {
    id: string;
    role: string;
    content: any[];
    timestamp: number;
    model?: string;
  }): Promise<void> {
    const res = await fetch(`${ctx.pgUrl}/session_messages`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({
        id: msg.id,
        session_id: sessionId,
        role: msg.role,
        content: msg.content,
        model: msg.model ?? null,
        timestamp: msg.timestamp,
      }),
    });
    if (!res.ok) log.error(`addMessage failed [${res.status}]: ${await res.text()}`);

    // Update session's last_message_at
    await updateSession(ctx, sessionId, {
      lastMessageAt: new Date(msg.timestamp).toISOString(),
    });
  }

export async function deleteSession(ctx: DbRequestContext, sessionId: string): Promise<void> {
    const url = `${ctx.pgUrl}/sessions?id=eq.${sessionId}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: ctx.headers(),
    });
    if (!res.ok) log.error(`deleteSession failed [${res.status}]: ${await res.text()}`);
  }

function normalizeSessionRow(ctx: DbRequestContext, row: any): SessionRow {
    const nestedCount = Array.isArray(row.session_messages)
      ? Number(row.session_messages[0]?.count ?? 0)
      : 0;
    return {
      ...row,
      message_count: Number(row.message_count ?? nestedCount),
    } as SessionRow;
  }

export async function getOwnedSessionRow(ctx: DbRequestContext, sessionId: string, userId: string): Promise<SessionRow | null> {
    const url = `${ctx.pgUrl}/sessions?id=eq.${encodeURIComponent(sessionId)}`
      + "&select=*,session_messages(count)";
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Get session failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    const row = rows[0];
    if (!row || !await ownsProject(ctx, row.project_id, userId)) return null;
    return normalizeSessionRow(ctx, row);
  }

export async function listSessionRows(ctx: DbRequestContext, input: {
    projectId: string;
    userId: string;
    limit: number;
    cursor?: { lastMessageAt: string; id: string };
    search?: string;
    lifecycleStatus: import("../../session/types.js").SessionLifecycleStatus;
  }): Promise<SessionRow[]> {
    if (!await ownsProject(ctx, input.projectId, input.userId)) return [];
    let url = `${ctx.pgUrl}/sessions?project_id=eq.${encodeURIComponent(input.projectId)}`
      + `&lifecycle_status=eq.${input.lifecycleStatus}`
      + "&select=*,session_messages(count)"
      + "&order=last_message_at.desc,id.desc"
      + `&limit=${input.limit}`;
    if (input.search) {
      url += `&title=ilike.${encodeURIComponent(`*${input.search}*`)}`;
    }
    if (input.cursor) {
      const time = input.cursor.lastMessageAt;
      const id = input.cursor.id;
      const filter = `(last_message_at.lt.${time},and(last_message_at.eq.${time},id.lt.${id}))`;
      url += `&or=${encodeURIComponent(filter)}`;
    }
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List sessions failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows.map((row: any) => normalizeSessionRow(ctx, row));
  }

export async function getActiveSessionId(ctx: DbRequestContext, projectId: string, userId: string): Promise<string | null> {
    if (!await ownsProject(ctx, projectId, userId)) return null;
    const url = `${ctx.pgUrl}/sessions?project_id=eq.${encodeURIComponent(projectId)}`
      + "&lifecycle_status=eq.active&select=id&order=last_opened_at.desc,id.desc&limit=1";
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Get active session failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0]?.id ?? null;
  }

export async function insertSessionRow(ctx: DbRequestContext, row: Pick<SessionRow, "id" | "project_id" | "title">, userId: string): Promise<SessionRow> {
    if (!await ownsProject(ctx, row.project_id, userId)) {
      throw new Error("Project not found");
    }
    const res = await fetch(`${ctx.pgUrl}/sessions`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`Create session failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return normalizeSessionRow(ctx, rows[0]);
  }

export async function patchSessionRow(ctx: DbRequestContext, sessionId: string, patch: Partial<SessionRow>): Promise<SessionRow> {
    const url = `${ctx.pgUrl}/sessions?id=eq.${encodeURIComponent(sessionId)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Update session failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return normalizeSessionRow(ctx, rows[0]);
  }

export async function deleteSessionRow(ctx: DbRequestContext, sessionId: string): Promise<void> {
    const url = `${ctx.pgUrl}/sessions?id=eq.${encodeURIComponent(sessionId)}`;
    const res = await fetch(url, { method: "DELETE", headers: ctx.headers() });
    if (!res.ok) throw new Error(`Delete session failed [${res.status}]: ${await res.text()}`);
  }

export async function insertSessionInteractionRow(ctx: DbRequestContext, row: Omit<SessionInteractionRow, "created_at" | "updated_at">): Promise<SessionInteractionRow> {
    const res = await fetch(`${ctx.pgUrl}/rpc/create_session_interaction`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({
        p_id: row.id,
        p_project_id: row.project_id,
        p_session_id: row.session_id,
        p_turn_id: row.turn_id,
        p_assistant_message_id: row.assistant_message_id,
        p_request: row.request,
      }),
    });
    if (!res.ok) throw new Error(`Create session interaction failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function getSessionInteractionRow(ctx: DbRequestContext, id: string): Promise<SessionInteractionRow | null> {
    const url = `${ctx.pgUrl}/session_interactions?id=eq.${encodeURIComponent(id)}&limit=1`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Get session interaction failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function listSessionInteractionRows(ctx: DbRequestContext, assistantMessageIds: string[]): Promise<SessionInteractionRow[]> {
    if (assistantMessageIds.length === 0) return [];
    const ids = assistantMessageIds.map((id) => encodeURIComponent(id)).join(",");
    const url = `${ctx.pgUrl}/session_interactions?assistant_message_id=in.(${ids})&order=created_at.asc,id.asc`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List session interactions failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function respondToSessionInteraction(ctx: DbRequestContext, input: {
    interactionId: string;
    response: InteractionResponseV1;
    idempotencyKey: string;
    responseMessageId: string;
    turnId: string;
    messageText: string;
    timestamp: number;
  }): Promise<InteractionRpcResult> {
    const res = await fetch(`${ctx.pgUrl}/rpc/respond_to_session_interaction`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({
        p_interaction_id: input.interactionId,
        p_response: input.response,
        p_idempotency_key: input.idempotencyKey,
        p_response_message_id: input.responseMessageId,
        p_turn_id: input.turnId,
        p_message_text: input.messageText,
        p_timestamp: input.timestamp,
      }),
    });
    if (!res.ok) throw new Error(`Respond to session interaction failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function listDisplayMessageRows(ctx: DbRequestContext, input: {
    sessionId: string;
    limit: number;
    cursor?: { sequence: number };
  }): Promise<SessionMessageRow[]> {
    let url = `${ctx.pgUrl}/session_messages?session_id=eq.${encodeURIComponent(input.sessionId)}`
      + "&display=eq.true&agent_id=eq.chief_editor&role=in.(user,assistant)"
      + `&order=sequence.desc&limit=${input.limit}`;
    if (input.cursor) url += `&sequence=lt.${input.cursor.sequence}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List display messages failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function listDelegationMessageRows(ctx: DbRequestContext, input: {
  sessionId: string;
  agentId: string;
  turnId: string;
  limit: number;
  before?: { sequence: number };
}): Promise<SessionMessageRow[]> {
  let url = `${ctx.pgUrl}/session_messages?session_id=eq.${encodeURIComponent(input.sessionId)}`
    + `&agent_id=eq.${encodeURIComponent(input.agentId)}`
    + `&turn_id=eq.${encodeURIComponent(input.turnId)}`
    + `&status=eq.complete&order=sequence.desc&limit=${input.limit}`;
  if (input.before) url += `&sequence=lt.${input.before.sequence}`;
  const res = await fetch(url, { headers: ctx.headers() });
  if (!res.ok) throw new Error(`List delegation messages failed [${res.status}]: ${await res.text()}`);
  return res.json();
}

export async function listAgentMessageRows(ctx: DbRequestContext, sessionId: string, agentId: AgentId, afterSequence: number): Promise<SessionMessageRow[]> {
    const url = `${ctx.pgUrl}/session_messages?session_id=eq.${encodeURIComponent(sessionId)}`
      + `&agent_id=eq.${encodeURIComponent(agentId)}`
      + `&sequence=gt.${afterSequence}&status=eq.complete&order=sequence.asc`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List agent messages failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function insertSessionMessageRow(ctx: DbRequestContext, row: Omit<SessionMessageRow, "sequence">): Promise<SessionMessageRow> {
    const res = await fetch(`${ctx.pgUrl}/session_messages`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`Insert session message failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0];
  }

export async function patchSessionMessageRow(ctx: DbRequestContext, messageId: string, patch: Partial<Omit<SessionMessageRow, "id" | "session_id" | "sequence">>): Promise<SessionMessageRow> {
    const url = `${ctx.pgUrl}/session_messages?id=eq.${encodeURIComponent(messageId)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Update session message failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0];
  }

export async function acquireSessionLease(ctx: DbRequestContext, sessionId: string, leaseId: string, staleBefore: string): Promise<boolean> {
    const res = await fetch(`${ctx.pgUrl}/rpc/acquire_session_lease`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({
        p_session_id: sessionId,
        p_lease_id: leaseId,
        p_stale_before: staleBefore,
      }),
    });
    if (!res.ok) throw new Error(`Acquire session lease failed [${res.status}]: ${await res.text()}`);
    return Boolean(await res.json());
  }

export async function releaseSessionLease(ctx: DbRequestContext, sessionId: string, leaseId: string): Promise<boolean> {
    const res = await fetch(`${ctx.pgUrl}/rpc/release_session_lease`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({ p_session_id: sessionId, p_lease_id: leaseId }),
    });
    if (!res.ok) throw new Error(`Release session lease failed [${res.status}]: ${await res.text()}`);
    return Boolean(await res.json());
  }

export async function releaseStaleLeases(ctx: DbRequestContext, staleBefore: string): Promise<number> {
    const res = await fetch(
      `${ctx.pgUrl}/sessions?processing_lease_id=not.is.null&processing_started_at=lt.${encodeURIComponent(staleBefore)}`,
      {
        method: "PATCH",
        headers: ctx.headers({ Prefer: "return=representation" }),
        body: JSON.stringify({
          processing_lease_id: null,
          processing_started_at: null,
          is_processing: false,
          updated_at: new Date().toISOString(),
        }),
      },
    );
    if (!res.ok) throw new Error(`Release stale leases failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows.length : 0;
  }

export async function insertMemoryJobRow(ctx: DbRequestContext, row: Pick<MemoryJobRow,
    "id" | "session_id" | "project_id" | "turn_id" | "operation" | "payload" | "status"
  >): Promise<void> {
    const res = await fetch(`${ctx.pgUrl}/memory_jobs`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`Insert memory job failed [${res.status}]: ${await res.text()}`);
  }

export async function claimMemoryJobRows(ctx: DbRequestContext, now: string, limit: number): Promise<MemoryJobRow[]> {
    const res = await fetch(`${ctx.pgUrl}/rpc/claim_memory_jobs`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({ p_now: now, p_limit: limit }),
    });
    if (!res.ok) throw new Error(`Claim memory jobs failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function patchMemoryJobRow(ctx: DbRequestContext, jobId: string, patch: Partial<MemoryJobRow>): Promise<void> {
    const url = `${ctx.pgUrl}/memory_jobs?id=eq.${encodeURIComponent(jobId)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: ctx.headers(),
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Update memory job failed [${res.status}]: ${await res.text()}`);
  }

export async function listMemoryExclusionRows(ctx: DbRequestContext, projectId: string): Promise<Array<{ external_memory_id: string }>> {
    const url = `${ctx.pgUrl}/memory_exclusions?project_id=eq.${encodeURIComponent(projectId)}`
      + "&select=external_memory_id";
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List memory exclusions failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function insertMemoryExclusionRows(ctx: DbRequestContext, rows: Array<{
    project_id: string;
    deleted_session_id: string;
    external_memory_id: string;
  }>): Promise<void> {
    if (rows.length === 0) return;
    const conflictColumns = encodeURIComponent("project_id,external_memory_id");
    const res = await fetch(`${ctx.pgUrl}/memory_exclusions?on_conflict=${conflictColumns}`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "resolution=merge-duplicates" }),
      body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(`Insert memory exclusions failed [${res.status}]: ${await res.text()}`);
  }

export async function getAgentStateRow(ctx: DbRequestContext, sessionId: string, agentId: AgentId): Promise<{
    summary: string | null;
    summary_through_sequence: number | null;
  } | null> {
    const url = `${ctx.pgUrl}/session_agent_state?session_id=eq.${encodeURIComponent(sessionId)}`
      + `&agent_id=eq.${encodeURIComponent(agentId)}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Get agent state failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function upsertAgentStateRow(ctx: DbRequestContext, row: {
    session_id: string;
    agent_id: AgentId;
    summary: string;
    summary_through_sequence: number;
  }): Promise<void> {
    const conflictColumns = encodeURIComponent("session_id,agent_id");
    const res = await fetch(`${ctx.pgUrl}/session_agent_state?on_conflict=${conflictColumns}`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "resolution=merge-duplicates" }),
      body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`Upsert agent state failed [${res.status}]: ${await res.text()}`);
  }

export async function prepareSessionMemoryDelete(ctx: DbRequestContext, sessionId: string): Promise<boolean> {
    const res = await fetch(`${ctx.pgUrl}/rpc/prepare_session_memory_delete`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({ p_session_id: sessionId }),
    });
    if (!res.ok) throw new Error(`Prepare memory deletion failed [${res.status}]: ${await res.text()}`);
    return Boolean(await res.json());
  }
