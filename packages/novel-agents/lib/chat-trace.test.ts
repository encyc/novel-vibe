import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createChatTraceAdapter } from "./chat-trace.js";

function runtimeEvent(event: unknown): AgentEvent {
  return event as AgentEvent;
}

describe("createChatTraceAdapter", () => {
  it("maps thinking and Chief Editor text with monotonic sequence numbers", () => {
    const emitted: unknown[] = [];
    const now = vi.fn()
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1010)
      .mockReturnValueOnce(1020);
    const trace = createChatTraceAdapter({ runId: "run-1", emit: (event) => emitted.push(event), now });

    trace.handle("chief_editor", runtimeEvent({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "分析", partial: {} },
    }));
    trace.handle("chief_editor", runtimeEvent({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "结论", partial: {} },
    }));

    expect(emitted).toEqual([
      expect.objectContaining({ version: 1, runId: "run-1", seq: 1, type: "thinking_delta", agentId: "chief_editor", blockId: "chief_editor:0:0", delta: "分析" }),
      expect.objectContaining({ version: 1, runId: "run-1", seq: 2, type: "answer_delta", agentId: "chief_editor", delta: "结论" }),
    ]);
  });

  it("nests sub-agent events under delegate_to_agent", () => {
    const emitted: any[] = [];
    const trace = createChatTraceAdapter({ runId: "run-1", emit: (event) => emitted.push(event), now: () => 1000 });

    trace.handle("chief_editor", runtimeEvent({
      type: "tool_execution_start",
      toolCallId: "delegate-1",
      toolName: "delegate_to_agent",
      args: { agent: "writer", task: "write", output_path: "text/1.md" },
    }));
    trace.handle("writer", runtimeEvent({ type: "agent_start" }));
    trace.handle("writer", runtimeEvent({
      type: "tool_execution_start",
      toolCallId: "write-1",
      toolName: "write_doc",
      args: { path: "text/1.md", content: "chapter" },
    }));

    expect(emitted[1]).toMatchObject({ type: "agent_started", agentId: "writer", parentToolCallId: "delegate-1" });
    expect(emitted[2]).toMatchObject({ type: "tool_started", agentId: "writer", parentToolCallId: "delegate-1", toolCallId: "write-1" });
  });

  it("preserves tool updates, results, errors, duration, and uncorrelated events", () => {
    const emitted: any[] = [];
    let clock = 1000;
    const trace = createChatTraceAdapter({ runId: "run-1", emit: (event) => emitted.push(event), now: () => clock });

    trace.handle("director", runtimeEvent({ type: "agent_start" }));
    clock = 1020;
    trace.handle("director", runtimeEvent({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read_doc", args: { path: "outline.md" } }));
    trace.handle("director", runtimeEvent({ type: "tool_execution_update", toolCallId: "read-1", toolName: "read_doc", args: {}, partialResult: { content: "partial" } }));
    clock = 1050;
    trace.handle("director", runtimeEvent({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read_doc", result: { content: "failed" }, isError: true }));

    expect(emitted[0]).toMatchObject({ type: "agent_started", agentId: "director", parentToolCallId: undefined });
    expect(emitted[2]).toMatchObject({ type: "tool_updated", partialResult: { content: "partial" } });
    expect(emitted[3]).toMatchObject({ type: "tool_finished", result: { content: "failed" }, isError: true, durationMs: 30 });
  });

  it("emits one terminal event and canonical answer", () => {
    const emitted: any[] = [];
    const trace = createChatTraceAdapter({ runId: "run-1", emit: (event) => emitted.push(event), now: () => 1000 });

    trace.answerFinished("最终回答");
    trace.answerFinished("重复回答");
    trace.runFinished();
    trace.runFinished();

    expect(emitted.filter((event) => event.type === "answer_finished")).toEqual([
      expect.objectContaining({ text: "最终回答" }),
    ]);
    expect(emitted.filter((event) => event.type === "run_finished")).toHaveLength(1);
  });

  it("promotes successful interaction tools into typed stream events", () => {
    const emitted: any[] = [];
    const trace = createChatTraceAdapter({ runId: "run-1", emit: (event) => emitted.push(event), now: () => 1000 });
    const plan = { schemaVersion: 1, id: "p1", title: "Plan", items: [{ id: "a", title: "A", status: "in_progress" }] };
    const interaction = { schemaVersion: 1, id: "i1", title: "Choose", fields: [{ id: "tone", type: "radio", label: "Tone", required: true, options: [{ value: "warm", label: "Warm" }] }], references: [], allowFreeAnswer: true };
    trace.handle("chief_editor", runtimeEvent({ type: "tool_execution_end", toolCallId: "p", toolName: "update_run_plan", result: { details: { runPlan: plan } }, isError: false }));
    trace.handle("chief_editor", runtimeEvent({ type: "tool_execution_end", toolCallId: "i", toolName: "request_user_interaction", result: { details: { interaction } }, isError: false }));
    trace.interactionResolved("i1", [{ fieldId: "tone", type: "radio", value: "warm" }], "More nuance");
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run_plan_updated", plan }),
      expect.objectContaining({ type: "interaction_requested", interaction }),
      expect.objectContaining({ type: "interaction_resolved", interactionId: "i1", freeAnswer: "More nuance" }),
    ]));
  });

  it("emits interruption as a distinct terminal event", () => {
    const emitted: any[] = [];
    let clock = 1000;
    const trace = createChatTraceAdapter({
      runId: "run-1",
      emit: (event) => emitted.push(event),
      now: () => clock,
    });
    clock = 1042;

    trace.runInterrupted("已停止生成");
    trace.runFailed("must be ignored");

    expect(emitted).toEqual([
      expect.objectContaining({
        type: "run_interrupted",
        message: "已停止生成",
        durationMs: 42,
      }),
    ]);
  });

  it("logs raw events only when explicitly enabled", () => {
    const log = vi.fn();
    const trace = createChatTraceAdapter({
      runId: "run-1",
      projectId: "project-1",
      emit: vi.fn(),
      now: () => 1000,
      rawLogEnabled: true,
      log,
    });

    trace.handle("writer", runtimeEvent({ type: "agent_start" }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"runId":"run-1"'));
  });

  it("does not log raw events by default", () => {
    const log = vi.fn();
    const trace = createChatTraceAdapter({ runId: "run-1", emit: vi.fn(), now: () => 1000, log });
    trace.handle("writer", runtimeEvent({ type: "agent_start" }));
    expect(log).not.toHaveBeenCalled();
  });

  it("does not let logging failures interrupt event delivery", () => {
    const emit = vi.fn();
    const trace = createChatTraceAdapter({
      runId: "run-1",
      emit,
      now: () => 1000,
      rawLogEnabled: true,
      log: () => { throw new Error("broken logger"); },
    });

    expect(() => trace.handle("writer", runtimeEvent({ type: "agent_start" }))).not.toThrow();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_started" }));
  });

  it("redacts write content and emits one safe document change", () => {
    const emitted: any[] = [];
    const log = vi.fn();
    const trace = createChatTraceAdapter({
      runId: "run-1",
      emit: (event) => emitted.push(event),
      now: () => 1000,
      rawLogEnabled: true,
      log,
    });
    trace.handle("writer", runtimeEvent({
      type: "tool_execution_start",
      toolCallId: "write-1",
      toolName: "write_doc",
      args: { path: "text/ch-001.md", content: "SECRET NOVEL BODY" },
    }));
    trace.handle("writer", runtimeEvent({
      type: "tool_execution_end",
      toolCallId: "write-1",
      toolName: "write_doc",
      result: {
        content: [{ type: "text", text: "Document written" }],
        details: {
          changed: true, path: "text/ch-001.md", versionId: "v1", versionNo: 1,
          addedLines: 2, deletedLines: 1, changedSections: ["开篇"], indexed: true,
        },
      },
      isError: false,
    }));

    expect(emitted[0]).toMatchObject({
      type: "tool_started",
      args: { path: "text/ch-001.md", contentBytes: 17, contentRedacted: true },
    });
    expect(emitted.filter((event) => event.type === "document_changed")).toEqual([
      expect.objectContaining({
        agentId: "writer", toolCallId: "write-1", versionId: "v1",
        path: "text/ch-001.md", versionNo: 1, addedLines: 2, deletedLines: 1,
        changedSections: ["开篇"],
      }),
    ]);
    expect(JSON.stringify(emitted)).not.toContain("SECRET NOVEL BODY");
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET NOVEL BODY");
  });

  it("ignores malformed document version details", () => {
    const emitted: any[] = [];
    const trace = createChatTraceAdapter({ runId: "run-1", emit: (event) => emitted.push(event) });
    trace.handle("writer", runtimeEvent({
      type: "tool_execution_end", toolCallId: "write-1", toolName: "write_doc",
      result: { details: { changed: true, versionId: "v1", path: "a.md" } }, isError: false,
    }));
    expect(emitted.some((event) => event.type === "document_changed")).toBe(false);
  });
});
