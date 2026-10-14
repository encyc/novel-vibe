import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistedTracePersistence, createPersistedTraceReducer } from "./persisted-chat-trace.js";
import type { ChatStreamEvent } from "./chat-trace.js";

function event(patch: Partial<ChatStreamEvent> & Pick<ChatStreamEvent, "type">): ChatStreamEvent {
  return { version: 1, runId: "run-1", seq: 1, timestamp: 100, ...patch } as ChatStreamEvent;
}

describe("persisted chat trace", () => {
  afterEach(() => vi.useRealTimers());
  it("stores structured tools and summarized thinking in event order", () => {
    const reducer = createPersistedTraceReducer({ maxBytes: 20_000 });
    reducer.push(event({ type: "run_started" }));
    reducer.push(event({ type: "thinking_finished", seq: 2, agentId: "writer", blockId: "b1", text: `  ${"构思 ".repeat(100)}  ` }));
    reducer.push(event({ type: "tool_started", seq: 3, agentId: "writer", toolCallId: "t1", toolName: "write_doc", args: { path: "a.md" } }));
    reducer.push(event({ type: "tool_finished", seq: 4, agentId: "writer", toolCallId: "t1", toolName: "write_doc", result: { ok: true }, isError: false, durationMs: 25 }));
    reducer.push(event({ type: "run_finished", seq: 5, durationMs: 90 }));

    const trace = reducer.snapshot();
    expect(trace).toMatchObject({ version: 1, runId: "run-1", status: "succeeded", durationMs: 90 });
    expect(trace.steps[0]).toMatchObject({ type: "thinking", agentId: "writer", status: "finished" });
    expect(trace.steps[0]).toHaveProperty("summary");
    expect((trace.steps[0] as { summary: string }).summary.length).toBeLessThanOrEqual(300);
    expect(trace.steps[1]).toMatchObject({ type: "tool", toolName: "write_doc", args: { path: "a.md" }, result: { ok: true }, status: "succeeded" });
  });

  it("bounds unsafe values and marks a trace truncated", () => {
    const reducer = createPersistedTraceReducer({ maxBytes: 900, maxStringLength: 120 });
    reducer.push(event({ type: "run_started" }));
    reducer.push(event({ type: "tool_started", seq: 2, agentId: "chief_editor", toolCallId: "t1", toolName: "huge", args: { text: "x".repeat(2_000) } }));
    reducer.push(event({ type: "tool_finished", seq: 3, agentId: "chief_editor", toolCallId: "t1", toolName: "huge", result: { text: "y".repeat(2_000) }, isError: false, durationMs: 1 }));

    const trace = reducer.snapshot();
    expect(trace.truncated).toBe(true);
    expect(JSON.stringify(trace).length).toBeLessThanOrEqual(900);
  });

  it("enforces the total limit in UTF-8 bytes", () => {
    const reducer = createPersistedTraceReducer({ maxBytes: 700, maxStringLength: 2_000 });
    reducer.push(event({ type: "tool_started", agentId: "writer", toolCallId: "t1", toolName: "write_doc", args: { content: "汉".repeat(300) } }));
    const encoded = new TextEncoder().encode(JSON.stringify(reducer.snapshot()));
    expect(encoded.byteLength).toBeLessThanOrEqual(700);
    expect(reducer.snapshot().truncated).toBe(true);
  });

  it("records failed terminal state without storing the canonical answer", () => {
    const reducer = createPersistedTraceReducer();
    reducer.push(event({ type: "answer_finished", text: "正文回复" }));
    reducer.push(event({ type: "run_failed", seq: 2, message: "boom", durationMs: 42 }));
    expect(reducer.snapshot()).toMatchObject({ status: "failed", error: "boom", durationMs: 42, steps: [] });
    expect(JSON.stringify(reducer.snapshot())).not.toContain("正文回复");
  });

  it("records interrupted terminal state distinctly from failure", () => {
    const reducer = createPersistedTraceReducer();
    reducer.push(event({
      type: "run_interrupted",
      message: "已停止生成",
      durationMs: 42,
    }));

    expect(reducer.snapshot()).toMatchObject({
      status: "interrupted",
      error: "已停止生成",
      durationMs: 42,
    });
  });

  it("throttles intermediate snapshots and force-retries the terminal snapshot", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(undefined);
    const persistence = createPersistedTracePersistence({ save, intervalMs: 500 });
    persistence.attach("reply-1");
    persistence.push(event({ type: "run_started" }));
    persistence.push(event({ type: "agent_started", seq: 2, agentId: "writer" }));
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);

    persistence.push(event({ type: "run_finished", seq: 3, durationMs: 20 }));
    await expect(persistence.flush(true)).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("reply-1", expect.objectContaining({ status: "succeeded" }));
  });

  it("persists a bounded first-class document change without body content", () => {
    const reducer = createPersistedTraceReducer();
    reducer.push(event({
      type: "tool_started", agentId: "writer", toolCallId: "t1", toolName: "write_doc",
      args: { path: "text/1.md", contentBytes: 18, contentRedacted: true },
    }));
    reducer.push(event({
      type: "document_changed", seq: 2, agentId: "writer", toolCallId: "t1",
      versionId: "v1", path: "text/1.md", versionNo: 1, addedLines: 2,
      deletedLines: 1, changedSections: ["开篇"],
    }));
    reducer.push(event({
      type: "document_changed", seq: 3, agentId: "writer", toolCallId: "t1",
      versionId: "v1", path: "text/1.md", versionNo: 1, addedLines: 2,
      deletedLines: 1, changedSections: ["开篇"],
    }));
    const snapshot = reducer.snapshot();
    expect(snapshot.steps.filter((step) => step.type === "document_change")).toEqual([{
      type: "document_change", id: "document:v1", agentId: "writer", toolCallId: "t1",
      versionId: "v1", path: "text/1.md", versionNo: 1, addedLines: 2,
      deletedLines: 1, changedSections: ["开篇"],
    }]);
    expect(JSON.stringify(snapshot)).not.toContain("SECRET NOVEL BODY");
  });

  it("keeps the latest run plan and resolves a durable interaction step", () => {
    const reducer = createPersistedTraceReducer();
    const interaction = { schemaVersion: 1 as const, id: "i1", title: "Choose", fields: [{ id: "tone", type: "radio" as const, label: "Tone", required: true, options: [{ value: "warm", label: "Warm" }] }], references: [], allowFreeAnswer: true };
    reducer.push(event({ type: "run_plan_updated", plan: { schemaVersion: 1, id: "p1", title: "Plan", items: [{ id: "a", title: "A", status: "pending" }] } }));
    reducer.push(event({ type: "run_plan_updated", seq: 2, plan: { schemaVersion: 1, id: "p1", title: "Plan", items: [{ id: "a", title: "A", status: "completed" }] } }));
    reducer.push(event({ type: "interaction_requested", seq: 3, interaction }));
    reducer.push(event({ type: "interaction_resolved", seq: 4, interactionId: "i1", answers: [], freeAnswer: "Proceed" }));
    const snapshot = reducer.snapshot();
    expect(snapshot.steps.filter((step) => step.type === "run_plan")).toEqual([
      expect.objectContaining({ plan: expect.objectContaining({ items: [expect.objectContaining({ status: "completed" })] }) }),
    ]);
    expect(snapshot.steps.filter((step) => step.type === "interaction")).toEqual([
      expect.objectContaining({ status: "resolved", freeAnswer: "Proceed" }),
    ]);
  });
});
