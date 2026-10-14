import type {
  InteractionRequestV1,
  InteractionResponseV1,
  InteractionStatus,
  SessionInteractionDto,
} from "./types.js";
import { validateInteractionRequest, validateInteractionResponse } from "./validation.js";

export interface SessionInteractionRow {
  id: string;
  project_id: string;
  session_id: string;
  turn_id: string;
  assistant_message_id: string;
  request: unknown;
  status: InteractionStatus;
  response: unknown | null;
  response_message_id: string | null;
  idempotency_key: string | null;
  responded_by: string | null;
  responded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InteractionRpcResult {
  outcome: "resolved" | "replayed" | "conflict";
  response_message_id?: string;
  response?: unknown;
}

export interface InteractionDataSource {
  insertSessionInteractionRow(row: Omit<SessionInteractionRow, "created_at" | "updated_at">): Promise<SessionInteractionRow>;
  getSessionInteractionRow(id: string): Promise<SessionInteractionRow | null>;
  listSessionInteractionRows(assistantMessageIds: string[]): Promise<SessionInteractionRow[]>;
  respondToSessionInteraction(input: {
    interactionId: string;
    response: InteractionResponseV1;
    idempotencyKey: string;
    responseMessageId: string;
    turnId: string;
    messageText: string;
    timestamp: number;
  }): Promise<InteractionRpcResult>;
}

export function sessionInteractionFromRow(row: SessionInteractionRow): SessionInteractionDto {
  const request = validateInteractionRequest(row.request);
  const response = row.response === null ? undefined : validateInteractionResponse(request, row.response);
  return {
    id: row.id,
    assistantMessageId: row.assistant_message_id,
    request,
    status: row.status,
    ...(response ? { response } : {}),
    ...(row.responded_at ? { respondedAt: row.responded_at } : {}),
  };
}

function formatInteractionResponseMessage(request: InteractionRequestV1, response: InteractionResponseV1): string {
  const labels = new Map(request.fields.map((field) => [field.id, field.label]));
  const lines = response.answers.map((answer) => {
    const rendered = Array.isArray(answer.value) ? answer.value.join(", ") : answer.value;
    return `${labels.get(answer.fieldId) ?? answer.fieldId}: ${rendered}`;
  });
  if (response.freeAnswer) lines.push(`Additional answer: ${response.freeAnswer}`);
  return `Structured response to “${request.title}”\n${lines.join("\n")}`;
}

export class InteractionRepository {
  constructor(private readonly dataSource: InteractionDataSource) {}

  async create(input: {
    projectId: string;
    sessionId: string;
    turnId: string;
    assistantMessageId: string;
    request: InteractionRequestV1;
  }): Promise<SessionInteractionDto> {
    const request = validateInteractionRequest(input.request);
    const row = await this.dataSource.insertSessionInteractionRow({
      id: request.id,
      project_id: input.projectId,
      session_id: input.sessionId,
      turn_id: input.turnId,
      assistant_message_id: input.assistantMessageId,
      request,
      status: "pending",
      response: null,
      response_message_id: null,
      idempotency_key: null,
      responded_by: null,
      responded_at: null,
    });
    return sessionInteractionFromRow(row);
  }

  async get(id: string): Promise<SessionInteractionDto | null> {
    const row = await this.dataSource.getSessionInteractionRow(id);
    return row ? sessionInteractionFromRow(row) : null;
  }

  async listForMessages(assistantMessageIds: string[]): Promise<SessionInteractionDto[]> {
    if (assistantMessageIds.length === 0) return [];
    if (assistantMessageIds.length > 101) throw new Error("Interaction message batch is too large");
    return (await this.dataSource.listSessionInteractionRows(assistantMessageIds)).map(sessionInteractionFromRow);
  }

  async respond(input: {
    interactionId: string;
    userId: string;
    response: InteractionResponseV1;
    messageId: string;
    turnId: string;
    timestamp: number;
  }): Promise<{ outcome: InteractionRpcResult["outcome"]; responseMessageId?: string; response?: InteractionResponseV1 }> {
    const existing = await this.dataSource.getSessionInteractionRow(input.interactionId);
    if (!existing) throw new Error("Interaction not found");
    const request = validateInteractionRequest(existing.request);
    const response = validateInteractionResponse(request, input.response);
    const result = await this.dataSource.respondToSessionInteraction({
      interactionId: input.interactionId,
      response,
      idempotencyKey: response.idempotencyKey,
      responseMessageId: input.messageId,
      turnId: input.turnId,
      messageText: formatInteractionResponseMessage(request, response),
      timestamp: input.timestamp,
    });
    const authoritative = result.response === undefined ? undefined : validateInteractionResponse(request, result.response);
    return {
      outcome: result.outcome,
      ...(result.response_message_id ? { responseMessageId: result.response_message_id } : {}),
      ...(authoritative ? { response: authoritative } : {}),
    };
  }
}
