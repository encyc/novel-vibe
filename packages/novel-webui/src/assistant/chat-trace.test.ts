import { describe, expect, it } from "vitest";
import type { ChatStreamEvent, PersistedChatTrace } from "../types";
import {
  initialChatTrace,
  interruptChatTrace,
  reduceChatTrace,
  restorePersistedChatTrace,
  summarizeTopLevel,
} from "./chat-trace";

function event(value: { type: string; [key: string]: unknown }): ChatStreamEvent {
  return {
    version: 1,
    runId: "run-1",
    seq: 1,
    timestamp: 1000,
    ...value,
  } as ChatStreamEvent;
}

describe("reduceChatTrace", () => {
  it("aggregates thinking deltas into one ordered block", () => {
    let state = initialChatTrace("message-1");
    state = reduceChatTrace(state, event({
      type: "thinking_delta",
      agentId: "writer",
      blockId: "writer:0:0",
      delta: "先",
    }));
    state = reduceChatTrace(state, event({
      type: "thinking_delta",
      seq: 2,
      agentId: "writer",
      blockId: "writer:0:0",
      delta: "写",
    }));

    expect(state.thinking["writer:0:0"].text).toBe("先写");
    expect(state.order).toEqual(["thinking:writer:0:0"]);
  });

  it("tracks a nested tool through updates and failure", () => {
    let state = initialChatTrace("message-1");
    state = reduceChatTrace(state, event({
      type: "tool_started",
      agentId: "writer",
      parentToolCallId: "delegate-1",
      toolCallId: "write-1",
      toolName: "write_doc",
      args: { path: "text/1.md" },
    }));
    state = reduceChatTrace(state, event({
      type: "tool_updated",
      seq: 2,
      agentId: "writer",
      parentToolCallId: "delegate-1",
      toolCallId: "write-1",
      toolName: "write_doc",
      partialResult: { status: "working" },
    }));
    state = reduceChatTrace(state, event({
      type: "tool_finished",
      seq: 3,
      agentId: "writer",
      parentToolCallId: "delegate-1",
      toolCallId: "write-1",
      toolName: "write_doc",
      result: { error: "storage" },
      isError: true,
      durationMs: 30,
    }));

    expect(state.tools["write-1"]).toMatchObject({
      parentToolCallId: "delegate-1",
      partialResult: { status: "working" },
      result: { error: "storage" },
      status: "failed",
      durationMs: 30,
    });
    expect(state.order).toEqual(["tool:write-1"]);
  });

  it("records Agent lifecycle and sub-agent output", () => {
    let state = initialChatTrace("message-1");
    state = reduceChatTrace(state, event({ type: "agent_started", agentId: "writer", parentToolCallId: "delegate-1" }));
    state = reduceChatTrace(state, event({ type: "agent_output_delta", seq: 2, agentId: "writer", parentToolCallId: "delegate-1", delta: "初稿" }));
    state = reduceChatTrace(state, event({ type: "agent_finished", seq: 3, agentId: "writer", parentToolCallId: "delegate-1" }));

    expect(Object.values(state.activities)[0]).toMatchObject({ agentId: "writer", status: "finished" });
    expect(Object.values(state.outputs)[0]).toMatchObject({ agentId: "writer", text: "初稿" });
    expect(state.order).toHaveLength(2);
  });

  it("ignores duplicates, stale sequence numbers, unknown events, and other runs", () => {
    let state = initialChatTrace("message-1");
    const started = event({ type: "run_started" });
    state = reduceChatTrace(state, started);
    state = reduceChatTrace(state, started);
    state = reduceChatTrace(state, event({ type: "future_event", seq: 2 }));
    state = reduceChatTrace(state, event({ type: "agent_started", seq: 3, runId: "run-2", agentId: "writer" }));
    state = reduceChatTrace(state, event({ type: "run_failed", seq: 4, message: "overloaded", durationMs: 20 }));

    expect(state.order).toHaveLength(0);
    expect(state.lastSeq).toBe(4);
    expect(state.status).toBe("failed");
    expect(state.error).toBe("overloaded");
  });

  it("marks a client-side stream interruption", () => {
    const state = interruptChatTrace(initialChatTrace("message-1"), "连接中断");
    expect(state).toMatchObject({ status: "interrupted", error: "连接中断" });
  });

  it("reduces a server-confirmed interruption", () => {
    const state = reduceChatTrace(initialChatTrace("message-1"), event({
      type: "run_interrupted",
      message: "已停止生成",
      durationMs: 10,
    }));

    expect(state).toMatchObject({
      status: "interrupted",
      error: "已停止生成",
      durationMs: 10,
    });
  });

  it("reduces a live document change into stable order", () => {
    const state = reduceChatTrace(initialChatTrace("message-1"), event({
      type: "document_changed",
      agentId: "writer",
      toolCallId: "write-1",
      versionId: "v1",
      path: "text/1.md",
      versionNo: 1,
      addedLines: 3,
      deletedLines: 1,
      changedSections: ["开篇"],
    }));
    expect(state.documentChanges.v1).toMatchObject({
      versionId: "v1", path: "text/1.md", versionNo: 1, agentId: "writer",
    });
    expect(state.order).toEqual(["document:v1"]);
  });

  it("tracks the latest run plan and interaction resolution", () => {
    let state = initialChatTrace("message-1");
    state = reduceChatTrace(state, event({
      type: "run_plan_updated",
      plan: { schemaVersion: 1, id: "p1", title: "Plan", items: [{ id: "a", title: "A", status: "in_progress" }] },
    }));
    state = reduceChatTrace(state, event({
      type: "interaction_requested", seq: 2,
      interaction: { schemaVersion: 1, id: "i1", title: "Choose", fields: [], references: [], allowFreeAnswer: true },
    }));
    state = reduceChatTrace(state, event({ type: "interaction_resolved", seq: 3, interactionId: "i1", answers: [], freeAnswer: "Proceed" }));
    expect(state.runPlan).toMatchObject({ id: "p1" });
    expect(state.interactions.i1).toMatchObject({ status: "resolved", freeAnswer: "Proceed" });
  });
});

describe("summarizeTopLevel", () => {
  function runDelegation() {
    let state = initialChatTrace("message-1");
    state = reduceChatTrace(state, event({ type: "run_started" }));
    state = reduceChatTrace(state, event({ seq: 2, type: "tool_started", agentId: "chief_editor", toolCallId: "call-d", toolName: "delegate_to_agent", args: { agent: "writer", task_description: "补写第二幕分镜" } }));
    state = reduceChatTrace(state, event({ seq: 3, type: "agent_started", agentId: "writer", parentToolCallId: "call-d" }));
    state = reduceChatTrace(state, event({ seq: 4, type: "thinking_delta", agentId: "writer", parentToolCallId: "call-d", blockId: "w0", delta: "先理一下第二幕的转折点" }));
    state = reduceChatTrace(state, event({ seq: 5, type: "agent_output_delta", agentId: "writer", parentToolCallId: "call-d", delta: "分镜初稿第一段。" }));
    state = reduceChatTrace(state, event({
      seq: 6, type: "tool_started", agentId: "writer", parentToolCallId: "call-d",
      toolCallId: "write-9", toolName: "write_doc", args: { path: "text/ch-002.md" },
    }));
    return state;
  }

  it("groups every sub-agent burst under its delegate call and keeps it collapsed-ready", () => {
    const running = summarizeTopLevel(runDelegation());
    const live = running.delegations.get("call-d");
    expect(live).not.toBeNull();
    expect(live).toMatchObject({
      agentId: "writer",
      running: true,
      isError: false,
      latestActivity: "write_doc",
    });
    expect(live?.childKeys).toEqual(["agent:writer:3", "thinking:w0", "output:call-d:writer", "tool:write-9"]);
    // The chief-side delegate tool itself anchors the collapsed row.
    expect(running.items.map((item) => item.key)).toEqual(["delegation:call-d"]);
    expect(running.delegations.get("call-d")?.label).toBe("补写第二幕分镜");

    const finishedState = (() => {
      let state = runDelegation();
      state = reduceChatTrace(state, event({
        seq: 7, type: "tool_finished", agentId: "chief_editor",
        toolCallId: "call-d", toolName: "delegate_to_agent",
        result: { summary: "done" }, isError: false, durationMs: 4200,
      }));
      return state;
    })();
    const done = summarizeTopLevel(finishedState);
    expect(done.delegations.get("call-d")).toMatchObject({
      running: false,
      durationMs: 4200,
      agentId: "writer",
    });
  });

  it("keeps document artifacts top-level even when produced inside a delegation", () => {
    let state = runDelegation();
    state = reduceChatTrace(state, event({
      seq: 7, type: "document_changed", agentId: "writer",
      versionId: "v9", path: "text/ch-002.md", versionNo: 1,
      addedLines: 12, deletedLines: 0, changedSections: ["第二幕"],
    }));
    const plan = summarizeTopLevel(state);
    expect(plan.items.map((item) => item.key)).toContain("document:v9");
    expect(plan.items[plan.items.length - 1]?.key).toBe("document:v9");
    expect(plan.delegations.get("call-d")?.childKeys).not.toContain("document:v9");
  });

  it("groups restored persisted traces identically to live streams", () => {
    const persisted: PersistedChatTrace = {
      version: 1 as const,
      status: "succeeded" as const,
      startedAt: 1000,
      durationMs: 900,
      steps: [
        { id: "tool:call-d", type: "tool" as const, agentId: "chief_editor", status: "succeeded" as const, toolName: "delegate_to_agent", args: {}, result: { ok: true }, isError: false, durationMs: 900 },
        { id: "agent:writer:3", type: "agent" as const, agentId: "writer", parentToolCallId: "call-d", status: "finished" as const },
        { id: "output:call-d:writer", type: "output" as const, agentId: "writer", parentToolCallId: "call-d", text: "分镜完成。" },
      ],
    };
    const restored = restorePersistedChatTrace(persisted, "message-1", "complete");
    const plan = summarizeTopLevel(restored);
    expect(plan.items.map((item) => item.key)).toEqual(["delegation:call-d"]);
    expect(plan.delegations.get("call-d")?.label).toBeNull();
    expect(plan.delegations.get("call-d")).toMatchObject({
      agentId: "writer",
      running: false,
      childKeys: ["agent:writer:3", "output:call-d:writer"],
    });
  });
});
