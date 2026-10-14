import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { createLogger } from "./logger.js";
import type { InteractionAnswer, InteractionRequestV1, RunPlanV1 } from "../interactions/types.js";
import { validateInteractionRequest, validateRunPlan } from "../interactions/validation.js";

const traceLog = createLogger("agent-trace");

export type AgentId =
  | "chief_editor"
  | "worldbuilder"
  | "character_designer"
  | "outliner"
  | "director"
  | "writer"
  | "script_supervisor";

interface BaseEvent {
  version: 1;
  runId: string;
  seq: number;
  timestamp: number;
  agentId?: AgentId;
  parentToolCallId?: string;
}

export type ChatStreamEvent =
  | (BaseEvent & { type: "run_started" })
  | (BaseEvent & { type: "agent_started"; agentId: AgentId })
  | (BaseEvent & { type: "agent_finished"; agentId: AgentId })
  | (BaseEvent & {
      type: "thinking_started" | "thinking_finished";
      agentId: AgentId;
      blockId: string;
      text?: string;
    })
  | (BaseEvent & { type: "run_plan_updated"; plan: RunPlanV1 })
  | (BaseEvent & { type: "interaction_requested"; interaction: InteractionRequestV1 })
  | (BaseEvent & { type: "interaction_resolved"; interactionId: string; answers: InteractionAnswer[]; freeAnswer?: string })
  | (BaseEvent & {
      type: "thinking_delta";
      agentId: AgentId;
      blockId: string;
      delta: string;
    })
  | (BaseEvent & {
      type: "answer_delta";
      agentId: "chief_editor";
      delta: string;
    })
  | (BaseEvent & {
      type: "agent_output_delta";
      agentId: Exclude<AgentId, "chief_editor">;
      delta: string;
    })
  | (BaseEvent & {
      type: "tool_started";
      agentId: AgentId;
      toolCallId: string;
      toolName: string;
      args: unknown;
    })
  | (BaseEvent & {
      type: "tool_updated";
      agentId: AgentId;
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
    })
  | (BaseEvent & {
      type: "tool_finished";
      agentId: AgentId;
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      durationMs: number;
    })
  | (BaseEvent & {
      type: "document_changed";
      agentId: AgentId;
      toolCallId: string;
      versionId: string;
      path: string;
      versionNo: number;
      addedLines: number;
      deletedLines: number;
      changedSections: string[];
    })
  | (BaseEvent & { type: "answer_finished"; text: string })
  | (BaseEvent & { type: "run_finished"; durationMs: number })
  | (BaseEvent & { type: "run_interrupted"; message: string; durationMs: number })
  | (BaseEvent & { type: "run_failed"; message: string; durationMs: number });

type EventBody = ChatStreamEvent extends infer Event
  ? Event extends ChatStreamEvent
    ? Omit<Event, "version" | "runId" | "seq" | "timestamp">
    : never
  : never;

interface AdapterOptions {
  runId: string;
  projectId?: string;
  emit: (event: ChatStreamEvent) => void;
  now?: () => number;
  rawLogEnabled?: boolean;
  log?: (line: string) => void;
}

export interface ChatTraceAdapter {
  runStarted(): void;
  handle(agentId: AgentId, event: AgentEvent): void;
  answerFinished(text: string): void;
  runFinished(): void;
  runInterrupted(message: string): void;
  runFailed(message: string): void;
  interactionResolved(interactionId: string, answers: InteractionAnswer[], freeAnswer?: string): void;
}

export function createChatTraceAdapter(options: AdapterOptions): ChatTraceAdapter {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const toolStartedAt = new Map<string, number>();
  const delegateTargetByCall = new Map<string, AgentId>();
  const activeParentByAgent = new Map<AgentId, string>();
  const messageOrdinalByAgent = new Map<AgentId, number>();
  let seq = 0;
  let terminal = false;
  let answerComplete = false;

  const emit = (event: EventBody) => {
    options.emit({
      version: 1,
      runId: options.runId,
      seq: ++seq,
      timestamp: now(),
      ...event,
    } as ChatStreamEvent);
  };

  const parentFor = (agentId: AgentId) => activeParentByAgent.get(agentId);
  const blockId = (agentId: AgentId, contentIndex: number) =>
    `${agentId}:${messageOrdinalByAgent.get(agentId) ?? 0}:${contentIndex}`;

  function safeWriteArgs(toolName: string, args: unknown): unknown {
    if (toolName !== "write_doc" || !args || typeof args !== "object") return args;
    const record = args as Record<string, unknown>;
    if (typeof record.content !== "string") return args;
    return {
      path: typeof record.path === "string" ? record.path : undefined,
      contentBytes: new TextEncoder().encode(record.content).byteLength,
      contentRedacted: true,
    };
  }

  function safeRawEvent(event: AgentEvent): AgentEvent {
    if (event.type !== "tool_execution_start") return event;
    return { ...event, args: safeWriteArgs(event.toolName, event.args) } as AgentEvent;
  }

  function documentChange(result: unknown): null | {
    versionId: string;
    path: string;
    versionNo: number;
    addedLines: number;
    deletedLines: number;
    changedSections: string[];
  } {
    if (!result || typeof result !== "object") return null;
    const details = (result as Record<string, unknown>).details;
    if (!details || typeof details !== "object") return null;
    const value = details as Record<string, unknown>;
    if (value.changed !== true
      || typeof value.versionId !== "string"
      || typeof value.path !== "string"
      || !Number.isInteger(value.versionNo)
      || !Number.isInteger(value.addedLines)
      || !Number.isInteger(value.deletedLines)
      || !Array.isArray(value.changedSections)
      || !value.changedSections.every((section) => typeof section === "string")) return null;
    return {
      versionId: value.versionId,
      path: value.path,
      versionNo: value.versionNo as number,
      addedLines: value.addedLines as number,
      deletedLines: value.deletedLines as number,
      changedSections: value.changedSections as string[],
    };
  }

  function structuredToolResult(result: unknown): { runPlan?: RunPlanV1; interaction?: InteractionRequestV1 } {
    if (!result || typeof result !== "object") return {};
    const details = (result as Record<string, unknown>).details;
    if (!details || typeof details !== "object") return {};
    const values = details as Record<string, unknown>;
    try {
      if (values.runPlan) return { runPlan: validateRunPlan(values.runPlan) };
      if (values.interaction) return { interaction: validateInteractionRequest(values.interaction) };
    } catch {
      // Invalid tool details stay visible as an ordinary tool result only.
    }
    return {};
  }

  function logRaw(agentId: AgentId, event: AgentEvent) {
    if (!options.rawLogEnabled) return;
    try {
      (options.log ?? ((line: string) => traceLog.info(line)))(JSON.stringify({
        scope: "agent-trace",
        runId: options.runId,
        projectId: options.projectId,
        agentId,
        event: safeRawEvent(event),
      }));
    } catch {
      // Diagnostic logging must never affect a chat run.
    }
  }

  return {
    runStarted() {
      emit({ type: "run_started" });
    },
    handle(agentId, event) {
      logRaw(agentId, event);
      const parentToolCallId = parentFor(agentId);

      if (event.type === "agent_start") {
        emit({ type: "agent_started", agentId, parentToolCallId });
      } else if (event.type === "agent_end") {
        emit({ type: "agent_finished", agentId, parentToolCallId });
      } else if (event.type === "message_start") {
        messageOrdinalByAgent.set(agentId, (messageOrdinalByAgent.get(agentId) ?? -1) + 1);
      } else if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "thinking_start") {
          emit({
            type: "thinking_started",
            agentId,
            parentToolCallId,
            blockId: blockId(agentId, update.contentIndex),
          });
        } else if (update.type === "thinking_delta") {
          emit({
            type: "thinking_delta",
            agentId,
            parentToolCallId,
            blockId: blockId(agentId, update.contentIndex),
            delta: update.delta,
          });
        } else if (update.type === "thinking_end") {
          emit({
            type: "thinking_finished",
            agentId,
            parentToolCallId,
            blockId: blockId(agentId, update.contentIndex),
            text: update.content,
          });
        } else if (update.type === "text_delta" && agentId === "chief_editor") {
          emit({ type: "answer_delta", agentId, parentToolCallId, delta: update.delta });
        } else if (update.type === "text_delta" && agentId !== "chief_editor") {
          emit({ type: "agent_output_delta", agentId, parentToolCallId, delta: update.delta });
        }
      } else if (event.type === "tool_execution_start") {
        toolStartedAt.set(event.toolCallId, now());
        if (agentId === "chief_editor" && event.toolName === "delegate_to_agent") {
          const target = (event.args as { agent?: AgentId }).agent;
          if (target && target !== "chief_editor") {
            delegateTargetByCall.set(event.toolCallId, target);
            activeParentByAgent.set(target, event.toolCallId);
          }
        }
        emit({
          type: "tool_started",
          agentId,
          parentToolCallId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: safeWriteArgs(event.toolName, event.args),
        });
      } else if (event.type === "tool_execution_update") {
        emit({
          type: "tool_updated",
          agentId,
          parentToolCallId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partialResult: event.partialResult,
        });
      } else if (event.type === "tool_execution_end") {
        const started = toolStartedAt.get(event.toolCallId) ?? startedAt;
        emit({
          type: "tool_finished",
          agentId,
          parentToolCallId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
          durationMs: Math.max(0, now() - started),
        });
        if (!event.isError) {
          const structured = structuredToolResult(event.result);
          if (event.toolName === "update_run_plan" && structured.runPlan) {
            emit({ type: "run_plan_updated", plan: structured.runPlan });
          }
          if (event.toolName === "request_user_interaction" && structured.interaction) {
            emit({ type: "interaction_requested", interaction: structured.interaction });
          }
          const change = documentChange(event.result);
          if (change) {
            emit({
              type: "document_changed",
              agentId,
              parentToolCallId,
              toolCallId: event.toolCallId,
              ...change,
            });
          }
        }
        toolStartedAt.delete(event.toolCallId);
        const target = delegateTargetByCall.get(event.toolCallId);
        if (target) activeParentByAgent.delete(target);
        delegateTargetByCall.delete(event.toolCallId);
      }
    },
    answerFinished(text) {
      if (answerComplete) return;
      answerComplete = true;
      emit({ type: "answer_finished", text });
    },
    runFinished() {
      if (terminal) return;
      terminal = true;
      emit({ type: "run_finished", durationMs: Math.max(0, now() - startedAt) });
    },
    runInterrupted(message) {
      if (terminal) return;
      terminal = true;
      emit({
        type: "run_interrupted",
        message,
        durationMs: Math.max(0, now() - startedAt),
      });
    },
    runFailed(message) {
      if (terminal) return;
      terminal = true;
      emit({ type: "run_failed", message, durationMs: Math.max(0, now() - startedAt) });
    },
    interactionResolved(interactionId, answers, freeAnswer) {
      emit({
        type: "interaction_resolved",
        interactionId,
        answers,
        ...(freeAnswer ? { freeAnswer } : {}),
      });
    },
  };
}
