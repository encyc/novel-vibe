import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type {
  DisplayMessageDto,
  ModelDescriptor,
  SessionMessageRow,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContent(value: unknown): boolean {
  return typeof value === "string" || Array.isArray(value);
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value) || typeof value.role !== "string" || typeof value.timestamp !== "number") {
    return false;
  }
  if (value.role === "user") {
    return isContent(value.content);
  }
  if (value.role === "assistant") {
    return Array.isArray(value.content)
      && typeof value.api === "string"
      && typeof value.provider === "string"
      && typeof value.model === "string"
      && isRecord(value.usage)
      && typeof value.stopReason === "string";
  }
  if (value.role === "toolResult") {
    return typeof value.toolCallId === "string"
      && typeof value.toolName === "string"
      && Array.isArray(value.content)
      && typeof value.isError === "boolean";
  }
  return false;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function legacyContent(row: SessionMessageRow): UserMessage["content"] {
  if (typeof row.content === "string" || Array.isArray(row.content)) return cloneJson(row.content);
  return [];
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function encodeAgentMessage(message: AgentMessage): Record<string, unknown> {
  if (!isAgentMessage(message)) throw new Error("Invalid AgentMessage");
  return cloneJson(message) as unknown as Record<string, unknown>;
}

export function decodeStoredMessage(row: SessionMessageRow, model: ModelDescriptor): AgentMessage {
  if (row.message !== null) {
    if (!isAgentMessage(row.message)) throw new Error("Invalid stored AgentMessage");
    return cloneJson(row.message);
  }

  if (row.role === "user") {
    return { role: "user", content: legacyContent(row), timestamp: row.timestamp } satisfies UserMessage;
  }
  if (row.role === "assistant") {
    return {
      role: "assistant",
      content: Array.isArray(row.content) ? cloneJson(row.content) : [],
      api: model.api,
      provider: model.provider,
      model: model.model,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: row.timestamp,
    } satisfies AssistantMessage;
  }
  if (row.role === "toolResult" && isRecord(row.metadata)) {
    const toolCallId = row.metadata.toolCallId;
    const toolName = row.metadata.toolName;
    if (typeof toolCallId === "string" && typeof toolName === "string") {
      return {
        role: "toolResult",
        toolCallId,
        toolName,
        content: Array.isArray(row.content) ? cloneJson(row.content) : [],
        isError: row.metadata.isError === true,
        timestamp: row.timestamp,
      } satisfies ToolResultMessage;
    }
  }
  throw new Error("Invalid legacy AgentMessage");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => (
      isRecord(item) && item.type === "text" && typeof item.text === "string"
    ))
    .map((item) => item.text)
    .join("\n");
}

export function toDisplayMessage(row: SessionMessageRow): DisplayMessageDto | null {
  if (!row.display || row.agent_id !== "chief_editor") return null;
  if (row.role !== "user" && row.role !== "assistant") return null;
  const content = isRecord(row.message) ? row.message.content : row.content;
  const trace = isRecord(row.metadata.trace) && row.metadata.trace.version === 1
    ? row.metadata.trace as unknown as DisplayMessageDto["trace"]
    : undefined;
  const interactionResponse = isRecord(row.metadata.interactionResponse)
    && row.metadata.interactionResponse.schemaVersion === 1
    && typeof row.metadata.interactionResponse.interactionId === "string"
    && typeof row.metadata.interactionResponse.idempotencyKey === "string"
    && Array.isArray(row.metadata.interactionResponse.answers)
    ? row.metadata.interactionResponse as unknown as DisplayMessageDto["interactionResponse"]
    : undefined;
  return {
    id: row.id,
    turnId: row.turn_id,
    role: row.role,
    text: textFromContent(content),
    status: row.status,
    createdAt: new Date(row.timestamp).toISOString(),
    ...(trace ? { trace } : {}),
    ...(interactionResponse ? { interactionResponse } : {}),
  };
}

export interface DelegationTranscriptBlock {
  kind: "text" | "reasoning" | "tool";
  text: string;
}

export interface DelegationTranscriptEntry {
  id: string;
  sequence: number;
  role: "user" | "assistant" | "tool";
  blocks: DelegationTranscriptBlock[];
  createdAt: string;
}

/**
 * Projects one stored sub-agent row into the read-only transcript DTO. Pure
 * function of the row so live and replayed drill-ins stay identical; rows that
 * carry neither an encoded AgentMessage nor legacy content are skipped.
 */
export function toDelegationTranscriptEntry(row: SessionMessageRow): DelegationTranscriptEntry | null {
  const blocks = blocksForRole(row);
  if (blocks.length === 0) return null;
  const rawTimestamp = isRecord(row.message) && typeof row.message.timestamp === "number"
    ? row.message.timestamp
    : row.timestamp;
  return {
    id: row.id,
    sequence: row.sequence,
    role: row.role === "user" ? "user" : row.role === "assistant" ? "assistant" : "tool",
    blocks,
    createdAt: new Date(rawTimestamp).toISOString(),
  };
}

function blocksForRole(row: SessionMessageRow): DelegationTranscriptBlock[] {
  const encoded = isRecord(row.message) ? row.message : null;
  if (row.role === "assistant") return blocksFromAssistant(encoded?.content ?? row.content);
  if (row.role === "user") {
    const text = plainText(encoded?.content ?? row.content);
    return text ? [{ kind: "text", text }] : [];
  }
  // toolResult — surface the tool name together with its textual output.
  const meta = isRecord(row.metadata) ? row.metadata : {};
  const toolName = typeof encoded?.toolName === "string"
    ? encoded.toolName
    : typeof meta.toolCallId === "string" && typeof meta.toolName === "string"
      ? meta.toolName
      : "";
  const text = plainText(encoded?.content ?? row.content);
  if (!text && !toolName) return [];
  const label = toolName || "tool";
  return [{ kind: "tool", text: text ? `${label}: ${text}` : label }];
}

function blocksFromAssistant(content: unknown): DelegationTranscriptBlock[] {
  if (!Array.isArray(content)) {
    const flat = plainText(content);
    return flat ? [{ kind: "text", text: flat }] : [];
  }
  const blocks: DelegationTranscriptBlock[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if ((item.type === "text" || item.type === "thinking") && typeof item.text === "string") {
      if (item.text.trim() !== "") {
        blocks.push({ kind: item.type === "thinking" ? "reasoning" : "text", text: item.text });
      }
    }
  }
  return blocks;
}

function plainText(content: unknown): string {
  return textFromContent(content);
}

export interface DelegationRef {
  agentId: string;
  turnId: string;
}

/**
 * Scans a chief assistant message's persisted trace steps for the
 * delegate_to_agent call, returning the child agent and owning turn.
 * Preference order: an adjacent `agent` step parented by the call, then the
 * call's own args.agent. Returns null when this message owns no such call.
 */
export function extractDelegationRef(
  metadata: unknown,
  callId: string,
  fallbackTurnId: string | null,
): DelegationRef | null {
  if (!isRecord(metadata) || !isRecord(metadata.trace) || !Array.isArray(metadata.trace.steps)) return null;
  const steps = metadata.trace.steps;
  let argsAgent: string | null = null;
  let stepAgent: string | null = null;
  for (const raw of steps) {
    if (!isRecord(raw)) continue;
    if (stepAgent === null && raw.type === "agent"
      && typeof raw.parentToolCallId === "string" && raw.parentToolCallId === callId
      && typeof raw.agentId === "string") {
      stepAgent = raw.agentId;
    }
    if (argsAgent === null && raw.type === "tool"
      && typeof raw.id === "string" && (raw.id === callId || raw.id === `tool:${callId}`)
      && raw.toolName === "delegate_to_agent"
      && isRecord(raw.args) && typeof raw.args.agent === "string") {
      argsAgent = raw.args.agent;
    }
  }
  const agentId = stepAgent ?? argsAgent;
  if (!agentId) return null;
  return { agentId, turnId: fallbackTurnId ?? "" };
}
