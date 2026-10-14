import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { SupportedLanguage } from "../lib/language.js";
import type { Message } from "@earendil-works/pi-ai";
import { formatRecallContext, type RecallResult } from "./memory-adapter.js";
import type { SequencedMessage } from "./compactor.js";
import { ContextManager } from "../context/manager.js";
import {
  AGENT_IDS,
  SessionDomainError,
  type AgentId,
  type CursorPage,
  type DisplayMessageDto,
  type ModelDescriptor,
  type SessionDto,
  type SessionPage,
  type SessionLifecycleStatus,
  type SessionRow,
  type StoredAgentMessage,
} from "./types.js";
import { SessionTelemetry } from "./observability.js";
import type { InteractionResponseV1 } from "../interactions/types.js";
import type { DelegationTranscriptEntry } from "./message-codec.js";

interface RepositoryPort {
  listProjectSessions(input: {
    projectId: string; userId: string; limit?: number; cursor?: string; search?: string;
    lifecycleStatus?: SessionLifecycleStatus;
  }): Promise<SessionPage>;
  createSession(projectId: string, userId: string, id: string): Promise<SessionDto>;
  openSession(sessionId: string, userId: string): Promise<SessionDto>;
  renameSession(sessionId: string, userId: string, title: string): Promise<SessionDto>;
  listDisplayMessages(input: {
    sessionId: string; userId: string; limit?: number; cursor?: string;
  }): Promise<CursorPage<DisplayMessageDto>>;
  listDelegationMessages(input: {
    sessionId: string; userId: string; callId: string; limit?: number; cursor?: string;
  }): Promise<CursorPage<DelegationTranscriptEntry>>;
  requireOwnedSession(sessionId: string, userId: string): Promise<SessionRow>;
  acquireLease(sessionId: string, leaseId: string, ttlMs: number): Promise<boolean>;
  releaseLease(sessionId: string, leaseId: string): Promise<void>;
  insertUserMessage(input: {
    id: string; sessionId: string; turnId: string; content: string; timestamp: number;
  }): Promise<void>;
  respondToInteraction(input: {
    interactionId: string;
    userId: string;
    response: InteractionResponseV1;
    messageId: string;
    turnId: string;
    timestamp: number;
  }): Promise<{ outcome: "resolved" | "replayed" | "conflict"; responseMessageId?: string; response?: InteractionResponseV1 }>;
  insertReplyPlaceholder(input: {
    id: string; sessionId: string; turnId: string; timestamp: number;
  }): Promise<void>;
  loadAgentContext(
    sessionId: string,
    agentId: AgentId,
    model: ModelDescriptor,
  ): Promise<{ summary: string | null; messages: StoredAgentMessage[] }>;
  persistTranscriptDelta(input: {
    sessionId: string;
    turnId: string;
    before: Record<AgentId, AgentMessage[]>;
    after: Record<AgentId, AgentMessage[]>;
    finalAssistant: AgentMessage;
  }): Promise<void>;
  completeAgentMessage(messageId: string, message: Message): Promise<unknown>;
  failAgentMessage(messageId: string, status: "failed" | "interrupted"): Promise<void>;
  enqueueMemoryCapture(input: {
    id: string;
    sessionId: string;
    projectId: string;
    turnId: string;
    userMessage: string;
    assistantResponse: string;
  }): Promise<void>;
  patchSessionState(sessionId: string, patch: Partial<SessionRow>): Promise<void>;
  deleteSession(sessionId: string, userId: string): Promise<void>;
  setLifecycleStatus(sessionId: string, status: SessionLifecycleStatus, now: Date): Promise<SessionDto>;
}

interface OrchestratorPort {
  init(): Promise<void>;
  setSession(sessionId: string): void;
  setTurnId(turnId: string | null): void;
  setTurnContext?(turnId: string | null, assistantMessageId?: string | null): void;
  /** Scoped to the active turn: SessionService sets it before prompting and clears it in finally. */
  setByokTurnContext?(ctx: { apiKey: string } | null): void;
  restoreMessages(messages: Partial<Record<AgentId, AgentMessage[]>>): void;
  snapshotMessages(): Record<AgentId, AgentMessage[]>;
  getModelDescriptor(agentId: AgentId): ModelDescriptor;
  onDisplayEvents(handler: (event: AgentEvent) => void): () => void;
  onAllEvents(handler: (event: AgentEvent & { agentId: AgentId }) => void): Array<() => void>;
  abort(): void;
  chat(message: string): Promise<string>;
  getContextManager(): ContextManager;
}

interface MemoryPort {
  recall(query: string): Promise<RecallResult>;
}

interface ServiceOptions {
  repository: RepositoryPort;
  createOrchestrator(input: {
    token: string;
    projectId: string;
    userId: string;
    sessionId: string;
    provider?: string;
    model?: string;
    creativeLanguage: SupportedLanguage;
  }): Promise<OrchestratorPort>;
  createMemory(input: { userId: string; projectId: string; sessionId: string }): MemoryPort | null;
  telemetry?: SessionTelemetry;
  uuid?: () => string;
  now?: () => Date;
  leaseTtlMs?: number;
}

interface CachedOrchestrator {
  orchestrator: OrchestratorPort;
  contextManager: ContextManager;
  memory: MemoryPort | null;
  lastUsed: number;
  identity: string;
  creativeLanguage: SupportedLanguage;
  userId: string;
  projectId: string;
  sessionId: string;
}

interface ActiveTurn {
  userId: string;
  leaseId: string;
  orchestrator?: OrchestratorPort;
  interruptionRequested: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
}

export interface ChatInput {
  token: string;
  userId: string;
  projectId: string;
  sessionId: string;
  message: string;
  interactionResponse?: InteractionResponseV1;
  provider?: string;
  model?: string;
  /** Decrypted BYOK key for this turn; presence routes all model calls to the user's own provider account. */
  byokApiKey?: string;
  creativeLanguage: SupportedLanguage;
  eventSink?: (event: AgentEvent) => void;
  traceSink?: (event: AgentEvent & { agentId: AgentId }) => void;
  onTurnStarted?: (turn: { turnId: string; assistantMessageId: string }) => void;
}

function cacheIdentity(input: ChatInput): string {
  return JSON.stringify([
    input.userId,
    input.projectId,
    input.sessionId,
    input.provider ?? "",
    input.model ?? "",
  ]);
}

function cacheKey(input: ChatInput): string {
  return JSON.stringify([cacheIdentity(input), input.creativeLanguage]);
}

function isPersistableMessage(message: AgentMessage): message is Message {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function finalAssistant(snapshot: Record<AgentId, AgentMessage[]>): Message | null {
  const message = [...snapshot.chief_editor].reverse()
    .find((candidate) => candidate.role === "assistant");
  return message && isPersistableMessage(message) ? message : null;
}

function titleFromMessage(message: string): string {
  const normalized = message.trim().replace(/\s+/gu, " ");
  return [...normalized].slice(0, 30).join("") || "新会话";
}

export class SessionTurnInterruptedError extends Error {
  constructor() {
    super("Generation interrupted by user");
    this.name = "SessionTurnInterruptedError";
  }
}

export class SessionService {
  private readonly repository: RepositoryPort;
  private readonly createOrchestrator: ServiceOptions["createOrchestrator"];
  private readonly createMemory: ServiceOptions["createMemory"];
  private readonly telemetry: SessionTelemetry;
  private readonly uuid: () => string;
  private readonly now: () => Date;
  private readonly leaseTtlMs: number;
  private readonly cache = new Map<string, CachedOrchestrator>();
  private readonly activeTurns = new Map<string, ActiveTurn>();

  constructor(options: ServiceOptions) {
    this.repository = options.repository;
    this.createOrchestrator = options.createOrchestrator;
    this.createMemory = options.createMemory;
    this.telemetry = options.telemetry ?? new SessionTelemetry();
    this.uuid = options.uuid ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.leaseTtlMs = options.leaseTtlMs ?? 10 * 60 * 1000;
  }

  listSessions(input: {
    projectId: string; userId: string; limit?: number; cursor?: string; search?: string;
    lifecycleStatus?: SessionLifecycleStatus;
  }): Promise<SessionPage> {
    return this.repository.listProjectSessions(input);
  }

  createSession(input: { projectId: string; userId: string }): Promise<SessionDto> {
    return this.repository.createSession(input.projectId, input.userId, this.uuid());
  }

  openSession(input: { sessionId: string; userId: string }): Promise<SessionDto> {
    return this.repository.openSession(input.sessionId, input.userId);
  }

  renameSession(input: { sessionId: string; userId: string; title: string }): Promise<SessionDto> {
    return this.repository.renameSession(input.sessionId, input.userId, input.title);
  }

  listMessages(input: {
    sessionId: string; userId: string; limit?: number; cursor?: string;
  }): Promise<CursorPage<DisplayMessageDto>> {
    return this.repository.listDisplayMessages(input);
  }

  listDelegationMessages(input: {
    sessionId: string; userId: string; callId: string; limit?: number; cursor?: string;
  }): Promise<CursorPage<DelegationTranscriptEntry>> {
    return this.repository.listDelegationMessages(input);
  }

  archiveSession(input: { sessionId: string; userId: string }): Promise<SessionDto> {
    return this.setLifecycleStatus(input, "archived");
  }

  restoreSession(input: { sessionId: string; userId: string }): Promise<SessionDto> {
    return this.setLifecycleStatus(input, "active");
  }

  async deleteSession(input: { sessionId: string; userId: string }): Promise<void> {
    const row = await this.repository.requireOwnedSession(input.sessionId, input.userId);
    if (row.processing_lease_id) {
      throw new SessionDomainError("SESSION_NOT_DELETABLE", "Session is processing", 409);
    }
    // Sessions and project memory are intentionally decoupled: Memori stores
    // project-level facts (not session-owned data), so deleting a session only
    // removes its PostgreSQL conversation history. Project-level memory is
    // cleaned up by the project deletion worker, not here. See the decoupling
    // notes in the session/service design.
    this.evictSession(input.userId, row.project_id, input.sessionId);
    await this.repository.deleteSession(input.sessionId, input.userId);
  }

  async interruptSession(input: {
    sessionId: string;
    userId: string;
  }): Promise<{ interrupted: boolean }> {
    await this.repository.requireOwnedSession(input.sessionId, input.userId);
    const active = this.activeTurns.get(input.sessionId);
    if (!active || active.userId !== input.userId) return { interrupted: false };

    if (!active.interruptionRequested) {
      active.interruptionRequested = true;
      active.orchestrator?.abort();
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        active.settled,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 5_000);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return { interrupted: true };
  }

  async chat(input: ChatInput): Promise<{ reply: string; turnId: string; replayed?: boolean }> {
    const row = await this.repository.requireOwnedSession(input.sessionId, input.userId);
    if (row.project_id !== input.projectId) {
      throw new SessionDomainError("SESSION_FORBIDDEN", "Session does not belong to project", 403);
    }
    if (row.lifecycle_status === "archived") {
      throw new SessionDomainError("SESSION_READ_ONLY", "Archived Session is read-only", 409);
    }
    const leaseId = this.uuid();
    const turnId = this.uuid();
    const userMessageId = this.uuid();
    const replyMessageId = this.uuid();
    if (!await this.repository.acquireLease(input.sessionId, leaseId, this.leaseTtlMs)) {
      throw new SessionDomainError("SESSION_BUSY", "Session is already processing", 409);
    }

    let placeholderInserted = false;
    let active: ActiveTurn | undefined;
    try {
      const timestamp = this.now().getTime();
      if (input.interactionResponse) {
        const responseResult = await this.repository.respondToInteraction({
          interactionId: input.interactionResponse.interactionId,
          userId: input.userId,
          response: input.interactionResponse,
          messageId: userMessageId,
          turnId,
          timestamp,
        });
        if (responseResult.outcome === "conflict") {
          throw new SessionDomainError("INTERACTION_CONFLICT", "Interaction has already been answered", 409);
        }
        if (responseResult.outcome === "replayed") {
          return { reply: "", turnId, replayed: true };
        }
      } else {
        await this.repository.insertUserMessage({
          id: userMessageId,
          sessionId: input.sessionId,
          turnId,
          content: input.message,
          timestamp,
        });
      }
      await this.repository.insertReplyPlaceholder({
        id: replyMessageId,
        sessionId: input.sessionId,
        turnId,
        timestamp,
      });
      placeholderInserted = true;
      let resolveSettled!: () => void;
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });
      active = {
        userId: input.userId,
        leaseId,
        interruptionRequested: false,
        settled,
        resolveSettled,
      };
      this.activeTurns.set(input.sessionId, active);
      input.onTurnStarted?.({ turnId, assistantMessageId: replyMessageId });

      const entry = await this.getOrRestore(input, turnId);
      active.orchestrator = entry.orchestrator;
      if (entry.orchestrator.setTurnContext) entry.orchestrator.setTurnContext(turnId, replyMessageId);
      else entry.orchestrator.setTurnId(turnId);
      entry.orchestrator.setByokTurnContext?.(input.byokApiKey ? { apiKey: input.byokApiKey } : null);
      if (active.interruptionRequested) {
        entry.orchestrator.abort();
        throw new SessionTurnInterruptedError();
      }
      const before = entry.orchestrator.snapshotMessages();
      await this.prepareChiefContext(entry, input);

      const recall = entry.memory
        ? await entry.memory.recall(input.message)
        : { status: "healthy" as const, memories: [] };
      if (recall.status === "degraded") {
        await this.repository.patchSessionState(input.sessionId, { memory_status: "degraded" });
        this.telemetry.increment("session.memory_degraded_recall");
      }
      const memoryContext = formatRecallContext(recall);
      const enriched = memoryContext
        ? `${input.message}\n\n<project_memory>\n${memoryContext}\n</project_memory>`
        : input.message;

      const unsubscribe = entry.orchestrator.onDisplayEvents((event) => {
        if (!input.eventSink) return;
        try {
          input.eventSink(event);
        } catch {
          this.telemetry.increment("session.completed_after_disconnect");
        }
      });
      const traceUnsubscribes = input.traceSink
        ? entry.orchestrator.onAllEvents((event) => {
            try {
              input.traceSink?.(event);
            } catch {
              this.telemetry.increment("session.completed_after_disconnect");
            }
          })
        : [];

      let reply: string;
      try {
        reply = await entry.orchestrator.chat(enriched);
      } finally {
        unsubscribe();
        for (const traceUnsubscribe of traceUnsubscribes) traceUnsubscribe();
      }
      const after = entry.orchestrator.snapshotMessages();
      const final = finalAssistant(after);
      if (!final) throw new Error("Chief Editor did not produce a final assistant message");

      await this.repository.persistTranscriptDelta({
        sessionId: input.sessionId,
        turnId,
        before,
        after,
        finalAssistant: final,
      });
      await this.repository.completeAgentMessage(replyMessageId, final);
      if (!row.title_is_custom && row.message_count === 0) {
        await this.repository.patchSessionState(input.sessionId, {
          title: titleFromMessage(input.message),
          last_message_at: this.now().toISOString(),
          updated_at: this.now().toISOString(),
        });
      }
      if (entry.memory) {
        await this.repository.enqueueMemoryCapture({
          id: this.uuid(),
          sessionId: input.sessionId,
          projectId: input.projectId,
          turnId,
          userMessage: input.message,
          assistantResponse: reply,
        });
      }
      await this.restoreEntry(entry, input);
      entry.lastUsed = Date.now();
      return { reply, turnId };
    } catch (error) {
      const interrupted = active?.interruptionRequested === true;
      if (placeholderInserted) {
        await this.repository.failAgentMessage(replyMessageId, interrupted ? "interrupted" : "failed");
      }
      if (interrupted) throw new SessionTurnInterruptedError();
      throw error;
    } finally {
      try {
        if (active?.orchestrator?.setTurnContext) active.orchestrator.setTurnContext(null, null);
        else active?.orchestrator?.setTurnId(null);
        active?.orchestrator?.setByokTurnContext?.(null);
        await this.repository.releaseLease(input.sessionId, leaseId);
      } finally {
        if (this.activeTurns.get(input.sessionId)?.leaseId === leaseId) {
          this.activeTurns.delete(input.sessionId);
        }
        active?.resolveSettled();
      }
    }
  }

  evictIdle(maxIdleMs: number, now = Date.now()): number {
    let evicted = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.lastUsed > maxIdleMs) {
        this.cache.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }

  private evictSession(userId: string, projectId: string, sessionId: string): void {
    for (const [key, entry] of this.cache) {
      if (
        entry.userId === userId
        && entry.projectId === projectId
        && entry.sessionId === sessionId
      ) {
        this.cache.delete(key);
      }
    }
  }

  private async setLifecycleStatus(
    input: { sessionId: string; userId: string },
    status: SessionLifecycleStatus,
  ): Promise<SessionDto> {
    const row = await this.repository.requireOwnedSession(input.sessionId, input.userId);
    if (row.processing_lease_id) {
      throw new SessionDomainError("SESSION_BUSY", "Session is processing", 409);
    }
    if (row.lifecycle_status === status) {
      return {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        titleIsCustom: row.title_is_custom,
        isProcessing: false,
        processingStartedAt: row.processing_started_at,
        memoryStatus: row.memory_status,
        messageCount: row.message_count,
        lastMessageAt: row.last_message_at,
        createdAt: row.created_at,
        lifecycleStatus: row.lifecycle_status,
      };
    }
    this.evictSession(input.userId, row.project_id, input.sessionId);
    return this.repository.setLifecycleStatus(input.sessionId, status, this.now());
  }

  private async getOrRestore(input: ChatInput, _turnId: string): Promise<CachedOrchestrator> {
    const key = cacheKey(input);
    const identity = cacheIdentity(input);
    for (const [existingKey, existing] of this.cache) {
      if (existing.identity === identity && existing.creativeLanguage !== input.creativeLanguage) {
        this.cache.delete(existingKey);
      }
    }
    const cached = this.cache.get(key);
    if (cached) return cached;

    const orchestrator = await this.createOrchestrator({
      token: input.token,
      projectId: input.projectId,
      userId: input.userId,
      sessionId: input.sessionId,
      provider: input.provider,
      model: input.model,
      creativeLanguage: input.creativeLanguage,
    });
    await orchestrator.init();
    orchestrator.setSession(input.sessionId);
    const contextManager = orchestrator.getContextManager();
    contextManager.setCreativeLanguage(input.creativeLanguage);

    const entry = {
      orchestrator,
      contextManager,
      memory: this.createMemory({
        userId: input.userId,
        projectId: input.projectId,
        sessionId: input.sessionId,
      }),
      lastUsed: Date.now(),
      identity,
      creativeLanguage: input.creativeLanguage,
      userId: input.userId,
      projectId: input.projectId,
      sessionId: input.sessionId,
    };
    await this.restoreEntry(entry, input);
    this.cache.set(key, entry);
    return entry;
  }

  private async restoreEntry(entry: CachedOrchestrator, input: ChatInput): Promise<void> {
    const messages: Partial<Record<AgentId, AgentMessage[]>> = {};
    for (const agentId of AGENT_IDS) {
      const ctx = await entry.contextManager.buildContext(agentId, input.sessionId);
      messages[agentId] = ctx.messages;
    }
    entry.orchestrator.restoreMessages(messages);
  }

  private async prepareChiefContext(entry: CachedOrchestrator, input: ChatInput): Promise<void> {
    const model = entry.orchestrator.getModelDescriptor("chief_editor");
    const restored = await entry.contextManager.restorer.restore("chief_editor", input.sessionId, model);
    const result = await entry.contextManager.compactMessages({
      sessionId: input.sessionId,
      agentId: "chief_editor",
      messages: restored.sequenced,
    });
    if (result.status === "compacted") {
      const snapshot = entry.orchestrator.snapshotMessages();
      snapshot.chief_editor = result.messages;
      entry.orchestrator.restoreMessages(snapshot);
      this.telemetry.increment("session.compaction_success");
    } else if (result.status === "degraded") {
      this.telemetry.increment("session.compaction_failure");
    }
  }
}
