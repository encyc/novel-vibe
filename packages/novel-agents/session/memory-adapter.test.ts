import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProjectMemoryAdapter,
  formatRecallContext,
  startMemoryJobWorker,
  type MemoryIntegration,
  type MemoryJobStore,
} from "./memory-adapter.js";
import type { MemoryJobRow } from "./types.js";

function integration(): MemoryIntegration {
  return {
    scope: vi.fn().mockReturnThis(),
    agentRecall: vi.fn().mockResolvedValue({ memories: [] }),
    augmentation: vi.fn().mockResolvedValue(undefined),
  };
}

function job(overrides: Partial<MemoryJobRow> = {}): MemoryJobRow {
  return {
    id: "job-1",
    session_id: "session-1",
    project_id: "project-1",
    turn_id: "turn-1",
    operation: "capture",
    payload: { userMessage: "继续", assistantResponse: "收到" },
    status: "running",
    attempts: 0,
    next_attempt_at: "2026-06-29T00:00:00.000Z",
    last_error: null,
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("ProjectMemoryAdapter", () => {
  it("formats recalled content with stable language-neutral markers", () => {
    expect(formatRecallContext({
      status: "healthy",
      memories: [{ id: "m1", content: "角色名是林秋", score: 1, context: "chapter 1" }],
    })).toBe('<memory id="m1" context="chapter 1">角色名是林秋</memory>');
  });

  it("recalls project memories and filters exclusions, low scores, and excess results", async () => {
    const memori = integration();
    vi.mocked(memori.agentRecall).mockResolvedValue({
      facts: [
        { id: "excluded", content: "旧决定", score: 0.9 },
        ...Array.from({ length: 12 }, (_, index) => ({
          id: `keep-${index}`,
          content: `记忆 ${index}`,
          rank_score: 0.8,
        })),
        { id: "weak", content: "弱相关", similarity: 0.4 },
      ],
    });
    const exclusions = { listMemoryExclusionIds: vi.fn().mockResolvedValue(["excluded"]) };
    const adapter = new ProjectMemoryAdapter({
      projectId: "project-1",
      sessionId: "session-1",
      integration: memori,
      exclusions,
    });

    const result = await adapter.recall("query");

    expect(memori.agentRecall).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(result.status).toBe("healthy");
    expect(result.memories).toHaveLength(10);
    expect(result.memories.map((memory) => memory.id)).not.toContain("excluded");
    expect(result.memories.map((memory) => memory.id)).not.toContain("weak");
  });

  it("reports degraded recall when Memori throws or returns an indeterminate shape", async () => {
    const memori = integration();
    const adapter = new ProjectMemoryAdapter({
      projectId: "project-1",
      sessionId: "session-1",
      integration: memori,
      exclusions: { listMemoryExclusionIds: vi.fn().mockResolvedValue([]) },
    });

    vi.mocked(memori.agentRecall).mockRejectedValueOnce(new Error("offline"));
    await expect(adapter.recall("query")).resolves.toEqual({ memories: [], status: "degraded" });

    vi.mocked(memori.agentRecall).mockResolvedValueOnce({});
    await expect(adapter.recall("query")).resolves.toEqual({ memories: [], status: "degraded" });
  });

  it("treats a recognized empty result as healthy", async () => {
    const adapter = new ProjectMemoryAdapter({
      projectId: "project-1",
      sessionId: "session-1",
      integration: integration(),
      exclusions: { listMemoryExclusionIds: vi.fn().mockResolvedValue([]) },
    });

    await expect(adapter.recall("query")).resolves.toEqual({ memories: [], status: "healthy" });
  });

  it("captures a queued turn with the job session scope", async () => {
    const memori = integration();
    const adapter = new ProjectMemoryAdapter({
      projectId: "project-1",
      sessionId: "session-1",
      integration: memori,
      exclusions: { listMemoryExclusionIds: vi.fn().mockResolvedValue([]) },
    });

    await expect(adapter.capture(job())).resolves.toBe("healthy");
    expect(memori.scope).toHaveBeenCalledWith("session-1", "project-1");
    expect(memori.augmentation).toHaveBeenCalledWith(expect.objectContaining({
      userMessage: { role: "user", content: "继续", type: "text" },
      agentResponse: { role: "assistant", content: "收到", type: "text" },
    }));
  });

  it("returns degraded instead of throwing when capture fails", async () => {
    const memori = integration();
    vi.mocked(memori.augmentation).mockRejectedValue(new Error("offline"));
    const adapter = new ProjectMemoryAdapter({
      projectId: "project-1",
      sessionId: "session-1",
      integration: memori,
      exclusions: { listMemoryExclusionIds: vi.fn().mockResolvedValue([]) },
    });

    await expect(adapter.capture(job())).resolves.toBe("degraded");
  });

  it("refuses to capture a job from another project", async () => {
    const memori = integration();
    const adapter = new ProjectMemoryAdapter({
      projectId: "project-1",
      sessionId: "session-1",
      integration: memori,
      exclusions: { listMemoryExclusionIds: vi.fn().mockResolvedValue([]) },
    });

    await expect(adapter.capture(job({ project_id: "project-2" }))).resolves.toBe("degraded");
    expect(memori.augmentation).not.toHaveBeenCalled();
  });

  it("enumerates IDs for one session and rejects indeterminate deletion results", async () => {
    const memori = integration();
    const adapter = new ProjectMemoryAdapter({
      projectId: "project-1",
      sessionId: "session-1",
      integration: memori,
      exclusions: { listMemoryExclusionIds: vi.fn().mockResolvedValue([]) },
    });
    vi.mocked(memori.agentRecall).mockResolvedValueOnce({ results: [
      { id: 12, content: "A" },
      { id: "13", content: "B" },
    ] });

    await expect(adapter.enumerateSessionMemoryIds("session-old")).resolves.toEqual(["12", "13"]);
    expect(memori.agentRecall).toHaveBeenCalledWith({ projectId: "project-1", sessionId: "session-old" });

    vi.mocked(memori.agentRecall).mockResolvedValueOnce({});
    await expect(adapter.enumerateSessionMemoryIds("session-old"))
      .rejects.toMatchObject({ code: "MEMORY_DELETE_UNAVAILABLE" });
  });
});

describe("startMemoryJobWorker", () => {
  afterEach(() => vi.useRealTimers());

  it("completes successful jobs and retries degraded jobs with capped exponential backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T00:00:00.000Z"));
    const rows = [job(), job({ id: "job-2", attempts: 8 })];
    const store: MemoryJobStore = {
      claimMemoryJobs: vi.fn().mockResolvedValueOnce(rows).mockResolvedValue([]),
      completeMemoryJob: vi.fn().mockResolvedValue(undefined),
      retryMemoryJob: vi.fn().mockResolvedValue(undefined),
    };
    const capture = vi.fn()
      .mockResolvedValueOnce("healthy")
      .mockResolvedValueOnce("degraded");

    const stop = startMemoryJobWorker({
      repository: store,
      adapter: { capture },
      intervalMs: 60_000,
      batchSize: 5,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.completeMemoryJob).toHaveBeenCalledWith("job-1");
    expect(store.retryMemoryJob).toHaveBeenCalledWith(
      "job-2",
      9,
      "2026-06-29T01:00:00.000Z",
      expect.stringContaining("Memori capture degraded"),
    );
    await stop();
  });
});
