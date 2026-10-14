import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  decodeStoredMessage,
  encodeAgentMessage,
  extractDelegationRef,
  toDelegationTranscriptEntry,
  toDisplayMessage,
} from "./message-codec.js";
import type { ModelDescriptor, SessionMessageRow } from "./types.js";

const model: ModelDescriptor = {
  api: "openai-completions",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  contextWindow: 128_000,
};

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function row(overrides: Partial<SessionMessageRow> = {}): SessionMessageRow {
  return {
    id: "message-1",
    session_id: "session-1",
    sequence: 1,
    agent_id: "chief_editor",
    turn_id: "turn-1",
    role: "assistant",
    content: [{ type: "text", text: "旧回复" }],
    message: null,
    status: "complete",
    display: true,
    metadata: { legacy: true },
    provider: null,
    model: "legacy-model",
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe("session message codec", () => {
  it("round-trips standard pi messages", () => {
    const user: UserMessage = { role: "user", content: "继续", timestamp: 1 };
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read_doc", arguments: { path: "a.md" } }],
      api: model.api,
      provider: model.provider,
      model: model.model,
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: 2,
    };
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read_doc",
      content: [{ type: "text", text: "正文" }],
      isError: false,
      timestamp: 3,
    };

    for (const message of [user, assistant, toolResult]) {
      const encoded = encodeAgentMessage(message);
      expect(decodeStoredMessage(row({ role: message.role, message: encoded }), model)).toEqual(message);
    }
  });

  it("converts a legacy assistant without inventing billable usage", () => {
    const decoded = decodeStoredMessage(row(), model);

    expect(decoded).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "旧回复" }],
      api: model.api,
      provider: model.provider,
      model: model.model,
      stopReason: "stop",
      usage: { totalTokens: 0 },
    });
  });

  it("rejects malformed new message payloads", () => {
    expect(() => decodeStoredMessage(row({ message: { role: "unknown" }, metadata: {} }), model))
      .toThrow("Invalid stored AgentMessage");
  });

  it("returns display DTOs only for visible chief editor user and assistant rows", () => {
    expect(toDisplayMessage(row())).toEqual({
      id: "message-1",
      turnId: "turn-1",
      role: "assistant",
      text: "旧回复",
      status: "complete",
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });
    expect(toDisplayMessage(row({ agent_id: "writer" }))).toBeNull();
    expect(toDisplayMessage(row({ display: false }))).toBeNull();
    expect(toDisplayMessage(row({ role: "toolResult" }))).toBeNull();
  });

  it("decodes a typed interaction response from user-message metadata", () => {
    const interactionResponse = {
      schemaVersion: 1 as const,
      interactionId: "interaction-1",
      idempotencyKey: "key-1",
      answers: [{ fieldId: "tone", type: "radio" as const, value: "warm" }],
      freeAnswer: "Keep it quiet.",
    };
    expect(toDisplayMessage(row({ role: "user", metadata: { interactionResponse } })))
      .toMatchObject({ interactionResponse });
  });
});

describe("delegation transcript projection", () => {
  it("projects assistant reasoning and text blocks in order", () => {
    const entry = toDelegationTranscriptEntry(row({
      id: "w1",
      agent_id: "writer",
      display: false,
      message: {
        role: "assistant", api: "x", provider: "p", model: "m",
        usage: { ...zeroUsage, totalTokens: 3 }, stopReason: "stop", timestamp: 1700000000000,
        content: [
          { type: "thinking", text: "先想" },
          { type: "text", text: "正文" },
        ],
      },
    }));
    expect(entry).not.toBeNull();
    expect(entry?.role).toBe("assistant");
    expect(entry?.blocks).toEqual([
      { kind: "reasoning", text: "先想" },
      { kind: "text", text: "正文" },
    ]);
    expect(entry?.createdAt).toBe(new Date(1700000000000).toISOString());
  });

  it("labels tool results with their tool name and falls back to legacy content", () => {
    const legacy = row({
      id: "t1",
      agent_id: "writer",
      display: false,
      role: "toolResult",
      content: [{ type: "text", text: "已写入章节" }],
      metadata: { toolCallId: "call-9", toolName: "write_doc" },
    });
    const entry = toDelegationTranscriptEntry(legacy);
    expect(entry?.role).toBe("tool");
    expect(entry?.blocks[0]).toMatchObject({ kind: "tool", text: "write_doc: 已写入章节" });
  });

  it("skips rows that carry no presentable content", () => {
    const empty = row({ agent_id: "writer", display: false, role: "user", content: [], message: null });
    expect(toDelegationTranscriptEntry(empty)).toBeNull();
  });

  it("resolves the delegated agent from an adjacent agent step before call args", () => {
    const trace = {
      version: 1,
      steps: [
        { id: "call-d", type: "tool", agentId: "chief_editor", status: "succeeded",
          toolName: "delegate_to_agent", args: { agent: "writer", task_description: "X" } },
        { id: "agent:writer:9", type: "agent", agentId: "writer", parentToolCallId: "call-d", status: "finished" },
      ],
    };
    expect(extractDelegationRef({ trace }, "call-d", "turn-7")).toEqual({
      agentId: "writer", turnId: "turn-7",
    });
    // Args-only traces still resolve.
    const argsOnly = {
      version: 1,
      steps: [
        { id: "call-e", type: "tool", agentId: "chief_editor", status: "running",
          toolName: "delegate_to_agent", args: { agent: "director" } },
      ],
    };
    expect(extractDelegationRef({ trace: argsOnly }, "call-e", "turn-8")).toEqual({
      agentId: "director", turnId: "turn-8",
    });
    expect(extractDelegationRef({ trace: null }, "call-d", "turn-7")).toBeNull();
    expect(extractDelegationRef({}, "missing", "turn-7")).toBeNull();
  });
});
