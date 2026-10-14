import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./file-tools.js";
import { createInteractionTools } from "./interaction-tools.js";

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    projectId: "project-1",
    sessionId: "session-1",
    turnId: "turn-1",
    assistantMessageId: "assistant-1",
    interactionRepository: { create: vi.fn().mockImplementation(async ({ request }) => ({ id: request.id, assistantMessageId: "assistant-1", request, status: "pending" })) },
    db: { getDocumentVersion: vi.fn().mockResolvedValue(null) },
    ...overrides,
  } as unknown as ToolContext;
}

describe("interaction tools", () => {
  it("publishes a complete validated run plan snapshot", async () => {
    const [updatePlan] = createInteractionTools(context());
    const result = await updatePlan.execute("call-1", {
      id: "draft",
      title: "Draft chapter",
      items: [{ id: "read", title: "Read context", status: "in_progress" }],
    });
    expect(result.details).toEqual({
      runPlan: { schemaVersion: 1, id: "draft", title: "Draft chapter", items: [{ id: "read", title: "Read context", status: "in_progress" }] },
    });
  });

  it("persists an interaction before returning it for trace emission", async () => {
    const ctx = context();
    const [, requestInteraction] = createInteractionTools(ctx);
    const result = await requestInteraction.execute("call-2", {
      title: "Choose tone",
      fields: [{ id: "tone", type: "radio", label: "Tone", required: true, options: [{ value: "warm", label: "Warm" }] }],
      references: [],
      allow_free_answer: true,
    });
    expect(ctx.interactionRepository?.create).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({ interaction: { title: "Choose tone", allowFreeAnswer: true } });
    expect(result.isError).not.toBe(true);
  });

  it("requires active durable turn context", async () => {
    const [, requestInteraction] = createInteractionTools(context({ assistantMessageId: undefined }));
    const result = await requestInteraction.execute("call-3", {
      title: "Choose tone",
      fields: [{ id: "tone", type: "radio", label: "Tone", required: true, options: [{ value: "warm", label: "Warm" }] }],
      references: [],
      allow_free_answer: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/active durable turn/i) });
  });

  it("verifies referenced document versions before persistence", async () => {
    const ctx = context();
    const [, requestInteraction] = createInteractionTools(ctx);
    const result = await requestInteraction.execute("call-4", {
      title: "Approve revision",
      fields: [{ id: "decision", type: "radio", label: "Decision", required: true, options: [{ value: "approve", label: "Approve" }] }],
      references: [{ path: "chapters/001.md", version_id: "missing", version_no: 2 }],
      allow_free_answer: true,
    });
    expect(result.isError).toBe(true);
    expect(ctx.interactionRepository?.create).not.toHaveBeenCalled();
  });
});
