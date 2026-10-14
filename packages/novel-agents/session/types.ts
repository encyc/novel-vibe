import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, ProviderId } from "@earendil-works/pi-ai";
import type { PersistedChatTrace } from "../lib/persisted-chat-trace.js";
import type { InteractionResponseV1, SessionInteractionDto } from "../interactions/types.js";

export const AGENT_IDS = [
  "chief_editor",
  "worldbuilder",
  "character_designer",
  "outliner",
  "director",
  "writer",
  "script_supervisor",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];
export type MessageStatus = "running" | "complete" | "failed" | "interrupted";
export type MemoryStatus = "healthy" | "degraded";
export type MemoryJobStatus = "pending" | "running" | "complete" | "failed" | "cancelled";
export type SessionLifecycleStatus = "active" | "archived";

export interface MemoryJobRow {
  id: string;
  session_id: string;
  project_id: string;
  turn_id: string;
  operation: "capture";
  payload: Record<string, unknown>;
  status: MemoryJobStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SessionDto {
  id: string;
  projectId: string;
  title: string;
  titleIsCustom: boolean;
  isProcessing: boolean;
  processingStartedAt: string | null;
  memoryStatus: MemoryStatus;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
  lifecycleStatus: SessionLifecycleStatus;
}

export interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  title_is_custom: boolean;
  processing_lease_id: string | null;
  processing_started_at: string | null;
  memory_status: MemoryStatus;
  memory_ever_enabled: boolean;
  last_opened_at: string;
  last_message_at: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  lifecycle_status: SessionLifecycleStatus;
  archived_at: string | null;
}

export interface SessionPage extends CursorPage<SessionDto> {
  activeSessionId: string | null;
}

export interface DisplayMessageDto {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  text: string;
  status: MessageStatus;
  createdAt: string;
  trace?: PersistedChatTrace;
  interactions?: SessionInteractionDto[];
  interactionResponse?: InteractionResponseV1;
}

export interface ModelDescriptor {
  api: Api;
  provider: ProviderId;
  model: string;
  contextWindow: number;
}

export interface SessionMessageRow {
  id: string;
  session_id: string;
  sequence: number;
  agent_id: string;
  turn_id: string;
  role: string;
  content: unknown;
  message: unknown | null;
  status: MessageStatus;
  display: boolean;
  metadata: Record<string, unknown>;
  provider: string | null;
  model: string | null;
  timestamp: number;
}

export interface StoredAgentMessage {
  sequence: number;
  turnId: string;
  agentId: AgentId;
  message: AgentMessage;
}

export type SessionErrorCode =
  | "INVALID_CURSOR"
  | "INVALID_LIMIT"
  | "SESSION_NOT_FOUND"
  | "DELEGATION_NOT_FOUND"
  | "SESSION_BUSY"
  | "SESSION_READ_ONLY"
  | "SESSION_FORBIDDEN"
  | "SESSION_NOT_DELETABLE"
  | "MEMORY_DELETE_UNAVAILABLE"
  | "SESSION_COMPACTION_REQUIRED"
  | "INTERACTION_CONFLICT";

export class SessionDomainError extends Error {
  constructor(
    public readonly code: SessionErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "SessionDomainError";
  }
}
