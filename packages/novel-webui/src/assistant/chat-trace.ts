import type { AgentId, ChatStreamEvent, InteractionAnswer, InteractionRequestV1, PersistedChatTrace, RunPlanV1, SessionMessage } from "../types";

export interface TraceTool {
  toolCallId: string;
  toolName: string;
  agentId: AgentId;
  parentToolCallId?: string;
  args: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
  status: "running" | "succeeded" | "failed";
}

export interface TraceThinking {
  blockId: string;
  agentId: AgentId;
  parentToolCallId?: string;
  text: string;
  status: "running" | "finished";
}

export interface TraceAgentActivity {
  id: string;
  agentId: AgentId;
  parentToolCallId?: string;
  status: "running" | "finished";
  startedAt: number;
  finishedAt?: number;
}

export interface TraceAgentOutput {
  id: string;
  agentId: AgentId;
  parentToolCallId?: string;
  text: string;
}

export interface TraceDocumentChange {
  versionId: string;
  path: string;
  versionNo: number;
  agentId: AgentId;
  toolCallId: string;
  addedLines: number;
  deletedLines: number;
  changedSections: string[];
}

export interface ChatTraceState {
  assistantMessageId: string;
  runId?: string;
  status: "idle" | "running" | "succeeded" | "failed" | "interrupted";
  startedAt?: number;
  durationMs?: number;
  error?: string;
  errorKey?: "incomplete";
  lastSeq: number;
  seenSeq: Set<number>;
  order: string[];
  tools: Record<string, TraceTool>;
  thinking: Record<string, TraceThinking>;
  activities: Record<string, TraceAgentActivity>;
  activeActivityByAgent: Partial<Record<AgentId, string>>;
  outputs: Record<string, TraceAgentOutput>;
  documentChanges: Record<string, TraceDocumentChange>;
  runPlan?: RunPlanV1;
  interactions: Record<string, { request?: InteractionRequestV1; status: "pending" | "resolved"; answers?: InteractionAnswer[]; freeAnswer?: string }>;
  truncated?: boolean;
}

export function restorePersistedChatTrace(
  persisted: PersistedChatTrace,
  assistantMessageId: string,
  messageStatus: SessionMessage["status"],
): ChatTraceState {
  const state = initialChatTrace(assistantMessageId);
  state.runId = persisted.runId;
  state.status = persisted.status === "running" && messageStatus !== "running" ? "interrupted" : persisted.status;
  state.startedAt = persisted.startedAt;
  state.durationMs = persisted.durationMs;
  state.error = persisted.error;
  state.errorKey = persisted.status === "running" && messageStatus !== "running"
    ? "incomplete"
    : undefined;
  state.truncated = persisted.truncated;
  for (const step of persisted.steps) {
    state.order.push(step.id);
    if (step.type === "agent") {
      state.activities[step.id] = { id: step.id, agentId: step.agentId, parentToolCallId: step.parentToolCallId, status: step.status, startedAt: persisted.startedAt ?? 0 };
    } else if (step.type === "thinking") {
      state.thinking[step.id.replace(/^thinking:/, "")] = { blockId: step.id.replace(/^thinking:/, ""), agentId: step.agentId, parentToolCallId: step.parentToolCallId, text: step.summary, status: step.status };
    } else if (step.type === "tool") {
      state.tools[step.id.replace(/^tool:/, "")] = { toolCallId: step.id.replace(/^tool:/, ""), toolName: step.toolName, agentId: step.agentId, parentToolCallId: step.parentToolCallId, args: step.args, partialResult: step.partialResult, result: step.result, isError: step.isError, durationMs: step.durationMs, status: step.status };
    } else if (step.type === "output") {
      state.outputs[step.id] = { id: step.id, agentId: step.agentId, parentToolCallId: step.parentToolCallId, text: step.text };
    } else if (step.type === "document_change") {
      state.documentChanges[step.versionId] = {
        versionId: step.versionId,
        path: step.path,
        versionNo: step.versionNo,
        agentId: step.agentId,
        toolCallId: step.toolCallId,
        addedLines: step.addedLines,
        deletedLines: step.deletedLines,
        changedSections: step.changedSections,
      };
    } else if (step.type === "run_plan") {
      state.runPlan = step.plan;
    } else if (step.type === "interaction") {
      state.interactions[step.interaction.id] = {
        request: step.interaction,
        status: step.status,
        answers: step.answers,
        freeAnswer: step.freeAnswer,
      };
    }
  }
  return state;
}

const KNOWN_EVENT_TYPES = new Set<ChatStreamEvent["type"]>([
  "run_started",
  "agent_started",
  "agent_finished",
  "thinking_started",
  "thinking_delta",
  "thinking_finished",
  "answer_delta",
  "agent_output_delta",
  "tool_started",
  "tool_updated",
  "tool_finished",
  "document_changed",
  "run_plan_updated",
  "interaction_requested",
  "interaction_resolved",
  "answer_finished",
  "run_finished",
  "run_interrupted",
  "run_failed",
]);

export function initialChatTrace(assistantMessageId: string): ChatTraceState {
  return {
    assistantMessageId,
    status: "idle",
    lastSeq: 0,
    seenSeq: new Set(),
    order: [],
    tools: {},
    thinking: {},
    activities: {},
    activeActivityByAgent: {},
    outputs: {},
    documentChanges: {},
    interactions: {},
  };
}

function cloneState(state: ChatTraceState): ChatTraceState {
  return {
    ...state,
    seenSeq: new Set(state.seenSeq),
    order: [...state.order],
    tools: { ...state.tools },
    thinking: { ...state.thinking },
    activities: { ...state.activities },
    activeActivityByAgent: { ...state.activeActivityByAgent },
    outputs: { ...state.outputs },
    documentChanges: { ...state.documentChanges },
    interactions: { ...state.interactions },
  };
}

function appendOrder(state: ChatTraceState, key: string) {
  if (!state.order.includes(key)) state.order.push(key);
}

export function reduceChatTrace(
  state: ChatTraceState,
  event: ChatStreamEvent,
): ChatTraceState {
  if (!KNOWN_EVENT_TYPES.has(event.type)) return state;
  if (state.runId && event.runId !== state.runId) return state;
  if (state.seenSeq.has(event.seq) || event.seq <= state.lastSeq) return state;

  const next = cloneState(state);
  next.runId = state.runId ?? event.runId;
  next.lastSeq = event.seq;
  next.seenSeq.add(event.seq);

  switch (event.type) {
    case "run_started":
      next.status = "running";
      next.startedAt = event.timestamp;
      break;

    case "run_plan_updated":
      next.runPlan = event.plan;
      break;

    case "interaction_requested":
      next.interactions[event.interaction.id] = { request: event.interaction, status: "pending" };
      break;

    case "interaction_resolved":
      next.interactions[event.interactionId] = {
        ...next.interactions[event.interactionId],
        status: "resolved",
        answers: event.answers,
        freeAnswer: event.freeAnswer,
      };
      break;

    case "agent_started": {
      const id = `agent:${event.agentId}:${event.seq}`;
      next.activities[id] = {
        id,
        agentId: event.agentId,
        parentToolCallId: event.parentToolCallId,
        status: "running",
        startedAt: event.timestamp,
      };
      next.activeActivityByAgent[event.agentId] = id;
      appendOrder(next, id);
      break;
    }

    case "agent_finished": {
      const activeId = next.activeActivityByAgent[event.agentId];
      const id = activeId ?? `agent:${event.agentId}:${event.seq}`;
      next.activities[id] = {
        ...(activeId ? next.activities[activeId] : {
          id,
          agentId: event.agentId,
          parentToolCallId: event.parentToolCallId,
          startedAt: event.timestamp,
        }),
        status: "finished",
        finishedAt: event.timestamp,
      };
      delete next.activeActivityByAgent[event.agentId];
      appendOrder(next, id);
      break;
    }

    case "thinking_started":
    case "thinking_delta":
    case "thinking_finished": {
      const key = `thinking:${event.blockId}`;
      const existing = next.thinking[event.blockId];
      const text = event.type === "thinking_delta"
        ? `${existing?.text ?? ""}${event.delta}`
        : event.type === "thinking_finished"
          ? event.text ?? existing?.text ?? ""
          : existing?.text ?? "";
      next.thinking[event.blockId] = {
        blockId: event.blockId,
        agentId: event.agentId,
        parentToolCallId: event.parentToolCallId ?? existing?.parentToolCallId,
        text,
        status: event.type === "thinking_finished" ? "finished" : "running",
      };
      appendOrder(next, key);
      break;
    }

    case "agent_output_delta": {
      const id = `output:${event.parentToolCallId ?? "root"}:${event.agentId}`;
      const existing = next.outputs[id];
      next.outputs[id] = {
        id,
        agentId: event.agentId,
        parentToolCallId: event.parentToolCallId,
        text: `${existing?.text ?? ""}${event.delta}`,
      };
      appendOrder(next, id);
      break;
    }

    case "tool_started": {
      next.tools[event.toolCallId] = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        agentId: event.agentId,
        parentToolCallId: event.parentToolCallId,
        args: event.args,
        status: "running",
      };
      appendOrder(next, `tool:${event.toolCallId}`);
      break;
    }

    case "tool_updated": {
      const existing = next.tools[event.toolCallId];
      next.tools[event.toolCallId] = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        agentId: event.agentId,
        parentToolCallId: event.parentToolCallId ?? existing?.parentToolCallId,
        args: existing?.args ?? null,
        partialResult: event.partialResult,
        result: existing?.result,
        isError: existing?.isError,
        durationMs: existing?.durationMs,
        status: existing?.status ?? "running",
      };
      appendOrder(next, `tool:${event.toolCallId}`);
      break;
    }

    case "tool_finished": {
      const existing = next.tools[event.toolCallId];
      next.tools[event.toolCallId] = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        agentId: event.agentId,
        parentToolCallId: event.parentToolCallId ?? existing?.parentToolCallId,
        args: existing?.args ?? null,
        partialResult: existing?.partialResult,
        result: event.result,
        isError: event.isError,
        durationMs: event.durationMs,
        status: event.isError ? "failed" : "succeeded",
      };
      appendOrder(next, `tool:${event.toolCallId}`);
      break;
    }

    case "document_changed": {
      next.documentChanges[event.versionId] = {
        versionId: event.versionId,
        path: event.path,
        versionNo: event.versionNo,
        agentId: event.agentId,
        toolCallId: event.toolCallId,
        addedLines: event.addedLines,
        deletedLines: event.deletedLines,
        changedSections: event.changedSections,
      };
      appendOrder(next, `document:${event.versionId}`);
      break;
    }

    case "run_finished":
      next.status = "succeeded";
      next.durationMs = event.durationMs;
      break;

    case "run_interrupted":
      next.status = "interrupted";
      next.durationMs = event.durationMs;
      next.error = event.message;
      break;

    case "run_failed":
      next.status = "failed";
      next.durationMs = event.durationMs;
      next.error = event.message;
      break;

    case "answer_delta":
    case "answer_finished":
      break;
  }

  return next;
}

export function interruptChatTrace(
  state: ChatTraceState,
  message?: string,
): ChatTraceState {
  return { ...state, status: "interrupted", error: message || undefined };
}

export interface DelegationSummary {
  callId: string;
  agentId: AgentId | null;
  /** Short display label from the chief's delegate call args. */
  label: string | null;
  /** Ordered keys (tools/thinking/agent/output) owned by this delegation. */
  childKeys: string[];
  startedAt?: number;
  running: boolean;
  isError: boolean;
  durationMs?: number;
  /** Last observable activity line while streaming, for the collapsed row. */
  latestActivity: string | null;
}

export interface TraceTopLevelPlan {
  /** Chronological top-level items; delegation entries render as one row. */
  items: Array<{ key: string; delegation?: DelegationSummary }>;
  delegations: Map<string, DelegationSummary>;
}

function pushUnique(target: string[], key: string) {
  if (!target.includes(key)) target.push(key);
}

/**
 * Folds a trace into top-level rows where every delegated sub-agent burst is
 * summarized under its chief tool-call id. Works identically on live streams
 * and restored persisted traces because both share ChatTraceState.
 */
export function summarizeTopLevel(
  state: Pick<ChatTraceState, "order" | "tools" | "thinking" | "activities" | "outputs">,
): TraceTopLevelPlan {
  const delegations = new Map<string, DelegationSummary>();
  const ensure = (callId: string): DelegationSummary => {
    let entry = delegations.get(callId);
    if (!entry) {
      entry = { callId, agentId: null, label: null, childKeys: [], startedAt: undefined, running: false, isError: false, latestActivity: null };
      delegations.set(callId, entry);
    }
    return entry;
  };

  const childOf = (key: string): DelegationSummary | null => {
    let parentToolCallId: string | undefined;
    let agentId: AgentId | null = null;
    if (key.startsWith("thinking:")) {
      const item = state.thinking[key.slice("thinking:".length)];
      parentToolCallId = item?.parentToolCallId;
      agentId = item?.agentId ?? null;
    } else if (key.startsWith("tool:")) {
      const item = state.tools[key.slice("tool:".length)];
      parentToolCallId = item?.parentToolCallId;
      agentId = item?.agentId ?? null;
    } else if (key.startsWith("agent:")) {
      const item = state.activities[key];
      parentToolCallId = item?.parentToolCallId;
      agentId = item?.agentId ?? null;
    } else if (key.startsWith("output:")) {
      const item = state.outputs[key];
      parentToolCallId = item?.parentToolCallId;
      agentId = item?.agentId ?? null;
    }
    if (!parentToolCallId) return null;
    const summary = ensure(parentToolCallId);
    if (!summary.agentId && agentId) summary.agentId = agentId;
    return summary;
  };

  const describe = (key: string): string | null => {
    if (key.startsWith("thinking:")) {
      const item = state.thinking[key.slice("thinking:".length)];
      if (!item?.text) return null;
      const trimmed = item.text.trim().replace(/\s+/g, " ");
      return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed || null;
    }
    if (key.startsWith("tool:")) {
      const item = state.tools[key.slice("tool:".length)];
      return item ? `${item.toolName}` : null;
    }
    if (key.startsWith("output:")) {
      const item = state.outputs[key];
      if (!item?.text) return null;
      const trimmed = item.text.trim().replace(/\s+/g, " ");
      return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed || null;
    }
    return null;
  };

  for (const key of state.order) {
    if (key.startsWith("document:")) continue; // artifacts always stay top-level
    if (key.startsWith("tool:")) {
      // The chief-side delegate_to_agent tool anchors its own collapsed row —
      // even before any sub-agent activity arrives.
      const item = state.tools[key.slice("tool:".length)];
      if (item && item.toolName === "delegate_to_agent" && !item.parentToolCallId) {
        const summary = ensure(item.toolCallId);
        const args = item.args as { task_description?: unknown; task?: unknown } | null;
        const description = typeof args?.task_description === "string" ? args.task_description
          : typeof args?.task === "string" ? args.task.split("\n")[0] : "";
        summary.label = description.trim() !== "" ? description : summary.label;
        summary.agentId ??= null;
      }
    }
    const child = childOf(key);
    if (!child) continue;
    pushUnique(child.childKeys, key);
    const line = describe(key);
    if (line) child.latestActivity = line;
  }

  // Duration/liveness come from the chief-side delegate_to_agent tool itself,
  // which settles exactly when its sub-agent run does.
  for (const [callId, summary] of delegations) {
    const delegateTool = state.tools[callId];
    summary.running = !delegateTool || delegateTool.status === "running";
    summary.isError = delegateTool?.status === "failed";
    summary.durationMs = delegateTool?.durationMs;
    const activityStart = summary.childKeys
      .map((key) => (key.startsWith("agent:") ? state.activities[key]?.startedAt : undefined))
      .find((value) => value !== undefined);
    summary.startedAt = delegateTool ? undefined : activityStart;
  }

  const seen = new Set<string>();
  const items: TraceTopLevelPlan["items"] = [];
  const pushDelegation = (callId: string) => {
    seen.add(callId);
    items.push({ key: `delegation:${callId}`, delegation: delegations.get(callId)! });
  };
  for (const key of state.order) {
    if (key.startsWith("document:")) {
      items.push({ key });
      continue;
    }
    if (key.startsWith("tool:")) {
      const anchorCallId = delegations.get(key.slice("tool:".length)) ? key.slice("tool:".length) : null;
      if (anchorCallId && !seen.has(anchorCallId)) {
        pushDelegation(anchorCallId);
        continue;
      }
    }
    const child = childOf(key);
    if (!child) {
      items.push({ key });
      continue;
    }
    if (!seen.has(child.callId)) {
      pushDelegation(child.callId);
    }
  }
  return { items, delegations };
}
