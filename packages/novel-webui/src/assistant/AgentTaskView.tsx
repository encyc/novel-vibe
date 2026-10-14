import { ChevronRight, CornerUpLeft, FileWarning } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { formatDate } from "../i18n/format";
import { useInterfaceLocale } from "../i18n/LocaleProvider";
import type { InterfaceLocale } from "../i18n/locale";
import type { DelegationTranscriptEntry } from "../types";
import { summarizeTopLevel } from "./chat-trace";
import type { DelegationDrillTarget } from "./delegation-drill";

const TRANSCRIPT_PAGE_LIMIT = 100;

interface AgentTaskViewProps {
  sessionId: string | null;
  target: DelegationDrillTarget;
  onBack: () => void;
}

/**
 * Read-only drill-in surface for one delegation. While the owning run is
 * still streaming it renders the captured live trace snapshot; the durable
 * transcript endpoint replaces the snapshot as soon as it has rows.
 */
export function AgentTaskView({ onBack, sessionId, target }: AgentTaskViewProps) {
  const { t } = useTranslation();
  const { locale } = useInterfaceLocale();
  // Live liveness beats the click-time snapshot: once the owning run settles,
  // polling stops and the live indicators drop.
  const running = target.isRunningNow
    ? target.isRunningNow()
    : target.summary?.running ?? false;
  const transcript = useQuery({
    enabled: Boolean(sessionId),
    queryKey: ["delegation-transcript", sessionId, target.callId],
    queryFn: () => {
      if (sessionId === null) throw new Error("missing session");
      return api.listDelegationMessages(sessionId, target.callId, { limit: TRANSCRIPT_PAGE_LIMIT });
    },
    refetchInterval: () => {
      const live = target.isRunningNow ? target.isRunningNow() : target.summary?.running ?? false;
      return live ? 3000 : false;
    },
    retry: false,
  });

  const liveEntries = target.stateSnapshot
    ? summarizeLive(target.stateSnapshot, target.callId)
    : [];
  const persisted = transcript.data?.items ?? [];
  const entries = persisted.length > 0 ? persisted : liveEntries;
  const translatedAgent = target.agentId ? t(`assistant.trace.agents.${target.agentId}`) : "";
  const title = translatedAgent.startsWith("assistant.trace.")
    ? t("assistant.trace.delegatedAgent")
    : translatedAgent;

  return (
    <section aria-label={t("assistant.task.region")} className="agent-task">
      <nav aria-label={t("assistant.task.breadcrumb")} className="agent-task-breadcrumb">
        <button className="agent-task-back" onClick={onBack} type="button">
          <CornerUpLeft aria-hidden size={13} />
          {t("assistant.task.backToChat")}
        </button>
        <ChevronRight aria-hidden size={12} />
        <strong>{title}</strong>
        {running ? (
          <span aria-label={t("assistant.trace.processing")} className="agent-task-live-dot" role="status" />
        ) : null}
      </nav>

      <div className="agent-task-body">
        {transcript.isLoading && sessionId !== null ? (
          <p className="agent-task-status">{t("assistant.task.loading")}</p>
        ) : null}
        {transcript.error ? (
          <p className="agent-task-status agent-task-error">
            <FileWarning aria-hidden size={13} />
            {t("assistant.task.empty")}
          </p>
        ) : null}
        {!transcript.error && !transcript.isLoading && entries.length === 0 && running ? (
          <p className="agent-task-status">{t("assistant.task.pending")}</p>
        ) : null}
        {!transcript.error && !transcript.isLoading && entries.length === 0 && !running ? (
          <p className="agent-task-status">{t("assistant.task.empty")}</p>
        ) : null}
        {entries.map((entry) => (
          <AgentTaskEntry entry={entry} key={`${entry.role}:${entry.id}:${entry.sequence}`} locale={locale} />
        ))}
        {transcript.data?.nextCursor ? (
          <p className="agent-task-status agent-task-truncated">{t("assistant.task.truncated")}</p>
        ) : null}
      </div>

      <footer className="agent-task-note">{t("assistant.task.readOnly")}</footer>
    </section>
  );
}

function AgentTaskEntry({ entry, locale }: { entry: DelegationTranscriptEntry; locale: InterfaceLocale }) {
  // Sub-agent injected prompts are noisy for a replay skim — skip them.
  if (entry.role === "user") return null;
  return (
    <article className="agent-task-entry" data-role={entry.role}>
      <header>
        <span>{entry.role}</span>
        <time>{shortTime(entry.createdAt, locale)}</time>
      </header>
      {entry.blocks.map((block, index) => block.kind === "reasoning" ? (
        <details className="agent-task-reasoning" key={index}>
          <summary>{shortReasoning(block.text)}</summary>
          <pre>{block.text}</pre>
        </details>
      ) : block.kind === "tool" ? (
        <code className="agent-task-tool" key={index}>{block.text}</code>
      ) : (
        <p key={index}>{block.text}</p>
      ))}
    </article>
  );
}

function shortTime(value: string, locale: InterfaceLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatDate(date, locale, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function shortReasoning(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 72 ? `${trimmed.slice(0, 72)}…` : trimmed || "…";
}

interface LiveBlockEntry {
  id: string;
  sequence: number;
  role: DelegationTranscriptEntry["role"];
  blocks: DelegationTranscriptEntry["blocks"];
  createdAt: string;
}

/** Folds the captured live trace into replay-shaped entries for one delegation. */
function summarizeLive(
  state: NonNullable<DelegationDrillTarget["stateSnapshot"]>,
  callId: string,
): LiveBlockEntry[] {
  const summary = summarizeTopLevel(state).delegations.get(callId);
  if (!summary) return [];
  const entries: LiveBlockEntry[] = [];
  let sequence = 1;
  for (const key of summary.childKeys) {
    if (key.startsWith("thinking:")) {
      const item = state.thinking[key.slice("thinking:".length)];
      if (!item?.text) continue;
      entries.push({
        blocks: [{ kind: "reasoning", text: item.text }],
        createdAt: new Date().toISOString(),
        id: key,
        role: "assistant",
        sequence: sequence++,
      });
    } else if (key.startsWith("tool:")) {
      const item = state.tools[key.slice("tool:".length)];
      if (!item) continue;
      entries.push({
        blocks: [{ kind: "tool", text: `${item.toolName}${item.status === "failed" ? " ✕" : ""}` }],
        createdAt: new Date().toISOString(),
        id: key,
        role: "tool",
        sequence: sequence++,
      });
    } else if (key.startsWith("output:")) {
      const item = state.outputs[key.slice("output:".length)];
      if (!item?.text) continue;
      entries.push({
        blocks: [{ kind: "text", text: item.text }],
        createdAt: new Date().toISOString(),
        id: key,
        role: "assistant",
        sequence: sequence++,
      });
    }
  }
  return entries;
}
