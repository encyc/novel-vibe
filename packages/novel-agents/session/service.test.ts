import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_IDS, type AgentId, type SessionRow } from "./types.js";
import { SessionService } from "./service.js";
import { ContextManager } from "../context/manager.js";

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "s1",
    project_id: "p1",
    title: "新会话",
    title_is_custom: false,
    processing_lease_id: null,
    processing_started_at: null,
    memory_status: "healthy",
    memory_ever_enabled: false,
    last_opened_at: "2026-06-29T00:00:00.000Z",
    last_message_at: "2026-06-29T00:00:00.000Z",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
    message_count: 0,
    lifecycle_status: "active",
    archived_at: null,
    ...overrides,
  };
}

function assistant(text = "回答"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
}

function emptySnapshot(): Record<AgentId, AgentMessage[]> {
  return Object.fromEntries(AGENT_IDS.map((id) => [id, []])) as Record<AgentId, AgentMessage[]>;
}

describe("SessionService", () => {
  let calls: string[];
  let repository: any;
  let orchestrator: any;
  let memory: any;
  let contextManager: ContextManager;
  let service: SessionService;

  beforeEach(() => {
    calls = [];
    let snapshot = emptySnapshot();
    repository = {
      listProjectSessions: vi.fn().mockResolvedValue({ items: [], nextCursor: null, activeSessionId: null }),
      createSession: vi.fn().mockResolvedValue({ id: "s1" }),
      openSession: vi.fn().mockResolvedValue({ id: "s1" }),
      renameSession: vi.fn().mockResolvedValue({ id: "s1" }),
      listDisplayMessages: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      requireOwnedSession: vi.fn().mockImplementation(async () => {
        calls.push("require-owned-session");
        return session();
      }),
      acquireLease: vi.fn().mockImplementation(async () => {
        calls.push("acquire-lease");
        return true;
      }),
      releaseLease: vi.fn().mockImplementation(async () => {
        calls.push("release-lease");
      }),
      insertUserMessage: vi.fn().mockImplementation(async () => {
        calls.push("insert-user");
      }),
      respondToInteraction: vi.fn().mockResolvedValue({ outcome: "resolved", responseMessageId: "user-message-1" }),
      insertReplyPlaceholder: vi.fn().mockImplementation(async () => {
        calls.push("insert-placeholder");
      }),
      loadAgentContext: vi.fn().mockResolvedValue({ summary: null, messages: [] }),
      persistTranscriptDelta: vi.fn().mockImplementation(async () => {
        calls.push("persist-transcripts");
      }),
      completeAgentMessage: vi.fn().mockImplementation(async () => {
        calls.push("complete-placeholder");
      }),
      failAgentMessage: vi.fn().mockResolvedValue(undefined),
      enqueueMemoryCapture: vi.fn().mockImplementation(async () => {
        calls.push("enqueue-memory");
      }),
      patchSessionState: vi.fn().mockResolvedValue(undefined),
      cancelPendingMemoryJobs: vi.fn().mockResolvedValue(true),
      addMemoryExclusions: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      setLifecycleStatus: vi.fn().mockResolvedValue({ id: "s1" }),
    };
    orchestrator = {
      init: vi.fn(),
      setSession: vi.fn(),
      setTurnId: vi.fn(),
      restoreMessages: vi.fn(),
      snapshotMessages: vi.fn().mockImplementation(() => snapshot),
      getModelDescriptor: vi.fn().mockReturnValue({
        api: "openai-completions",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        contextWindow: 1000,
      }),
      onDisplayEvents: vi.fn().mockReturnValue(() => {}),
      onAllEvents: vi.fn().mockReturnValue([]),
      getContextManager: vi.fn(() => contextManager),
      abort: vi.fn(),
      chat: vi.fn().mockImplementation(async () => {
        calls.push("run-agent");
        snapshot = { ...snapshot, chief_editor: [
          { role: "user", content: "继续", timestamp: 1 },
          assistant(),
        ] };
        return "回答";
      }),
    };
    memory = {
      recall: vi.fn().mockImplementation(async () => {
        calls.push("recall-memory");
        return { status: "healthy", memories: [] };
      }),
      enumerateSessionMemoryIds: vi.fn().mockResolvedValue([]),
    };
    contextManager = {
      buildContext: vi.fn().mockResolvedValue({
        systemPrompt: "test prompt",
        messages: [],
        contextWindow: 1000,
        estimatedTokens: 0,
        utilization: 0,
        summaryInjected: false,
        compactionStatus: "none",
      }),
      restorer: {
        restore: vi.fn().mockResolvedValue({
          sequenced: [],
          messages: [],
          summary: null,
        }),
      },
      compactMessages: vi.fn().mockImplementation(async ({ messages }: any) => {
        if (!calls.includes("compact-if-needed")) calls.push("compact-if-needed");
        return { status: "unchanged" as const, messages: messages.map((m: any) => m.message), sequenced: messages };
      }),
      setProjectId: vi.fn(),
      setUserId: vi.fn(),
      setCreativeLanguage: vi.fn(),
    } as any;
    service = new SessionService({
      repository,
      createOrchestrator: vi.fn().mockImplementation(async () => {
        calls.push("restore-orchestrator");
        return orchestrator;
      }),
      createMemory: vi.fn().mockReturnValue(memory),
      uuid: vi.fn()
        .mockReturnValueOnce("lease-1")
        .mockReturnValueOnce("turn-1")
        .mockReturnValueOnce("user-message-1")
        .mockReturnValueOnce("reply-1")
        .mockReturnValueOnce("memory-job-1"),
      now: () => new Date("2026-06-29T00:00:00.000Z"),
    });
  });

  it("executes a durable chat turn in the required order", async () => {
    const onTurnStarted = vi.fn();
    await expect(service.chat({
      token: "token",
      userId: "u1",
      projectId: "p1",
      sessionId: "s1",
      message: "继续",
      creativeLanguage: "zh-CN",
      onTurnStarted,
    })).resolves.toMatchObject({ reply: "回答", turnId: "turn-1" });

    expect(onTurnStarted).toHaveBeenCalledWith({ turnId: "turn-1", assistantMessageId: "reply-1" });
    expect(onTurnStarted.mock.invocationCallOrder[0]).toBeGreaterThan(repository.insertReplyPlaceholder.mock.invocationCallOrder[0]);
    expect(onTurnStarted.mock.invocationCallOrder[0]).toBeLessThan(orchestrator.chat.mock.invocationCallOrder[0]);
    expect(orchestrator.setTurnId).toHaveBeenCalledWith("turn-1");
    expect(orchestrator.setTurnId).toHaveBeenLastCalledWith(null);
    expect(orchestrator.setTurnId.mock.invocationCallOrder.at(-1))
      .toBeLessThan(repository.releaseLease.mock.invocationCallOrder[0]);

    expect(calls).toEqual([
      "require-owned-session",
      "acquire-lease",
      "insert-user",
      "insert-placeholder",
      "restore-orchestrator",
      "compact-if-needed",
      "recall-memory",
      "run-agent",
      "persist-transcripts",
      "complete-placeholder",
      "enqueue-memory",
      "release-lease",
    ]);
  });

  it("passes byokApiKey to the orchestrator for the turn and clears it afterwards", async () => {
    orchestrator.setByokTurnContext = vi.fn();
    await service.chat({
      token: "token",
      userId: "u1",
      projectId: "p1",
      sessionId: "s1",
      message: "继续",
      creativeLanguage: "zh-CN",
      byokApiKey: "sk-byok",
    });
    expect(orchestrator.setByokTurnContext).toHaveBeenNthCalledWith(1, { apiKey: "sk-byok" });
    expect(orchestrator.setByokTurnContext).toHaveBeenLastCalledWith(null);
  });

  it("atomically records an interaction response and binds both turn context ids", async () => {
    orchestrator.setTurnContext = vi.fn();
    const interactionResponse = {
      schemaVersion: 1 as const,
      interactionId: "interaction-1",
      idempotencyKey: "key-1",
      answers: [{ fieldId: "tone", type: "radio" as const, value: "warm" }],
      freeAnswer: "Keep it subtle.",
    };
    await service.chat({
      token: "token", userId: "u1", projectId: "p1", sessionId: "s1",
      message: "Structured interaction response",
      interactionResponse,
      creativeLanguage: "zh-CN",
    });

    expect(repository.respondToInteraction).toHaveBeenCalledWith(expect.objectContaining({
      interactionId: "interaction-1", response: interactionResponse,
      messageId: "user-message-1", turnId: "turn-1",
    }));
    expect(repository.insertUserMessage).not.toHaveBeenCalled();
    expect(orchestrator.setTurnContext).toHaveBeenNthCalledWith(1, "turn-1", "reply-1");
    expect(orchestrator.setTurnContext).toHaveBeenLastCalledWith(null, null);
  });

  it("does not create a duplicate assistant turn for an idempotent replay", async () => {
    repository.respondToInteraction.mockResolvedValueOnce({ outcome: "replayed", responseMessageId: "user-message-1" });
    await expect(service.chat({
      token: "token", userId: "u1", projectId: "p1", sessionId: "s1",
      message: "Structured interaction response",
      interactionResponse: {
        schemaVersion: 1, interactionId: "interaction-1", idempotencyKey: "key-1", answers: [],
      },
      creativeLanguage: "zh-CN",
    })).resolves.toMatchObject({ replayed: true });
    expect(repository.insertReplyPlaceholder).not.toHaveBeenCalled();
    expect(orchestrator.chat).not.toHaveBeenCalled();
  });

  it("uses a fresh cached orchestrator after project language changes", async () => {
    const createOrchestrator = vi.fn().mockResolvedValue(orchestrator);
    service = new SessionService({
      repository,
      createOrchestrator,
      createMemory: vi.fn().mockReturnValue(memory),
      uuid: vi.fn()
        .mockReturnValueOnce("lease-1")
        .mockReturnValueOnce("turn-1")
        .mockReturnValueOnce("user-message-1")
        .mockReturnValueOnce("reply-1")
        .mockReturnValueOnce("memory-job-1")
        .mockReturnValueOnce("lease-2")
        .mockReturnValueOnce("turn-2")
        .mockReturnValueOnce("user-message-2")
        .mockReturnValueOnce("reply-2")
        .mockReturnValueOnce("memory-job-2")
        .mockReturnValueOnce("lease-3")
        .mockReturnValueOnce("turn-3")
        .mockReturnValueOnce("user-message-3")
        .mockReturnValueOnce("reply-3")
        .mockReturnValueOnce("memory-job-3"),
    });
    const input = (creativeLanguage: "zh-CN" | "en") => ({
      token: "token",
      userId: "u1",
      projectId: "p1",
      sessionId: "s1",
      message: "Continue the novel",
      creativeLanguage,
    });

    await service.chat(input("zh-CN"));
    await service.chat(input("en"));
    await service.chat(input("zh-CN"));

    expect(createOrchestrator).toHaveBeenCalledTimes(3);
    expect(createOrchestrator).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ creativeLanguage: "en" }),
    );
  });

  it("wraps recalled project memory in stable protocol markers", async () => {
    memory.recall.mockResolvedValue({
      status: "healthy",
      memories: [{ content: "角色名是林秋", id: "memory-1", score: 1 }],
    });

    await service.chat({
      token: "token",
      userId: "u1",
      projectId: "p1",
      sessionId: "s1",
      message: "Continue",
      creativeLanguage: "en",
    });

    expect(orchestrator.chat).toHaveBeenCalledWith(expect.stringContaining("<project_memory>"));
    expect(orchestrator.chat).toHaveBeenCalledWith(expect.stringContaining("</project_memory>"));
    expect(orchestrator.chat).toHaveBeenCalledWith(expect.stringContaining("角色名是林秋"));
    expect(orchestrator.chat).not.toHaveBeenCalledWith(expect.stringContaining("以下是与本项目相关的记忆上下文"));
    expect(orchestrator.chat).not.toHaveBeenCalledWith(expect.stringContaining("[记忆]"));
  });

  it("releases the lease and marks the placeholder failed when generation fails", async () => {
    orchestrator.chat.mockRejectedValue(new Error("provider offline"));

    await expect(service.chat({
      token: "token",
      userId: "u1",
      projectId: "p1",
      sessionId: "s1",
      message: "继续",
      creativeLanguage: "zh-CN",
    })).rejects.toThrow("provider offline");

    expect(repository.failAgentMessage).toHaveBeenCalledWith("reply-1", "failed");
    expect(orchestrator.setTurnId).toHaveBeenCalledWith("turn-1");
    expect(orchestrator.setTurnId).toHaveBeenLastCalledWith(null);
    expect(repository.releaseLease).toHaveBeenCalledWith("s1", "lease-1");
    expect(repository.enqueueMemoryCapture).not.toHaveBeenCalled();
  });

  it("interrupts an owned active turn and persists interrupted", async () => {
    let rejectChat!: (error: Error) => void;
    orchestrator.chat.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectChat = reject;
    }));

    const running = service.chat({
      token: "token",
      userId: "u1",
      projectId: "p1",
      sessionId: "s1",
      message: "继续",
    });
    await vi.waitFor(() => expect(orchestrator.chat).toHaveBeenCalledOnce());

    const interrupting = service.interruptSession({ sessionId: "s1", userId: "u1" });
    await vi.waitFor(() => expect(orchestrator.abort).toHaveBeenCalledOnce());
    rejectChat(new Error("aborted"));

    await expect(interrupting).resolves.toEqual({ interrupted: true });
    await expect(running).rejects.toMatchObject({ name: "SessionTurnInterruptedError" });
    expect(repository.failAgentMessage).toHaveBeenCalledWith("reply-1", "interrupted");
    expect(orchestrator.setTurnId).toHaveBeenCalledWith("turn-1");
    expect(orchestrator.setTurnId).toHaveBeenLastCalledWith(null);
    expect(repository.releaseLease).toHaveBeenCalledWith("s1", "lease-1");
    expect(repository.enqueueMemoryCapture).not.toHaveBeenCalled();
  });

  it("returns false when an owned session has no active turn", async () => {
    await expect(service.interruptSession({ sessionId: "s1", userId: "u1" }))
      .resolves.toEqual({ interrupted: false });
    expect(repository.requireOwnedSession).toHaveBeenCalledWith("s1", "u1");
    expect(orchestrator.abort).not.toHaveBeenCalled();
  });

  it("does not let a disconnected event sink cancel generation", async () => {
    const sink = vi.fn().mockImplementation(() => {
      throw new Error("stream closed");
    });
    orchestrator.onDisplayEvents.mockImplementation((handler: (event: unknown) => void) => {
      handler({ type: "message_update" });
      return () => {};
    });

    await expect(service.chat({
      token: "token",
      userId: "u1",
      projectId: "p1",
      sessionId: "s1",
      message: "继续",
      creativeLanguage: "zh-CN",
      eventSink: sink,
    })).resolves.toMatchObject({ reply: "回答" });
    expect(orchestrator.chat).toHaveBeenCalled();
  });

  it("forwards tagged events from every agent to the trace sink", async () => {
    const traceSink = vi.fn();
    orchestrator.onAllEvents.mockImplementation((handler: (event: unknown) => void) => {
      handler({ type: "agent_start", agentId: "writer" });
      return [() => {}];
    });

    await service.chat({
      token: "token",
      userId: "u1",
      projectId: "p1",
      sessionId: "s1",
      message: "继续",
      creativeLanguage: "zh-CN",
      traceSink,
    });

    expect(traceSink).toHaveBeenCalledWith({ type: "agent_start", agentId: "writer" });
  });

  it("rejects a busy session without writing messages", async () => {
    repository.acquireLease.mockResolvedValue(false);

    await expect(service.chat({
      token: "token",
      userId: "u1",
      projectId: "p1",
      sessionId: "s1",
      message: "继续",
      creativeLanguage: "zh-CN",
    })).rejects.toMatchObject({ code: "SESSION_BUSY", status: 409 });
    expect(repository.insertUserMessage).not.toHaveBeenCalled();
  });

  it("rejects chat for an archived session before acquiring a lease", async () => {
    repository.requireOwnedSession.mockResolvedValueOnce(session({ lifecycle_status: "archived" }));

    await expect(service.chat({
      token: "token",
      userId: "u1",
      projectId: "p1",
      sessionId: "s1",
      message: "继续",
      creativeLanguage: "zh-CN",
    })).rejects.toMatchObject({ code: "SESSION_READ_ONLY", status: 409 });
    expect(repository.acquireLease).not.toHaveBeenCalled();
  });

  it("archives and restores an idle session idempotently", async () => {
    await service.archiveSession({ userId: "u1", sessionId: "s1" });
    repository.requireOwnedSession.mockResolvedValueOnce(session({ lifecycle_status: "archived" }));
    await service.archiveSession({ userId: "u1", sessionId: "s1" });
    repository.requireOwnedSession.mockResolvedValueOnce(session({ lifecycle_status: "archived" }));
    await service.restoreSession({ userId: "u1", sessionId: "s1" });

    expect(repository.setLifecycleStatus).toHaveBeenNthCalledWith(1, "s1", "archived", expect.any(Date));
    expect(repository.setLifecycleStatus).toHaveBeenNthCalledWith(2, "s1", "active", expect.any(Date));
  });

  it("evicts cached orchestrators when a Session lifecycle changes", async () => {
    await service.chat({
      token: "token",
      userId: "u1",
      projectId: "p1",
      sessionId: "s1",
      message: "继续",
      creativeLanguage: "zh-CN",
    });
    expect((service as any).cache.size).toBe(1);

    await service.archiveSession({ userId: "u1", sessionId: "s1" });

    expect((service as any).cache.size).toBe(0);
  });

  it("refuses to archive or restore a processing session", async () => {
    repository.requireOwnedSession.mockResolvedValue(session({ processing_lease_id: "lease-active" }));

    await expect(service.archiveSession({ userId: "u1", sessionId: "s1" }))
      .rejects.toMatchObject({ code: "SESSION_BUSY", status: 409 });
    await expect(service.restoreSession({ userId: "u1", sessionId: "s1" }))
      .rejects.toMatchObject({ code: "SESSION_BUSY", status: 409 });
    expect(repository.setLifecycleStatus).not.toHaveBeenCalled();
  });

  it("refuses deletion while processing", async () => {
    repository.requireOwnedSession.mockResolvedValueOnce(session({ processing_lease_id: "lease-active" }));

    await expect(service.deleteSession({ userId: "u1", sessionId: "s1" }))
      .rejects.toMatchObject({ code: "SESSION_NOT_DELETABLE", status: 409 });
    expect(repository.deleteSession).not.toHaveBeenCalled();
  });

  // ─── deleteSession: session/memory decoupling ──────────────────────────
  // Project memory (Memori) stores project-level facts, not session-owned
  // data, so deleting a session must NOT touch memory: no enumeration, no
  // exclusions, no 503 minefield. Only the PostgreSQL conversation history
  // is removed. Project-level memory cleanup lives in the project deletion
  // worker, not here.

  it("deletes a session without touching project memory (decoupled)", async () => {
    // A memory-enabled session that previously could not be deleted must now
    // delete cleanly, because the memory path is no longer entered.
    repository.requireOwnedSession.mockResolvedValueOnce(session({ memory_ever_enabled: true }));

    await service.deleteSession({ userId: "u1", sessionId: "s1" });

    expect(repository.deleteSession).toHaveBeenCalledWith("s1", "u1");
    expect(repository.addMemoryExclusions).not.toHaveBeenCalled();
    expect(memory.enumerateSessionMemoryIds).not.toHaveBeenCalled();
    expect(repository.cancelPendingMemoryJobs).not.toHaveBeenCalled();
  });

  it("never builds the memory adapter when deleting", async () => {
    // Even if Memori is offline / the adapter would fail, deleteSession must
    // succeed because it no longer depends on the memory adapter at all.
    const createMemory = vi.fn(() => { throw new Error("Memori unreachable"); });
    (service as any).createMemory = createMemory;

    await service.deleteSession({ userId: "u1", sessionId: "s1" });

    expect(createMemory).not.toHaveBeenCalled();
    expect(repository.deleteSession).toHaveBeenCalledWith("s1", "u1");
  });

  it("delegates CRUD and message listing to the repository", async () => {
    await service.listSessions({ userId: "u1", projectId: "p1" });
    await service.createSession({ userId: "u1", projectId: "p1" });
    await service.openSession({ userId: "u1", sessionId: "s1" });
    await service.renameSession({ userId: "u1", sessionId: "s1", title: "新标题" });
    await service.listMessages({ userId: "u1", sessionId: "s1" });

    expect(repository.listProjectSessions).toHaveBeenCalled();
    expect(repository.createSession).toHaveBeenCalled();
    expect(repository.openSession).toHaveBeenCalled();
    expect(repository.renameSession).toHaveBeenCalled();
    expect(repository.listDisplayMessages).toHaveBeenCalled();
  });

  it("uses contextManager to build context for all agents during restore", async () => {
    const createOrchestrator = vi.fn().mockResolvedValue(orchestrator);
    const buildContext = vi.fn().mockResolvedValue({
      systemPrompt: "test",
      messages: [],
      contextWindow: 1000,
      estimatedTokens: 0,
      utilization: 0,
      summaryInjected: false,
      compactionStatus: "none" as const,
    });
    const cm = {
      buildContext,
      restorer: {
        restore: vi.fn().mockResolvedValue({ sequenced: [], messages: [], summary: null }),
      },
      compactMessages: vi.fn().mockImplementation(async ({ messages }: any) => ({
        status: "unchanged" as const,
        messages: [],
        sequenced: messages,
      })),
      setProjectId: vi.fn(),
      setUserId: vi.fn(),
      setCreativeLanguage: vi.fn(),
    } as any;
    service = new SessionService({
      repository,
      createOrchestrator: vi.fn().mockImplementation(async () => ({
        ...orchestrator,
        getContextManager: () => cm,
      })),
      createMemory: vi.fn().mockReturnValue(memory),
      uuid: vi.fn()
        .mockReturnValueOnce("lease-1")
        .mockReturnValueOnce("turn-1")
        .mockReturnValueOnce("user-message-1")
        .mockReturnValueOnce("reply-1")
        .mockReturnValueOnce("memory-job-1"),
    });

    await service.chat({
      token: "token",
      userId: "u1",
      projectId: "p1",
      sessionId: "s1",
      message: "继续",
      creativeLanguage: "zh-CN",
    });

    expect(buildContext).toHaveBeenCalledWith("chief_editor", "s1");
  });

  it("isolates ContextManagers across concurrent projects and languages", async () => {
    repository.requireOwnedSession.mockImplementation(async (sessionId: string) =>
      session({ id: sessionId, project_id: sessionId === "s-zh" ? "p-zh" : "p-en" }));
    const managers = {
      "zh-CN": {
        ...contextManager,
        buildContext: vi.fn().mockResolvedValue({
          systemPrompt: "<project_language>zh-CN</project_language>",
          messages: [],
          contextWindow: 1000,
          estimatedTokens: 0,
          utilization: 0,
          summaryInjected: false,
          compactionStatus: "none",
        }),
        restorer: { restore: vi.fn().mockResolvedValue({ sequenced: [], messages: [], summary: null }) },
        compactMessages: vi.fn().mockResolvedValue({ status: "unchanged", messages: [], sequenced: [] }),
      },
      en: {
        ...contextManager,
        buildContext: vi.fn().mockResolvedValue({
          systemPrompt: "<project_language>en</project_language>",
          messages: [],
          contextWindow: 1000,
          estimatedTokens: 0,
          utilization: 0,
          summaryInjected: false,
          compactionStatus: "none",
        }),
        restorer: { restore: vi.fn().mockResolvedValue({ sequenced: [], messages: [], summary: null }) },
        compactMessages: vi.fn().mockResolvedValue({ status: "unchanged", messages: [], sequenced: [] }),
      },
    } as const;
    const createOrchestrator = vi.fn().mockImplementation(async ({ creativeLanguage }: any) => {
      let snapshot = emptySnapshot();
      return {
        ...orchestrator,
        getContextManager: () => managers[creativeLanguage as keyof typeof managers],
        snapshotMessages: vi.fn(() => snapshot),
        chat: vi.fn(async (message: string) => {
          await Promise.resolve();
          snapshot = {
            ...snapshot,
            chief_editor: [{ role: "user", content: message, timestamp: 1 }, assistant("done")],
          };
          return "done";
        }),
      };
    });
    let id = 0;
    service = new SessionService({
      repository,
      createOrchestrator,
      createMemory: vi.fn().mockReturnValue(null),
      uuid: () => `id-${++id}`,
    });

    await Promise.all([
      service.chat({
        token: "token",
        userId: "u1",
        projectId: "p-zh",
        sessionId: "s-zh",
        message: "继续",
        creativeLanguage: "zh-CN",
      }),
      service.chat({
        token: "token",
        userId: "u1",
        projectId: "p-en",
        sessionId: "s-en",
        message: "Continue",
        creativeLanguage: "en",
      }),
    ]);

    expect(managers["zh-CN"].buildContext).toHaveBeenCalledTimes(AGENT_IDS.length * 2);
    expect(managers.en.buildContext).toHaveBeenCalledTimes(AGENT_IDS.length * 2);
    expect(contextManager.buildContext).not.toHaveBeenCalled();
  });

});
