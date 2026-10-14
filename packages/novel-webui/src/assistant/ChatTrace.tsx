import {
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleX,
  Loader2,
  Maximize2,
  Wrench,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  ChatTraceState,
  DelegationSummary,
  TraceAgentActivity,
  TraceAgentOutput,
  TraceThinking,
  TraceTool,
} from "./chat-trace";
import { summarizeTopLevel } from "./chat-trace";
import { summarizeToolRow } from "../conversation/tool-summary";
import { useDelegationDrill } from "./delegation-drill";

export function ChatTrace({ trace }: { trace: ChatTraceState }) {
  const { t } = useTranslation();
  const drill = useDelegationDrill();
  const [expanded, setExpanded] = useState(trace.status !== "succeeded");
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    if (!drill) return;
    drill.liveTraces.current[trace.assistantMessageId] = trace;
  }, [drill, trace]);

  useEffect(() => {
    if (trace.status === "succeeded") setExpanded(false);
    if (trace.status === "running" || trace.status === "failed" || trace.status === "interrupted") {
      setExpanded(true);
    }
  }, [trace.status]);

  useEffect(() => {
    if (trace.status !== "running") return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [trace.status]);

  if (trace.status === "idle") return null;

  const elapsed = trace.durationMs
    ?? (trace.startedAt ? Math.max(0, clock - trace.startedAt) : 0);
  const summary = trace.status === "running"
    ? t("assistant.trace.running", { duration: formatDuration(elapsed) })
    : trace.status === "succeeded"
      ? t("assistant.trace.succeeded", {
        count: trace.order.length,
        duration: formatDuration(elapsed),
        steps: t(trace.order.length === 1 ? "assistant.trace.step" : "assistant.trace.steps"),
      })
      : trace.status === "interrupted"
        ? t("assistant.trace.interrupted")
        : t("assistant.trace.failed");

  return (
    <section
      aria-label={t("assistant.trace.region")}
      aria-live="off"
      className={`chat-trace ${trace.status}`}
    >
      <button
        aria-expanded={expanded}
        aria-label={expanded ? t("assistant.trace.collapse") : t("assistant.trace.expand")}
        className="chat-trace-summary"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span>{summary}</span>
        {expanded ? <ChevronUp aria-hidden size={14} /> : <ChevronDown aria-hidden size={14} />}
      </button>
      {expanded ? <TraceTimeline trace={trace} /> : null}
    </section>
  );
}

function TraceTimeline({ trace }: { trace: ChatTraceState }) {
  const { t } = useTranslation();
  const [manual, setManual] = useState<Record<string, boolean>>({});
  const plan = summarizeTopLevel(trace);

  const renderRow = (key: string): ReactNode => {
    if (key.startsWith("tool:")) {
      const tool = trace.tools[key.slice("tool:".length)];
      return tool ? <TraceToolRow key={key} tool={tool} /> : null;
    }
    if (key.startsWith("thinking:")) {
      const thinking = trace.thinking[key.slice("thinking:".length)];
      return thinking ? <TraceThinkingRow key={key} thinking={thinking} /> : null;
    }
    if (key.startsWith("agent:")) {
      const activity = trace.activities[key];
      return activity ? <TraceAgentRow activity={activity} key={key} /> : null;
    }
    if (key.startsWith("output:")) {
      const output = trace.outputs[key];
      return output ? <TraceOutputRow key={key} output={output} /> : null;
    }
    return null;
  };

  return (
    <div className="chat-trace-timeline">
      {trace.order.length === 0 && trace.status === "running" ? (
        <div className="chat-trace-row">
          <header><Loader2 aria-hidden className="chat-trace-spinner" size={13} /><span>{t("assistant.trace.processing")}</span></header>
        </div>
      ) : null}
      {plan.items.map(({ key, delegation }) => {
        if (!delegation) return renderRow(key);
        const open = manual[delegation.callId] ?? delegation.running;
        return (
          <DelegateRow
            isOpen={open}
            key={key}
            onToggle={() => setManual((current) => ({ ...current, [delegation.callId]: !open }))}
            renderRow={renderRow}
            summary={delegation}
            trace={trace}
          />
        );
      })}
      {trace.error || trace.errorKey ? <p className="chat-trace-error">{trace.error ?? t(`assistant.trace.${trace.errorKey}`)}</p> : null}
      {trace.truncated ? <p className="chat-trace-truncated">{t("assistant.trace.truncated")}</p> : null}
    </div>
  );
}

function DelegateRow({
  isOpen,
  onToggle,
  renderRow,
  summary,
  trace,
}: {
  isOpen: boolean;
  onToggle: () => void;
  renderRow: (key: string) => ReactNode;
  summary: DelegationSummary;
  trace: ChatTraceState;
}) {
  const { t } = useTranslation();
  const drill = useDelegationDrill();
  const agentLabel = summary.agentId
    ? t(`assistant.trace.agents.${summary.agentId}`)
    : t("assistant.trace.delegatedAgent");
  const statusIcon = summary.running
    ? <Loader2 aria-hidden className="chat-trace-spinner" size={13} />
    : summary.isError
      ? <CircleX aria-hidden size={13} />
      : <CheckCircle2 aria-hidden size={13} />;
  const stepWord = t(summary.childKeys.length === 1 ? "assistant.trace.step" : "assistant.trace.steps");
  return (
    <div className="trace-delegate" data-running={summary.running || undefined} data-status={summary.isError ? "failed" : "succeeded"}>
      <div className="trace-delegate-summary-row">
        <div
          aria-expanded={isOpen}
          className="trace-delegate-summary"
          onClick={onToggle}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onToggle();
            }
          }}
          role="button"
          tabIndex={0}
        >
          {statusIcon}
          <strong>{agentLabel}</strong>
          <span>{summary.label ?? t("assistant.trace.delegateTask")}</span>
          <small>{summary.childKeys.length} {stepWord}{summary.durationMs !== undefined ? ` · ${formatDuration(summary.durationMs)}` : ""}</small>
          {isOpen ? <ChevronUp aria-hidden size={13} /> : <ChevronDown aria-hidden size={13} />}
          {!isOpen && summary.latestActivity ? (
            <span className="trace-delegate-latest">{summary.latestActivity}</span>
          ) : null}
        </div>
        {drill ? (
          <button
            aria-label={t("assistant.trace.openTask")}
            className="trace-delegate-open"
            onClick={(event) => {
              event.stopPropagation();
              drill.open({
                agentId: summary.agentId,
                callId: summary.callId,
                stateSnapshot: trace,
                isRunningNow: () => {
                  const live = drill.liveTraces.current[trace.assistantMessageId];
                  if (!live) return false;
                  return summarizeTopLevel(live).delegations.get(summary.callId)?.running ?? false;
                },
                summary: {
                  agentId: summary.agentId,
                  durationMs: summary.durationMs,
                  isError: summary.isError,
                  running: summary.running,
                },
              });
            }}
            title={t("assistant.trace.openTask")}
            type="button"
          >
            <Maximize2 aria-hidden size={12} />
          </button>
        ) : null}
      </div>
      {isOpen ? (
        <div className="trace-delegate-body">
          {summary.childKeys.map((key) => renderRow(key))}
        </div>
      ) : null}
    </div>
  );
}

function TraceAgentRow({ activity }: { activity: TraceAgentActivity }) {
  const { t } = useTranslation();
  const running = activity.status === "running";
  return (
    <div className="chat-trace-row" data-nested={Boolean(activity.parentToolCallId)}>
      <header>
        {running
          ? <Loader2 aria-hidden className="chat-trace-spinner" size={13} />
          : <CheckCircle2 aria-hidden size={13} />}
        <strong>{t(`assistant.trace.agents.${activity.agentId}`)}</strong>
        <span>{running ? t("assistant.trace.processing") : t("assistant.trace.completed")}</span>
      </header>
    </div>
  );
}

function TraceThinkingRow({ thinking }: { thinking: TraceThinking }) {
  const { t } = useTranslation();
  const preview = thinking.text
    ? `${thinking.text.slice(0, 160)}${thinking.text.length > 160 ? "…" : ""}`
    : t("assistant.trace.processing");
  return (
    <div className="chat-trace-row" data-nested={Boolean(thinking.parentToolCallId)}>
      <header>
        {thinking.status === "running"
          ? <Loader2 aria-hidden className="chat-trace-spinner" size={13} />
          : <Brain aria-hidden size={13} />}
        <strong>{t(`assistant.trace.agents.${thinking.agentId}`)}</strong>
        <span>Thinking</span>
      </header>
      <p className="chat-trace-preview">{preview}</p>
      {thinking.text.length > 160 ? (
        <DetailDisclosure label={t("assistant.trace.fullThinking")} value={thinking.text} />
      ) : null}
    </div>
  );
}

function TraceToolRow({ tool }: { tool: TraceTool }) {
  const { t } = useTranslation();
  const summary = summarizeToolRow(tool);
  const icon = tool.status === "running"
    ? <Loader2 aria-hidden className="chat-trace-spinner" size={13} />
    : tool.status === "failed"
      ? <CircleX aria-hidden size={13} />
      : <CheckCircle2 aria-hidden size={13} />;
  return (
    <div
      className={`chat-trace-row tool-${tool.status}`}
      data-nested={Boolean(tool.parentToolCallId)}
    >
      <header>
        {icon}
        <Wrench aria-hidden size={12} />
        <strong>{t(summary.verbKey, { object: summary.object })}</strong>
        {tool.durationMs !== undefined ? <small>{formatDuration(tool.durationMs)}</small> : null}
      </header>
      <DetailDisclosure label={`${t(`assistant.trace.agents.${tool.agentId}`)} · ${t("assistant.trace.arguments")}`} value={tool.args} />
      {tool.partialResult !== undefined ? (
        <DetailDisclosure label={t("assistant.trace.partialResult")} value={tool.partialResult} />
      ) : null}
      {tool.result !== undefined ? (
        <DetailDisclosure label={tool.isError ? t("assistant.trace.errorResult") : t("assistant.trace.result")} value={tool.result} />
      ) : null}
    </div>
  );
}

function TraceOutputRow({ output }: { output: TraceAgentOutput }) {
  const { t } = useTranslation();
  return (
    <div className="chat-trace-row" data-nested={Boolean(output.parentToolCallId)}>
      <header><CheckCircle2 aria-hidden size={13} /><strong>{t(`assistant.trace.agents.${output.agentId}`)}</strong><span>{t("assistant.trace.output")}</span></header>
      <p className="chat-trace-preview">{output.text.slice(0, 160)}{output.text.length > 160 ? "…" : ""}</p>
      {output.text.length > 160 ? <DetailDisclosure label={t("assistant.trace.fullOutput")} value={output.text} /> : null}
    </div>
  );
}

function DetailDisclosure({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="chat-trace-detail">
      <summary>{label}</summary>
      <pre>{formatDetail(value)}</pre>
    </details>
  );
}

function formatDuration(durationMs = 0): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatDetail(value: unknown): ReactNode {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
