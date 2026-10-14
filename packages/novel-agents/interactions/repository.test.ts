import { describe, expect, it, vi } from "vitest";
import { InteractionRepository, type InteractionDataSource, type SessionInteractionRow } from "./repository.js";
import type { InteractionRequestV1, InteractionResponseV1 } from "./types.js";

const request: InteractionRequestV1 = {
  schemaVersion: 1,
  id: "interaction-1",
  title: "Direction",
  fields: [{ id: "tone", type: "radio", label: "Tone", required: true, options: [{ value: "warm", label: "Warm" }] }],
  references: [],
  allowFreeAnswer: true,
};

const response: InteractionResponseV1 = {
  schemaVersion: 1,
  interactionId: "interaction-1",
  idempotencyKey: "key-1",
  answers: [{ fieldId: "tone", type: "radio", value: "warm" }],
  freeAnswer: "Keep it restrained.",
};

function row(patch: Partial<SessionInteractionRow> = {}): SessionInteractionRow {
  return {
    id: "interaction-1",
    project_id: "project-1",
    session_id: "session-1",
    turn_id: "turn-1",
    assistant_message_id: "assistant-1",
    request,
    status: "pending",
    response: null,
    response_message_id: null,
    idempotency_key: null,
    responded_by: null,
    responded_at: null,
    created_at: "2026-08-17T00:00:00.000Z",
    updated_at: "2026-08-17T00:00:00.000Z",
    ...patch,
  };
}

describe("InteractionRepository", () => {
  it("creates a validated pending interaction", async () => {
    const source: InteractionDataSource = {
      insertSessionInteractionRow: vi.fn().mockResolvedValue(row()),
      getSessionInteractionRow: vi.fn().mockResolvedValue(row()),
      listSessionInteractionRows: vi.fn().mockResolvedValue([]),
      respondToSessionInteraction: vi.fn(),
    };
    const repository = new InteractionRepository(source);
    await expect(repository.create({ projectId: "project-1", sessionId: "session-1", turnId: "turn-1", assistantMessageId: "assistant-1", request }))
      .resolves.toMatchObject({ id: "interaction-1", status: "pending" });
    expect(source.insertSessionInteractionRow).toHaveBeenCalledWith(expect.objectContaining({ request, status: "pending" }));
  });

  it("lists rows for a bounded set of assistant messages", async () => {
    const source: InteractionDataSource = {
      insertSessionInteractionRow: vi.fn(),
      getSessionInteractionRow: vi.fn().mockResolvedValue(row()),
      listSessionInteractionRows: vi.fn().mockResolvedValue([row()]),
      respondToSessionInteraction: vi.fn(),
    };
    const repository = new InteractionRepository(source);
    await expect(repository.listForMessages(["assistant-1", "assistant-2"]))
      .resolves.toEqual([expect.objectContaining({ assistantMessageId: "assistant-1", request })]);
    expect(source.listSessionInteractionRows).toHaveBeenCalledWith(["assistant-1", "assistant-2"]);
  });

  it("returns the authoritative atomic response outcome", async () => {
    const source: InteractionDataSource = {
      insertSessionInteractionRow: vi.fn(),
      getSessionInteractionRow: vi.fn().mockResolvedValue(row()),
      listSessionInteractionRows: vi.fn().mockResolvedValue([]),
      respondToSessionInteraction: vi.fn().mockResolvedValue({ outcome: "resolved", response_message_id: "user-message-1", response }),
    };
    const repository = new InteractionRepository(source);
    await expect(repository.respond({ interactionId: "interaction-1", userId: "user-1", response, messageId: "user-message-1", turnId: "turn-2", timestamp: 123 }))
      .resolves.toEqual({ outcome: "resolved", responseMessageId: "user-message-1", response });
    expect(source.respondToSessionInteraction).toHaveBeenCalledOnce();
  });
});
