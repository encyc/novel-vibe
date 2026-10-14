import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRepository, type SessionDataSource } from "./repository.js";
import { AGENT_IDS, type MemoryJobRow, type ModelDescriptor, type SessionMessageRow } from "./types.js";

const model: ModelDescriptor = {
  api: "openai-completions",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  contextWindow: 128_000,
};

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    project_id: "project-1",
    title: "第一章节奏",
    title_is_custom: false,
    processing_lease_id: null,
    processing_started_at: null,
    memory_status: "healthy",
    memory_ever_enabled: false,
    last_opened_at: "2026-06-29T08:00:00.000Z",
    last_message_at: "2026-06-29T09:00:00.000Z",
    created_at: "2026-06-29T07:00:00.000Z",
    updated_at: "2026-06-29T09:00:00.000Z",
    message_count: 2,
    lifecycle_status: "active",
    archived_at: null,
    ...overrides,
  };
}

function messageRow(overrides: Partial<SessionMessageRow> = {}): SessionMessageRow {
  return {
    id: "message-1",
    session_id: "session-1",
    sequence: 1,
    agent_id: "chief_editor",
    turn_id: "turn-1",
    role: "user",
    content: [{ type: "text", text: "继续" }],
    message: { role: "user", content: "继续", timestamp: 1_700_000_000_000 },
    status: "complete",
    display: true,
    metadata: {},
    provider: null,
    model: null,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe("SessionRepository", () => {
  let dataSource: SessionDataSource;
  let repository: SessionRepository;

  beforeEach(() => {
    dataSource = {
      getOwnedSessionRow: vi.fn().mockResolvedValue(sessionRow()),
      listSessionRows: vi.fn().mockResolvedValue([sessionRow()]),
      getActiveSessionId: vi.fn().mockResolvedValue("session-1"),
      insertSessionRow: vi.fn().mockResolvedValue(sessionRow()),
      patchSessionRow: vi.fn().mockResolvedValue(sessionRow()),
      deleteSessionRow: vi.fn().mockResolvedValue(undefined),
      listDisplayMessageRows: vi.fn().mockResolvedValue([messageRow()]),
      listSessionInteractionRows: vi.fn().mockResolvedValue([]),
      getSessionInteractionRow: vi.fn().mockResolvedValue(null),
      insertSessionInteractionRow: vi.fn(),
      respondToSessionInteraction: vi.fn(),
      listAgentMessageRows: vi.fn().mockResolvedValue([messageRow()]),
      insertSessionMessageRow: vi.fn().mockResolvedValue(messageRow()),
      patchSessionMessageRow: vi.fn().mockResolvedValue(messageRow()),
      acquireSessionLease: vi.fn().mockResolvedValue(true),
      releaseSessionLease: vi.fn().mockResolvedValue(true),
      insertMemoryJobRow: vi.fn().mockResolvedValue(undefined),
      claimMemoryJobRows: vi.fn().mockResolvedValue([]),
      patchMemoryJobRow: vi.fn().mockResolvedValue(undefined),
      listMemoryExclusionRows: vi.fn().mockResolvedValue([]),
      insertMemoryExclusionRows: vi.fn().mockResolvedValue(undefined),
      getAgentStateRow: vi.fn().mockResolvedValue(null),
      upsertAgentStateRow: vi.fn().mockResolvedValue(undefined),
      prepareSessionMemoryDelete: vi.fn().mockResolvedValue(true),
    };
    repository = new SessionRepository(dataSource);
  });

  it("requires a session owned by the authenticated user", async () => {
    await expect(repository.requireOwnedSession("session-1", "user-1"))
      .resolves.toMatchObject({ id: "session-1", project_id: "project-1" });
    expect(dataSource.getOwnedSessionRow).toHaveBeenCalledWith("session-1", "user-1");

    vi.mocked(dataSource.getOwnedSessionRow).mockResolvedValueOnce(null);
    await expect(repository.requireOwnedSession("missing", "user-1"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("lists sessions with a stable cursor and an independent active session", async () => {
    vi.mocked(dataSource.listSessionRows).mockResolvedValueOnce([
      sessionRow(),
      sessionRow({ id: "session-2", last_message_at: "2026-06-28T09:00:00.000Z" }),
      sessionRow({ id: "session-3", last_message_at: "2026-06-27T09:00:00.000Z" }),
    ]);
    vi.mocked(dataSource.getActiveSessionId).mockResolvedValueOnce("session-3");

    const page = await repository.listProjectSessions({
      projectId: "project-1",
      userId: "user-1",
      limit: 2,
    });

    expect(page.items.map((item) => item.id)).toEqual(["session-1", "session-2"]);
    expect(page.activeSessionId).toBe("session-3");
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(dataSource.listSessionRows).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }));
  });

  it("exposes whether a session title was customized", async () => {
    const page = await repository.listProjectSessions({
      projectId: "project-1",
      userId: "user-1",
    });

    expect(page.items[0]).toMatchObject({ titleIsCustom: false });
  });

  it("keeps active and archived pagination scopes independent", async () => {
    await repository.listProjectSessions({
      projectId: "project-1",
      userId: "user-1",
      lifecycleStatus: "archived",
      cursor: Buffer.from(JSON.stringify({
        lastMessageAt: "2026-06-29T09:00:00.000Z",
        id: "session-1",
      })).toString("base64url"),
    });

    expect(dataSource.listSessionRows).toHaveBeenCalledWith(expect.objectContaining({
      lifecycleStatus: "archived",
    }));
    expect(dataSource.getActiveSessionId).not.toHaveBeenCalled();
  });

  it("archives and restores sessions without changing memory eligibility", async () => {
    vi.mocked(dataSource.patchSessionRow)
      .mockResolvedValueOnce(sessionRow({ lifecycle_status: "archived", archived_at: "2026-06-30T00:00:00.000Z" }))
      .mockResolvedValueOnce(sessionRow({ lifecycle_status: "active", archived_at: null }));

    await repository.setLifecycleStatus("session-1", "archived", new Date("2026-06-30T00:00:00.000Z"));
    await repository.setLifecycleStatus("session-1", "active", new Date("2026-06-30T00:01:00.000Z"));

    expect(dataSource.patchSessionRow).toHaveBeenNthCalledWith(1, "session-1", {
      lifecycle_status: "archived",
      archived_at: "2026-06-30T00:00:00.000Z",
      updated_at: "2026-06-30T00:00:00.000Z",
    });
    expect(dataSource.patchSessionRow).toHaveBeenNthCalledWith(2, "session-1", {
      lifecycle_status: "active",
      archived_at: null,
      updated_at: "2026-06-30T00:01:00.000Z",
    });
  });

  it("rejects invalid cursors before querying", async () => {
    await expect(repository.listProjectSessions({
      projectId: "project-1",
      userId: "user-1",
      limit: 5,
      cursor: "not-base64-json",
    })).rejects.toMatchObject({ code: "INVALID_CURSOR", status: 400 });
    expect(dataSource.listSessionRows).not.toHaveBeenCalled();
  });

  it("rejects non-finite limits before querying", async () => {
    await expect(repository.listProjectSessions({
      projectId: "project-1",
      userId: "user-1",
      limit: Number("abc"),
    })).rejects.toMatchObject({ code: "INVALID_LIMIT", status: 400 });
    expect(dataSource.listSessionRows).not.toHaveBeenCalled();
  });

  it("creates a new session with the default title", async () => {
    await repository.createSession("project-1", "user-1", "session-1");

    expect(dataSource.insertSessionRow).toHaveBeenCalledWith(expect.objectContaining({
      id: "session-1",
      project_id: "project-1",
      title: "新会话",
    }), "user-1");
  });

  it("persists a trace snapshot on the assistant message and returns it in display history", async () => {
    const trace = { version: 1 as const, runId: "run-1", status: "succeeded" as const, steps: [] };
    await repository.saveMessageTrace("reply-1", trace);
    expect(dataSource.patchSessionMessageRow).toHaveBeenCalledWith("reply-1", { metadata: { trace } });

    vi.mocked(dataSource.listDisplayMessageRows).mockResolvedValueOnce([
      messageRow({ id: "reply-1", role: "assistant", metadata: { trace } }),
    ]);
    const page = await repository.listDisplayMessages({ sessionId: "session-1", userId: "user-1" });
    expect(page.items[0]).toMatchObject({ id: "reply-1", trace });
  });

  it("loads interactions for the selected assistant-message page in one bounded batch", async () => {
    const request = {
      schemaVersion: 1 as const,
      id: "interaction-1",
      title: "Direction",
      fields: [{ id: "tone", type: "radio" as const, label: "Tone", required: true, options: [{ value: "warm", label: "Warm" }] }],
      references: [],
      allowFreeAnswer: true,
    };
    vi.mocked(dataSource.listDisplayMessageRows).mockResolvedValueOnce([
      messageRow({ id: "reply-1", role: "assistant" }),
      messageRow({ id: "user-1", role: "user", sequence: 2 }),
    ]);
    vi.mocked(dataSource.listSessionInteractionRows).mockResolvedValueOnce([{
      id: "interaction-1", project_id: "project-1", session_id: "session-1", turn_id: "turn-1",
      assistant_message_id: "reply-1", request, status: "pending", response: null,
      response_message_id: null, idempotency_key: null, responded_by: null, responded_at: null,
      created_at: "2026-08-17T00:00:00.000Z", updated_at: "2026-08-17T00:00:00.000Z",
    }]);

    const page = await repository.listDisplayMessages({ sessionId: "session-1", userId: "user-1" });
    expect(dataSource.listSessionInteractionRows).toHaveBeenCalledWith(["reply-1", "user-1"]);
    expect(page.items.find((message) => message.id === "reply-1")?.interactions)
      .toEqual([expect.objectContaining({ id: "interaction-1", request })]);
  });

  it("opens, renames, and deletes only owned sessions", async () => {
    await repository.openSession("session-1", "user-1");
    await repository.renameSession("session-1", "user-1", "人物动机");
    await repository.deleteSession("session-1", "user-1");

    expect(dataSource.patchSessionRow).toHaveBeenNthCalledWith(1, "session-1", {
      last_opened_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(dataSource.patchSessionRow).toHaveBeenNthCalledWith(2, "session-1", {
      title: "人物动机",
      title_is_custom: true,
      updated_at: expect.any(String),
    });
    expect(dataSource.deleteSessionRow).toHaveBeenCalledWith("session-1");
  });

  it("stores complete pi messages and completes reply placeholders", async () => {
    const userMessage = { role: "user" as const, content: "继续", timestamp: 1_700_000_000_000 };
    await repository.insertAgentMessage({
      id: "message-1",
      sessionId: "session-1",
      turnId: "turn-1",
      agentId: "chief_editor",
      message: userMessage,
      status: "complete",
      display: true,
    });
    await repository.completeAgentMessage("message-2", {
      role: "assistant",
      content: [{ type: "text", text: "收到" }],
      api: model.api,
      provider: model.provider,
      model: model.model,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 1_700_000_000_100,
    });

    expect(dataSource.insertSessionMessageRow).toHaveBeenCalledWith(expect.objectContaining({
      role: "user",
      message: userMessage,
      content: "继续",
    }));
    expect(dataSource.patchSessionMessageRow).toHaveBeenCalledWith("message-2", expect.objectContaining({
      status: "complete",
      display: true,
      role: "assistant",
    }));
  });

  it("returns only display messages and paginates by sequence", async () => {
    vi.mocked(dataSource.listDisplayMessageRows).mockResolvedValueOnce([
      messageRow({ id: "message-3", sequence: 3 }),
      messageRow({ id: "message-2", sequence: 2, role: "assistant", message: {
        role: "assistant",
        content: [{ type: "text", text: "收到" }],
        api: model.api,
        provider: model.provider,
        model: model.model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 1_700_000_000_100,
      } }),
      messageRow(),
    ]);

    const page = await repository.listDisplayMessages({
      sessionId: "session-1",
      userId: "user-1",
      limit: 2,
    });

    expect(page.items.map((item) => item.text)).toEqual(["收到", "继续"]);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it("loads and decodes an agent transcript", async () => {
    const transcript = await repository.loadAgentTranscript(
      "session-1",
      "chief_editor",
      model,
      0,
    );

    expect(transcript).toEqual([{
      sequence: 1,
      turnId: "turn-1",
      agentId: "chief_editor",
      message: { role: "user", content: "继续", timestamp: 1_700_000_000_000 },
    }]);
  });

  it("acquires and releases leases through the data source", async () => {
    await expect(repository.acquireLease("session-1", "lease-1", 60_000)).resolves.toBe(true);
    await repository.releaseLease("session-1", "lease-1");

    expect(dataSource.acquireSessionLease).toHaveBeenCalledWith(
      "session-1",
      "lease-1",
      expect.any(String),
    );
    expect(dataSource.releaseSessionLease).toHaveBeenCalledWith("session-1", "lease-1");
  });

  it("enqueues, claims, completes, and retries durable memory jobs", async () => {
    const claimed = [{ id: "job-1", attempts: 0 }] as MemoryJobRow[];
    vi.mocked(dataSource.claimMemoryJobRows).mockResolvedValueOnce(claimed);

    await repository.enqueueMemoryCapture({
      id: "job-1",
      sessionId: "session-1",
      projectId: "project-1",
      turnId: "turn-1",
      userMessage: "继续",
      assistantResponse: "收到",
    });
    await expect(repository.claimMemoryJobs("2026-06-29T00:00:00.000Z", 5)).resolves.toBe(claimed);
    await repository.completeMemoryJob("job-1");
    await repository.retryMemoryJob("job-1", 2, "2026-06-29T00:01:00.000Z", "offline");

    expect(dataSource.insertMemoryJobRow).toHaveBeenCalledWith(expect.objectContaining({
      id: "job-1",
      payload: { userMessage: "继续", assistantResponse: "收到" },
      status: "pending",
    }));
    expect(dataSource.patchMemoryJobRow).toHaveBeenNthCalledWith(1, "job-1", expect.objectContaining({
      status: "complete",
      last_error: null,
    }));
    expect(dataSource.patchMemoryJobRow).toHaveBeenNthCalledWith(2, "job-1", expect.objectContaining({
      status: "failed",
      attempts: 2,
      next_attempt_at: "2026-06-29T00:01:00.000Z",
      last_error: "offline",
    }));
  });

  it("lists and inserts durable memory exclusions", async () => {
    vi.mocked(dataSource.listMemoryExclusionRows).mockResolvedValueOnce([
      { external_memory_id: "m1" },
      { external_memory_id: "m2" },
    ]);

    await expect(repository.listMemoryExclusionIds("project-1")).resolves.toEqual(["m1", "m2"]);
    await repository.addMemoryExclusions("project-1", "session-old", ["m1", "m2"]);

    expect(dataSource.insertMemoryExclusionRows).toHaveBeenCalledWith([
      { project_id: "project-1", deleted_session_id: "session-old", external_memory_id: "m1" },
      { project_id: "project-1", deleted_session_id: "session-old", external_memory_id: "m2" },
    ]);
  });

  it("stores user messages, reply placeholders, and failed replies", async () => {
    await repository.insertUserMessage({
      id: "user-1",
      sessionId: "session-1",
      turnId: "turn-1",
      content: "继续",
      timestamp: 100,
    });
    await repository.insertReplyPlaceholder({
      id: "reply-1",
      sessionId: "session-1",
      turnId: "turn-1",
      timestamp: 101,
    });
    await repository.failAgentMessage("reply-1", "failed");

    expect(dataSource.insertSessionMessageRow).toHaveBeenNthCalledWith(1, expect.objectContaining({
      role: "user",
      status: "complete",
      display: true,
    }));
    expect(dataSource.insertSessionMessageRow).toHaveBeenNthCalledWith(2, expect.objectContaining({
      role: "assistant",
      message: null,
      status: "running",
      display: true,
    }));
    expect(dataSource.patchSessionMessageRow).toHaveBeenCalledWith("reply-1", {
      status: "failed",
    });
  });

  it("loads summary state and atomically saves summary boundaries", async () => {
    vi.mocked(dataSource.getAgentStateRow).mockResolvedValueOnce({
      summary: "旧摘要",
      summary_through_sequence: 8,
    });
    vi.mocked(dataSource.listAgentMessageRows).mockResolvedValueOnce([
      messageRow({ sequence: 9 }),
    ]);

    const context = await repository.loadAgentContext("session-1", "chief_editor", model);
    await repository.saveAgentSummary("session-1", "chief_editor", "新摘要", 9);

    expect(context.summary).toBe("旧摘要");
    expect(context.messages[0].sequence).toBe(9);
    expect(dataSource.listAgentMessageRows).toHaveBeenCalledWith("session-1", "chief_editor", 8);
    expect(dataSource.upsertAgentStateRow).toHaveBeenCalledWith({
      session_id: "session-1",
      agent_id: "chief_editor",
      summary: "新摘要",
      summary_through_sequence: 9,
    });
  });

  it("persists only appended transcript messages and leaves the final chief reply to its placeholder", async () => {
    const before = Object.fromEntries(AGENT_IDS.map((id) => [id, []])) as any;
    const final = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "最终回复" }],
      api: model.api,
      provider: model.provider,
      model: model.model,
      usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as const,
      timestamp: 3,
    };
    const after = {
      ...before,
      chief_editor: [
        { role: "user" as const, content: "继续", timestamp: 1 },
        final,
      ],
      writer: [
        { role: "user" as const, content: "写一段", timestamp: 1 },
        { ...final, content: [{ type: "text" as const, text: "正文" }] },
      ],
    };

    await repository.persistTranscriptDelta({
      sessionId: "session-1",
      turnId: "turn-1",
      before,
      after,
      finalAssistant: final,
    });

    expect(dataSource.insertSessionMessageRow).toHaveBeenCalledTimes(2);
    expect(dataSource.insertSessionMessageRow).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: "writer",
      role: "user",
      display: false,
    }));
    expect(dataSource.insertSessionMessageRow).toHaveBeenCalledWith(expect.objectContaining({
      agent_id: "writer",
      role: "assistant",
      display: false,
    }));
  });

  it("marks memory enabled before enqueue and prepares strong deletion", async () => {
    await repository.enqueueMemoryCapture({
      id: "job-1",
      sessionId: "session-1",
      projectId: "project-1",
      turnId: "turn-1",
      userMessage: "继续",
      assistantResponse: "收到",
    });
    await expect(repository.cancelPendingMemoryJobs("session-1")).resolves.toBe(true);

    expect(dataSource.patchSessionRow.mock.invocationCallOrder[0])
      .toBeLessThan(dataSource.insertMemoryJobRow.mock.invocationCallOrder[0]);
    expect(dataSource.patchSessionRow).toHaveBeenCalledWith("session-1", expect.objectContaining({
      memory_ever_enabled: true,
    }));
    expect(dataSource.prepareSessionMemoryDelete).toHaveBeenCalledWith("session-1");
  });
});
