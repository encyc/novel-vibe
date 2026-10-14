import type { Message } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import {
  decodeStoredMessage,
  encodeAgentMessage,
  extractDelegationRef,
  toDelegationTranscriptEntry,
  toDisplayMessage,
} from "./message-codec.js";
import type { DelegationTranscriptEntry } from "./message-codec.js";
import { AGENT_IDS } from "./types.js";
import type {
  AgentId,
  CursorPage,
  DisplayMessageDto,
  ModelDescriptor,
  MemoryJobRow,
  SessionDto,
  SessionMessageRow,
  SessionLifecycleStatus,
  SessionPage,
  SessionRow,
  StoredAgentMessage,
} from "./types.js";
import { SessionDomainError } from "./types.js";
import type { PersistedChatTrace } from "../lib/persisted-chat-trace.js";
import {
  InteractionRepository,
  sessionInteractionFromRow,
  type InteractionDataSource,
  type SessionInteractionRow,
} from "../interactions/repository.js";
import type { InteractionResponseV1 } from "../interactions/types.js";

interface ListSessionRowsInput {
  projectId: string;
  userId: string;
  limit: number;
  cursor?: { lastMessageAt: string; id: string };
  search?: string;
  lifecycleStatus: SessionLifecycleStatus;
}

interface ListMessageRowsInput {
  sessionId: string;
  limit: number;
  cursor?: { sequence: number };
}

export interface SessionDataSource extends InteractionDataSource {
  getOwnedSessionRow(sessionId: string, userId: string): Promise<SessionRow | null>;
  listSessionRows(input: ListSessionRowsInput): Promise<SessionRow[]>;
  getActiveSessionId(projectId: string, userId: string): Promise<string | null>;
  insertSessionRow(row: Pick<SessionRow, "id" | "project_id" | "title">, userId: string): Promise<SessionRow>;
  patchSessionRow(sessionId: string, patch: Partial<SessionRow>): Promise<SessionRow>;
  deleteSessionRow(sessionId: string): Promise<void>;
  listDisplayMessageRows(input: ListMessageRowsInput): Promise<SessionMessageRow[]>;
  listSessionInteractionRows(assistantMessageIds: string[]): Promise<SessionInteractionRow[]>;
  listAgentMessageRows(
    sessionId: string,
    agentId: AgentId,
    afterSequence: number,
  ): Promise<SessionMessageRow[]>;
  listDelegationMessageRows(input: {
    sessionId: string;
    agentId: string;
    turnId: string;
    limit: number;
    before?: { sequence: number };
  }): Promise<SessionMessageRow[]>;
  insertSessionMessageRow(row: Omit<SessionMessageRow, "sequence">): Promise<SessionMessageRow>;
  patchSessionMessageRow(
    messageId: string,
    patch: Partial<Omit<SessionMessageRow, "id" | "session_id" | "sequence">>,
  ): Promise<SessionMessageRow>;
  acquireSessionLease(sessionId: string, leaseId: string, staleBefore: string): Promise<boolean>;
  releaseSessionLease(sessionId: string, leaseId: string): Promise<boolean>;
  insertMemoryJobRow(row: Pick<MemoryJobRow,
    "id" | "session_id" | "project_id" | "turn_id" | "operation" | "payload" | "status"
  >): Promise<void>;
  claimMemoryJobRows(now: string, limit: number): Promise<MemoryJobRow[]>;
  patchMemoryJobRow(jobId: string, patch: Partial<MemoryJobRow>): Promise<void>;
  listMemoryExclusionRows(projectId: string): Promise<Array<{ external_memory_id: string }>>;
  insertMemoryExclusionRows(rows: Array<{
    project_id: string;
    deleted_session_id: string;
    external_memory_id: string;
  }>): Promise<void>;
  getAgentStateRow(sessionId: string, agentId: AgentId): Promise<{
    summary: string | null;
    summary_through_sequence: number | null;
  } | null>;
  upsertAgentStateRow(row: {
    session_id: string;
    agent_id: AgentId;
    summary: string;
    summary_through_sequence: number;
  }): Promise<void>;
  prepareSessionMemoryDelete(sessionId: string): Promise<boolean>;
}

export interface ListSessionsInput {
  projectId: string;
  userId: string;
  limit?: number;
  cursor?: string;
  search?: string;
  lifecycleStatus?: SessionLifecycleStatus;
}

export interface ListMessagesInput {
  sessionId: string;
  userId: string;
  limit?: number;
  cursor?: string;
}

export interface InsertAgentMessageInput {
  id: string;
  sessionId: string;
  turnId: string;
  agentId: AgentId;
  message: Message;
  status: SessionMessageRow["status"];
  display: boolean;
}

export interface EnqueueMemoryCaptureInput {
  id: string;
  sessionId: string;
  projectId: string;
  turnId: string;
  userMessage: string;
  assistantResponse: string;
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parseCursor<T>(cursor: string | undefined, validate: (value: unknown) => value is T): T | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (validate(parsed)) return parsed;
  } catch {
    // Converted to the stable domain error below.
  }
  throw new SessionDomainError("INVALID_CURSOR", "Invalid session cursor", 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionCursor(value: unknown): value is { lastMessageAt: string; id: string } {
  return isRecord(value)
    && typeof value.lastMessageAt === "string"
    && typeof value.id === "string";
}

function isMessageCursor(value: unknown): value is { sequence: number } {
  return isRecord(value) && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0;
}

function normalizedLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  // A malformed ?limit=abc arrives as NaN; refuse it like an invalid cursor
  // instead of shipping NaN into the data source query.
  if (!Number.isFinite(limit)) {
    throw new SessionDomainError("INVALID_LIMIT", "Invalid page limit", 400);
  }
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

function toSessionDto(row: SessionRow): SessionDto {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    titleIsCustom: row.title_is_custom,
    isProcessing: row.processing_lease_id !== null,
    processingStartedAt: row.processing_started_at,
    memoryStatus: row.memory_status,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    lifecycleStatus: row.lifecycle_status,
  };
}

const DELEGATION_TRACE_SCAN_LIMIT = 80;

export class SessionRepository {
  constructor(private readonly dataSource: SessionDataSource) {}

  async requireOwnedSession(sessionId: string, userId: string): Promise<SessionRow> {
    const row = await this.dataSource.getOwnedSessionRow(sessionId, userId);
    if (!row) throw new SessionDomainError("SESSION_NOT_FOUND", "Session not found", 404);
    return row;
  }

  async listProjectSessions(input: ListSessionsInput): Promise<SessionPage> {
    const limit = normalizedLimit(input.limit);
    const cursor = parseCursor(input.cursor, isSessionCursor);
    const lifecycleStatus = input.lifecycleStatus ?? "active";
    const [rows, activeSessionId] = await Promise.all([
      this.dataSource.listSessionRows({
        projectId: input.projectId,
        userId: input.userId,
        limit: limit + 1,
        cursor,
        search: input.search,
        lifecycleStatus,
      }),
      lifecycleStatus === "active"
        ? this.dataSource.getActiveSessionId(input.projectId, input.userId)
        : Promise.resolve(null),
    ]);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return {
      items: selected.map(toSessionDto),
      activeSessionId,
      nextCursor: hasMore && last
        ? encodeCursor({ lastMessageAt: last.last_message_at, id: last.id })
        : null,
    };
  }

  async createSession(projectId: string, userId: string, id: string): Promise<SessionDto> {
    const row = await this.dataSource.insertSessionRow({ id, project_id: projectId, title: "新会话" }, userId);
    return toSessionDto(row);
  }

  async openSession(sessionId: string, userId: string): Promise<SessionDto> {
    await this.requireOwnedSession(sessionId, userId);
    const now = new Date().toISOString();
    return toSessionDto(await this.dataSource.patchSessionRow(sessionId, {
      last_opened_at: now,
      updated_at: now,
    }));
  }

  async renameSession(sessionId: string, userId: string, title: string): Promise<SessionDto> {
    await this.requireOwnedSession(sessionId, userId);
    const normalized = title.trim();
    if (!normalized) throw new Error("Session title is required");
    return toSessionDto(await this.dataSource.patchSessionRow(sessionId, {
      title: normalized,
      title_is_custom: true,
      updated_at: new Date().toISOString(),
    }));
  }

  async deleteSession(sessionId: string, userId: string): Promise<void> {
    await this.requireOwnedSession(sessionId, userId);
    await this.dataSource.deleteSessionRow(sessionId);
  }

  async setLifecycleStatus(
    sessionId: string,
    lifecycleStatus: SessionLifecycleStatus,
    now: Date,
  ): Promise<SessionDto> {
    const timestamp = now.toISOString();
    return toSessionDto(await this.dataSource.patchSessionRow(sessionId, {
      lifecycle_status: lifecycleStatus,
      archived_at: lifecycleStatus === "archived" ? timestamp : null,
      updated_at: timestamp,
    }));
  }

  async insertAgentMessage(input: InsertAgentMessageInput): Promise<SessionMessageRow> {
    const encoded = encodeAgentMessage(input.message);
    const content = input.message.content;
    return this.dataSource.insertSessionMessageRow({
      id: input.id,
      session_id: input.sessionId,
      agent_id: input.agentId,
      turn_id: input.turnId,
      role: input.message.role,
      content,
      message: encoded,
      status: input.status,
      display: input.display,
      metadata: {},
      provider: input.message.role === "assistant" ? input.message.provider : null,
      model: input.message.role === "assistant" ? input.message.model : null,
      timestamp: input.message.timestamp,
    });
  }

  async completeAgentMessage(messageId: string, message: Message): Promise<SessionMessageRow> {
    return this.dataSource.patchSessionMessageRow(messageId, {
      role: message.role,
      content: message.content,
      message: encodeAgentMessage(message),
      status: "complete",
      display: message.role === "assistant",
      provider: message.role === "assistant" ? message.provider : null,
      model: message.role === "assistant" ? message.model : null,
      timestamp: message.timestamp,
    });
  }

  async listDisplayMessages(input: ListMessagesInput): Promise<CursorPage<DisplayMessageDto>> {
    await this.requireOwnedSession(input.sessionId, input.userId);
    const limit = normalizedLimit(input.limit);
    const cursor = parseCursor(input.cursor, isMessageCursor);
    const rows = await this.dataSource.listDisplayMessageRows({
      sessionId: input.sessionId,
      limit: limit + 1,
      cursor,
    });
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const interactionRows = await this.dataSource.listSessionInteractionRows(selected.map((row) => row.id));
    const interactionsByMessage = new Map<string, ReturnType<typeof sessionInteractionFromRow>[]>();
    for (const row of interactionRows) {
      const items = interactionsByMessage.get(row.assistant_message_id) ?? [];
      items.push(sessionInteractionFromRow(row));
      interactionsByMessage.set(row.assistant_message_id, items);
    }
    const items = [...selected].reverse().flatMap((row) => {
      const message = toDisplayMessage(row);
      if (!message) return [];
      const interactions = interactionsByMessage.get(row.id);
      return [{ ...message, ...(interactions?.length ? { interactions } : {}) }];
    });
    const last = selected.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ sequence: last.sequence }) : null,
    };
  }

  /**
   * Read-only drill-in transcript for one delegation call id. The chief
   * assistant message's persisted trace is the only resolver — no extra index
   * or table — and only completed rows of the owning (turn, agent) pair are
   * returned in ascending sequence order.
   */
  async listDelegationMessages(input: ListMessagesInput & { callId: string }): Promise<CursorPage<DelegationTranscriptEntry>> {
    await this.requireOwnedSession(input.sessionId, input.userId);
    const limit = normalizedLimit(input.limit);
    const cursor = parseCursor(input.cursor, isMessageCursor);

    const displayRows = await this.dataSource.listDisplayMessageRows({
      sessionId: input.sessionId,
      limit: DELEGATION_TRACE_SCAN_LIMIT,
    });
    let ref: ReturnType<typeof extractDelegationRef> = null;
    for (const row of displayRows) {
      ref = extractDelegationRef(row.metadata, input.callId, row.turn_id);
      if (ref) break;
    }
    if (!ref) {
      throw new SessionDomainError("DELEGATION_NOT_FOUND", "Unknown delegation call", 404);
    }
    if (!ref.turnId) {
      throw new SessionDomainError("DELEGATION_NOT_FOUND", "Delegation turn unknown", 404);
    }

    const rows = await this.dataSource.listDelegationMessageRows({
      sessionId: input.sessionId,
      agentId: ref.agentId,
      turnId: ref.turnId,
      limit: limit + 1,
      before: cursor,
    });
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = [...selected]
      .reverse()
      .map(toDelegationTranscriptEntry)
      .filter((entry): entry is DelegationTranscriptEntry => entry !== null);
    const oldest = selected.at(-1);
    return {
      items,
      nextCursor: hasMore && oldest ? encodeCursor({ sequence: oldest.sequence }) : null,
    };
  }

  async loadAgentTranscript(
    sessionId: string,
    agentId: AgentId,
    model: ModelDescriptor,
    afterSequence = 0,
  ): Promise<StoredAgentMessage[]> {
    const rows = await this.dataSource.listAgentMessageRows(sessionId, agentId, afterSequence);
    return rows.map((row) => ({
      sequence: row.sequence,
      turnId: row.turn_id,
      agentId,
      message: decodeStoredMessage(row, model),
    }));
  }

  async acquireLease(sessionId: string, leaseId: string, ttlMs: number): Promise<boolean> {
    const staleBefore = new Date(Date.now() - ttlMs).toISOString();
    return this.dataSource.acquireSessionLease(sessionId, leaseId, staleBefore);
  }

  async releaseLease(sessionId: string, leaseId: string): Promise<void> {
    await this.dataSource.releaseSessionLease(sessionId, leaseId);
  }

  async insertUserMessage(input: {
    id: string;
    sessionId: string;
    turnId: string;
    content: string;
    timestamp: number;
  }): Promise<void> {
    await this.insertAgentMessage({
      id: input.id,
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentId: "chief_editor",
      message: { role: "user", content: input.content, timestamp: input.timestamp },
      status: "complete",
      display: true,
    });
  }

  async respondToInteraction(input: {
    interactionId: string;
    userId: string;
    response: InteractionResponseV1;
    messageId: string;
    turnId: string;
    timestamp: number;
  }) {
    return new InteractionRepository(this.dataSource).respond(input);
  }

  async insertReplyPlaceholder(input: {
    id: string;
    sessionId: string;
    turnId: string;
    timestamp: number;
  }): Promise<void> {
    await this.dataSource.insertSessionMessageRow({
      id: input.id,
      session_id: input.sessionId,
      agent_id: "chief_editor",
      turn_id: input.turnId,
      role: "assistant",
      content: [],
      message: null,
      status: "running",
      display: true,
      metadata: {},
      provider: null,
      model: null,
      timestamp: input.timestamp,
    });
  }

  async failAgentMessage(messageId: string, status: "failed" | "interrupted"): Promise<void> {
    await this.dataSource.patchSessionMessageRow(messageId, { status });
  }

  async saveMessageTrace(messageId: string, trace: PersistedChatTrace): Promise<void> {
    await this.dataSource.patchSessionMessageRow(messageId, { metadata: { trace } });
  }

  async loadAgentContext(
    sessionId: string,
    agentId: AgentId,
    model: ModelDescriptor,
  ): Promise<{ summary: string | null; messages: StoredAgentMessage[] }> {
    const state = await this.dataSource.getAgentStateRow(sessionId, agentId);
    const afterSequence = state?.summary_through_sequence ?? 0;
    return {
      summary: state?.summary ?? null,
      messages: await this.loadAgentTranscript(sessionId, agentId, model, afterSequence),
    };
  }

  async saveAgentSummary(
    sessionId: string,
    agentId: AgentId,
    summary: string,
    throughSequence: number,
  ): Promise<void> {
    await this.dataSource.upsertAgentStateRow({
      session_id: sessionId,
      agent_id: agentId,
      summary,
      summary_through_sequence: throughSequence,
    });
  }

  async persistTranscriptDelta(input: {
    sessionId: string;
    turnId: string;
    before: Record<AgentId, import("@earendil-works/pi-agent-core").AgentMessage[]>;
    after: Record<AgentId, import("@earendil-works/pi-agent-core").AgentMessage[]>;
    finalAssistant: import("@earendil-works/pi-agent-core").AgentMessage;
  }): Promise<void> {
    for (const agentId of AGENT_IDS) {
      const appended = input.after[agentId].slice(input.before[agentId].length);
      for (const message of appended) {
        if (agentId === "chief_editor" && (message.role === "user" || message === input.finalAssistant)) {
          continue;
        }
        if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
          continue;
        }
        await this.insertAgentMessage({
          id: randomUUID(),
          sessionId: input.sessionId,
          turnId: input.turnId,
          agentId,
          message,
          status: "complete",
          display: false,
        });
      }
    }
  }

  async patchSessionState(sessionId: string, patch: Partial<SessionRow>): Promise<void> {
    await this.dataSource.patchSessionRow(sessionId, patch);
  }

  async enqueueMemoryCapture(input: EnqueueMemoryCaptureInput): Promise<void> {
    const now = new Date().toISOString();
    await this.dataSource.patchSessionRow(input.sessionId, {
      memory_ever_enabled: true,
      updated_at: now,
    });
    await this.dataSource.insertMemoryJobRow({
      id: input.id,
      session_id: input.sessionId,
      project_id: input.projectId,
      turn_id: input.turnId,
      operation: "capture",
      payload: {
        userMessage: input.userMessage,
        assistantResponse: input.assistantResponse,
      },
      status: "pending",
    });
  }

  async claimMemoryJobs(now: string, limit: number): Promise<MemoryJobRow[]> {
    return this.dataSource.claimMemoryJobRows(now, limit);
  }

  async completeMemoryJob(jobId: string): Promise<void> {
    await this.dataSource.patchMemoryJobRow(jobId, {
      status: "complete",
      last_error: null,
      updated_at: new Date().toISOString(),
    });
  }

  async retryMemoryJob(
    jobId: string,
    attempts: number,
    nextAttemptAt: string,
    error: string,
  ): Promise<void> {
    await this.dataSource.patchMemoryJobRow(jobId, {
      status: "failed",
      attempts,
      next_attempt_at: nextAttemptAt,
      last_error: error,
      updated_at: new Date().toISOString(),
    });
  }

  async listMemoryExclusionIds(projectId: string): Promise<string[]> {
    const rows = await this.dataSource.listMemoryExclusionRows(projectId);
    return rows.map((row) => row.external_memory_id);
  }

  async addMemoryExclusions(
    projectId: string,
    deletedSessionId: string,
    memoryIds: string[],
  ): Promise<void> {
    if (memoryIds.length === 0) return;
    await this.dataSource.insertMemoryExclusionRows(memoryIds.map((memoryId) => ({
      project_id: projectId,
      deleted_session_id: deletedSessionId,
      external_memory_id: memoryId,
    })));
  }

  async cancelPendingMemoryJobs(sessionId: string): Promise<boolean> {
    return this.dataSource.prepareSessionMemoryDelete(sessionId);
  }
}
