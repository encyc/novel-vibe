import type { AgentId, ChatStreamEvent } from "./chat-trace.js";
import type { InteractionAnswer, InteractionRequestV1, RunPlanV1 } from "../interactions/types.js";

export type PersistedTraceStatus = "running" | "succeeded" | "failed" | "interrupted";

export type PersistedTraceStep =
  | { type: "agent"; id: string; agentId: AgentId; parentToolCallId?: string; status: "running" | "finished" }
  | { type: "thinking"; id: string; agentId: AgentId; parentToolCallId?: string; summary: string; status: "running" | "finished"; truncated?: boolean }
  | { type: "tool"; id: string; agentId: AgentId; parentToolCallId?: string; toolName: string; args: unknown; partialResult?: unknown; result?: unknown; isError?: boolean; durationMs?: number; status: "running" | "succeeded" | "failed"; truncated?: boolean }
  | { type: "document_change"; id: string; agentId: AgentId; toolCallId: string; versionId: string; path: string; versionNo: number; addedLines: number; deletedLines: number; changedSections: string[] }
  | { type: "output"; id: string; agentId: AgentId; parentToolCallId?: string; text: string; truncated?: boolean }
  | { type: "run_plan"; id: string; plan: RunPlanV1 }
  | { type: "interaction"; id: string; interaction: InteractionRequestV1; status: "pending" | "resolved"; answers?: InteractionAnswer[]; freeAnswer?: string };

export interface PersistedChatTrace {
  version: 1;
  runId?: string;
  status: PersistedTraceStatus;
  startedAt?: number;
  durationMs?: number;
  error?: string;
  steps: PersistedTraceStep[];
  truncated?: boolean;
}

interface Options { maxBytes?: number; maxStringLength?: number; maxDepth?: number }

export function createPersistedTraceReducer(options: Options = {}) {
  const maxBytes = options.maxBytes ?? 64_000;
  const maxStringLength = options.maxStringLength ?? 8_000;
  const maxDepth = options.maxDepth ?? 6;
  const trace: PersistedChatTrace = { version: 1, status: "running", steps: [] };
  const index = new Map<string, number>();
  let truncated = false;

  function boundedString(value: string, limit = maxStringLength): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= limit) return normalized;
    truncated = true;
    return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
  }

  function sanitize(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return boundedString(value);
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (depth >= maxDepth) { truncated = true; return "[depth truncated]"; }
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
    if (typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
        output[key] = sanitize(item, depth + 1);
      }
      return output;
    }
    return String(value);
  }

  function upsert(key: string, create: () => PersistedTraceStep, update: (step: PersistedTraceStep) => PersistedTraceStep) {
    const position = index.get(key);
    if (position === undefined) {
      index.set(key, trace.steps.length);
      trace.steps.push(create());
    } else {
      trace.steps[position] = update(trace.steps[position]);
    }
  }

  function snapshot(): PersistedChatTrace {
    const copy = structuredClone(trace);
    if (truncated) copy.truncated = true;
    const byteLength = () => new TextEncoder().encode(JSON.stringify(copy)).byteLength;
    while (byteLength() > maxBytes && copy.steps.length > 0) {
      copy.steps.pop();
      copy.truncated = true;
    }
    if (byteLength() > maxBytes) {
      delete copy.error;
      copy.truncated = true;
    }
    return copy;
  }

  return {
    push(event: ChatStreamEvent) {
      trace.runId ??= event.runId;
      if (event.type === "run_started") trace.startedAt = event.timestamp;
      else if (event.type === "agent_started" || event.type === "agent_finished") {
        const activeKey = [...index.keys()].reverse().find((key) => key.startsWith(`agent:${event.agentId}:`));
        const key = activeKey ? activeKey : `agent:${event.agentId}:${event.seq}`;
        upsert(key,
          () => ({ type: "agent", id: key, agentId: event.agentId, parentToolCallId: event.parentToolCallId, status: event.type === "agent_finished" ? "finished" : "running" }),
          (step) => step.type === "agent" ? { ...step, status: event.type === "agent_finished" ? "finished" : "running" } : step);
      } else if (event.type === "thinking_started" || event.type === "thinking_delta" || event.type === "thinking_finished") {
        const key = `thinking:${event.blockId}`;
        upsert(key,
          () => ({ type: "thinking", id: key, agentId: event.agentId, parentToolCallId: event.parentToolCallId, summary: "", status: "running" }),
          (step) => step);
        const position = index.get(key)!;
        const current = trace.steps[position] as Extract<PersistedTraceStep, { type: "thinking" }>;
        const raw = event.type === "thinking_delta" ? `${current.summary}${event.delta}` : event.type === "thinking_finished" ? event.text ?? current.summary : current.summary;
        const summary = boundedString(raw, 300);
        trace.steps[position] = { ...current, summary, status: event.type === "thinking_finished" ? "finished" : "running", ...(raw.replace(/\s+/g, " ").trim().length > 300 ? { truncated: true } : {}) };
      } else if (event.type === "agent_output_delta") {
        const key = `output:${event.parentToolCallId ?? "root"}:${event.agentId}`;
        upsert(key,
          () => ({ type: "output", id: key, agentId: event.agentId, parentToolCallId: event.parentToolCallId, text: boundedString(event.delta) }),
          (step) => step.type === "output" ? { ...step, text: boundedString(`${step.text}${event.delta}`) } : step);
      } else if (event.type === "tool_started" || event.type === "tool_updated" || event.type === "tool_finished") {
        const key = `tool:${event.toolCallId}`;
        upsert(key,
          () => ({ type: "tool", id: key, agentId: event.agentId, parentToolCallId: event.parentToolCallId, toolName: event.toolName, args: event.type === "tool_started" ? sanitize(event.args) : null, status: "running" }),
          (step) => step);
        const position = index.get(key)!;
        const current = trace.steps[position] as Extract<PersistedTraceStep, { type: "tool" }>;
        if (event.type === "tool_updated") trace.steps[position] = { ...current, partialResult: sanitize(event.partialResult) };
        if (event.type === "tool_finished") trace.steps[position] = { ...current, result: sanitize(event.result), isError: event.isError, durationMs: event.durationMs, status: event.isError ? "failed" : "succeeded" };
      } else if (event.type === "document_changed") {
        const key = `document:${event.versionId}`;
        upsert(key,
          () => ({
            type: "document_change",
            id: key,
            agentId: event.agentId,
            toolCallId: event.toolCallId,
            versionId: event.versionId,
            path: event.path,
            versionNo: event.versionNo,
            addedLines: event.addedLines,
            deletedLines: event.deletedLines,
            changedSections: event.changedSections.slice(0, 100),
          }),
          (step) => step);
      } else if (event.type === "run_plan_updated") {
        const key = `run-plan:${event.plan.id}`;
        upsert(key,
          () => ({ type: "run_plan", id: key, plan: structuredClone(event.plan) }),
          (step) => step.type === "run_plan" ? { ...step, plan: structuredClone(event.plan) } : step);
      } else if (event.type === "interaction_requested") {
        const key = `interaction:${event.interaction.id}`;
        upsert(key,
          () => ({ type: "interaction", id: key, interaction: structuredClone(event.interaction), status: "pending" }),
          (step) => step);
      } else if (event.type === "interaction_resolved") {
        const key = `interaction:${event.interactionId}`;
        const position = index.get(key);
        if (position !== undefined) {
          const current = trace.steps[position];
          if (current.type === "interaction") {
            trace.steps[position] = {
              ...current,
              status: "resolved",
              answers: structuredClone(event.answers),
              ...(event.freeAnswer ? { freeAnswer: boundedString(event.freeAnswer, 2_000) } : {}),
            };
          }
        }
      } else if (event.type === "run_finished") {
        trace.status = "succeeded"; trace.durationMs = event.durationMs;
      } else if (event.type === "run_interrupted") {
        trace.status = "interrupted"; trace.durationMs = event.durationMs; trace.error = boundedString(event.message, 1_000);
      } else if (event.type === "run_failed") {
        trace.status = "failed"; trace.durationMs = event.durationMs; trace.error = boundedString(event.message, 1_000);
      }
    },
    snapshot,
  };
}

export function createPersistedTracePersistence(options: {
  save: (messageId: string, trace: PersistedChatTrace) => Promise<void>;
  intervalMs?: number;
}) {
  const reducer = createPersistedTraceReducer();
  const intervalMs = options.intervalMs ?? 500;
  let messageId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const persist = async (swallow: boolean): Promise<boolean> => {
    if (!messageId) return false;
    try {
      await options.save(messageId, reducer.snapshot());
      return true;
    } catch (error) {
      if (!swallow) throw error;
      return false;
    }
  };

  const schedule = () => {
    if (!messageId || timer) return;
    timer = setTimeout(() => {
      timer = null;
      inFlight = inFlight.then(() => persist(true)).then(() => undefined);
    }, intervalMs);
  };

  return {
    attach(id: string) { messageId = id; schedule(); },
    push(event: ChatStreamEvent) { reducer.push(event); schedule(); },
    snapshot: reducer.snapshot,
    async flush(retry = false): Promise<boolean> {
      if (timer) { clearTimeout(timer); timer = null; }
      await inFlight;
      try {
        return await persist(false);
      } catch {
        if (!retry) return false;
        return persist(true);
      }
    },
  };
}
