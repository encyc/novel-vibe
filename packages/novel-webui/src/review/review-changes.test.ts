import { describe, expect, it } from "vitest";
import type { PersistedChatTrace, SessionMessage } from "../types";
import { deriveReviewGroups } from "./review-changes";

function message(patch: Partial<SessionMessage> & { role: SessionMessage["role"] }): SessionMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    turnId: "turn-1",
    status: "complete",
    text: "",
    createdAt: "2026-08-20T10:00:00.000Z",
    ...patch,
  } as SessionMessage;
}

function traceWithChanges(count: number): PersistedChatTrace {
  return {
    version: 1,
    status: "succeeded",
    steps: Array.from({ length: count }, (_, index) => ({
      type: "document_change" as const,
      id: `dc-${index}`,
      agentId: "writer" as const,
      toolCallId: `call-${index}`,
      versionId: `version-${index}`,
      path: `chapters/00${index}.md`,
      versionNo: index + 1,
      addedLines: 10 + index,
      deletedLines: 2 + index,
      changedSections: [`第${index}节`],
    })),
  };
}

describe("deriveReviewGroups", () => {
  it("groups persisted document changes per turn, newest turn first", () => {
    const first = traceWithChanges(1);
    const second = traceWithChanges(2);
    const messages: SessionMessage[] = [
      message({ role: "user", turnId: "t1", text: "第一章：按新大纲重写开场。" }),
      message({ role: "assistant", turnId: "t1", trace: first }),
      message({ role: "user", turnId: "t2", text: "继续，把主角动机压实一点。", createdAt: "2026-08-20T11:00:00.000Z" }),
      message({ role: "assistant", turnId: "t2", trace: second, createdAt: "2026-08-20T11:00:01.000Z" }),
    ];

    const groups = deriveReviewGroups(messages);
    expect(groups.map((group) => group.turnId)).toEqual(["t2", "t1"]);
    expect(groups[0].changes).toHaveLength(2);
    expect(groups[0].prompt).toContain("主角动机");
    expect(groups[1].changes[0].path).toBe("chapters/000.md");
  });

  it("skips runs without document writes and truncates long prompts", () => {
    const messages: SessionMessage[] = [
      message({
        role: "user",
        turnId: "long",
        text: "这一轮只是讨论大纲思路并没有真正修改任何文档所以不应该出现在审查列表里".repeat(3),
      }),
      message({
        role: "assistant",
        turnId: "long",
        trace: { version: 1, status: "succeeded", steps: [] },
      }),
      message({ role: "user", turnId: "writes", text: "写入第二章草稿。" }),
      message({ role: "assistant", turnId: "writes", trace: traceWithChanges(1), createdAt: "2026-08-21T09:00:00.000Z" }),
    ];

    const groups = deriveReviewGroups(messages);
    expect(groups).toHaveLength(1);
    expect(groups[0].prompt).toBe("写入第二章草稿。");
  });

  it("falls back to an empty prompt when the user message is missing", () => {
    const groups = deriveReviewGroups([
      message({ role: "assistant", turnId: "orphan", trace: traceWithChanges(1) }),
    ]);
    expect(groups[0].prompt).toBe("");
  });
});
