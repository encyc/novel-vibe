import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Send, Square } from "lucide-react";
import { FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { api, ChatStreamInterruptedError } from "../api/client";
import { localizeApiError } from "../i18n/error-message";
import { sessionMessagesQueryKey } from "../session/useProjectSessions";
import { resolveSubmit } from "../conversation/submission-policy";
import { createSessionQueue } from "../conversation/queue-store";
import { QueueDock } from "../conversation/QueueDock";
import type { ChatSession, ChatStreamEvent, CursorPage, InteractionResponseV1, Project, SessionInteraction, SessionMessage } from "../types";
import { ChatTrace } from "./ChatTrace";
import { initialChatTrace, interruptChatTrace, reduceChatTrace, restorePersistedChatTrace, type ChatTraceState } from "./chat-trace";
import { DocumentChangeCard } from "./DocumentChangeCard";
import { Markdown } from "./Markdown";
import { InteractionCard } from "./InteractionCard";
import { AssistantEmptyState } from "./AssistantEmptyState";
import { RunPlanCard } from "./RunPlanCard";
import type { ModelSelection } from "./ModelSelector";

/** Official slash commands surfaced in the composer autocomplete. */
const CHAT_COMMANDS = [
  { command: "skill-creator", labelKey: "assistant.commands.skillCreator" },
  { command: "lingqi", labelKey: "assistant.commands.lingqi" },
] as const;

type ChatCommand = (typeof CHAT_COMMANDS)[number]["command"];

function matchCommands(input: string) {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return [];
  return CHAT_COMMANDS.filter((item) => `/${item.command}`.startsWith(trimmed));
}

interface ChatPanelProps {
  activeDocumentPath: string | null;
  currentSession: ChatSession | null;
  project: Project | null;
  messages: SessionMessage[];
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  modelSelection?: ModelSelection;
  onLoadOlderMessages: () => void | Promise<unknown>;
  /** Shell-provided review opener; when absent the card falls back to routing. */
  onOpenDocumentChange?: (versionId: string) => void;
  onBusyChange?: (busy: boolean) => void;
  accessMode?: "writable" | "read-only";
  composerAutoFocus?: boolean;
}

type MessagePages = InfiniteData<CursorPage<SessionMessage>, string>;

function inferDocumentModule(path: string) {
  if (/^(world|worldview)\//.test(path)) return "world";
  if (/^(characters|relationships)\//.test(path)) return "characters";
  if (/^(outline|volumes|chapter-cards|foreshadow)\//.test(path)) return "outline";
  if (/^(scripts|director-scripts)\//.test(path)) return "scripts";
  if (/^(continuity|story-summaries|character-states)\//.test(path)) return "continuity";
  if (/^lingqi\//.test(path)) return "lingqi";
  return "chapters";
}

interface ActiveRun {
  assistantMessageId: string;
  controller: AbortController;
  sessionId: string;
  turnId: string;
}


/**
 * Coalesces streaming answer text into one animation-frame commit against the
 * query cache. Terminal states must call flushNow() so nothing is lost when
 * the run ends between frames (the borrowed dsh notifier discipline).
 */
function createOptimisticTextSink(
  update: (patch: Partial<SessionMessage>) => void,
) {
  let pending = "";
  let frame: number | null = null;
  const commit = () => {
    frame = null;
    update({ text: pending });
  };
  return {
    /** Replace the buffered value and schedule a coalesced commit. */
    push(value: string) {
      pending = value;
      if (frame !== null) return;
      if (typeof window.requestAnimationFrame === "function") {
        frame = window.requestAnimationFrame(commit);
      } else {
        commit();
      }
    },
    /** Cancel any scheduled frame, optionally replace the buffer, commit now. */
    flushNow(value?: string) {
      if (value !== undefined) pending = value;
      if (frame !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frame);
      }
      frame = null;
      update({ text: pending });
    },
  };
}

export function ChatPanel({
  activeDocumentPath,
  currentSession,
  hasOlderMessages,
  loadingOlderMessages,
  messages,
  modelSelection,
  onLoadOlderMessages,
  onOpenDocumentChange,
  onBusyChange,
  project,
  accessMode = "writable",
  composerAutoFocus = false,
}: ChatPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const STALE_PROCESSING_MS = 15 * 60 * 1000; // 15 min — must exceed server lease TTL (10 min)

  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [traces, setTraces] = useState<Record<string, ChatTraceState>>({});
  const activeRunRef = useRef<ActiveRun | null>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => setTraces({}), [currentSession?.id]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages, traces]);

  function setBusyState(nextBusy: boolean) {
    setBusy(nextBusy);
    onBusyChange?.(nextBusy);
  }

  function appendOptimistic(sessionId: string, additions: SessionMessage[]) {
    queryClient.setQueryData<MessagePages>(sessionMessagesQueryKey(sessionId), (data) => {
      if (!data) return { pages: [{ items: additions, nextCursor: null }], pageParams: [""] };
      return {
        ...data,
        pages: data.pages.map((page, index) => index === 0
          ? { ...page, items: [...page.items, ...additions] }
          : page),
      };
    });
  }

  function updateOptimistic(sessionId: string, messageId: string, patch: Partial<SessionMessage>) {
    queryClient.setQueryData<MessagePages>(sessionMessagesQueryKey(sessionId), (data) => data ? ({
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((message) => message.id === messageId ? { ...message, ...patch } : message),
      })),
    }) : data);
  }

  function updateTrace(turnId: string, assistantMessageId: string, event: ChatStreamEvent) {
    setTraces((current) => ({
      ...current,
      [turnId]: reduceChatTrace(
        current[turnId] ?? initialChatTrace(assistantMessageId),
        event,
      ),
    }));
  }

  async function sendText(text: string, command?: ChatCommand, commandArgs?: string) {
    const isStale = currentSession?.isProcessing &&
      currentSession.processingStartedAt &&
      Date.now() - new Date(currentSession.processingStartedAt).getTime() > STALE_PROCESSING_MS;
    if (!project || !currentSession || busy || (currentSession.isProcessing && !isStale)) return;
    const now = new Date().toISOString();
    const turnId = crypto.randomUUID();
    const userMessage: SessionMessage = {
      id: crypto.randomUUID(), turnId, role: "user", text, status: "complete", createdAt: now,
    };
    const assistantMessage: SessionMessage = {
      id: crypto.randomUUID(), turnId, role: "assistant", text: "", status: "running", createdAt: now,
    };
    const controller = new AbortController();
    const activeRun: ActiveRun = {
      assistantMessageId: assistantMessage.id,
      controller,
      sessionId: currentSession.id,
      turnId,
    };

    appendOptimistic(currentSession.id, [userMessage, assistantMessage]);
    setInput("");
    setStopError(null);
    activeRunRef.current = activeRun;
    setBusyState(true);

    try {
      let accumulated = "";
      const textSink = createOptimisticTextSink((patch) =>
        updateOptimistic(currentSession.id, assistantMessage.id, patch));
      const terminal = await api.streamChat({
        projectId: project.id,
        message: command ? (commandArgs ?? "") : text,
        sessionId: currentSession.id,
        activeDocumentPath: activeDocumentPath ?? undefined,
        command,
        provider: modelSelection?.provider,
        model: modelSelection?.model,
      }, (streamEvent) => {
        if (streamEvent.type === "answer_delta") {
          accumulated += streamEvent.delta;
          textSink.push(accumulated);
        } else if (streamEvent.type === "answer_finished") {
          accumulated = streamEvent.text;
          textSink.flushNow(accumulated);
        } else if (streamEvent.type === "run_failed" && !accumulated) {
          accumulated = streamEvent.message;
          textSink.flushNow(accumulated);
        }
        updateTrace(turnId, assistantMessage.id, streamEvent);
      }, { signal: controller.signal });
      textSink.flushNow();
      if (terminal?.turnId && terminal.assistantMessageId) {
        setTraces((current) => {
          const live = current[turnId];
          if (!live) return current;
          return { ...current, [terminal.turnId!]: { ...live, assistantMessageId: terminal.assistantMessageId! } };
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const interrupted = error instanceof ChatStreamInterruptedError;
        const message = interrupted
          ? t("assistant.trace.interrupted")
          : localizeApiError(error, "assistant.sendFailed");
        setTraces((current) => {
          const existing = current[turnId] ?? initialChatTrace(assistantMessage.id);
          const next = interrupted
            ? interruptChatTrace(existing)
            : { ...existing, status: "failed" as const, error: message };
          return { ...current, [turnId]: next };
        });
      }
    } finally {
      if (activeRunRef.current === activeRun) activeRunRef.current = null;
      setBusyState(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sessionMessagesQueryKey(currentSession.id) }),
        queryClient.invalidateQueries({ queryKey: ["sessions", project.id] }),
      ]);
      const next = queueRef.current.shift();
      if (next) setTimeout(() => { setInput(""); void sendText(next); }, 50);
    }
  }

  async function sendInteraction(response: InteractionResponseV1) {
    if (!project || !currentSession || busy || currentSession.isProcessing) throw new Error("Session is unavailable");
    const now = new Date().toISOString();
    const turnId = crypto.randomUUID();
    const userMessage: SessionMessage = {
      id: crypto.randomUUID(), turnId, role: "user", text: t("assistant.interaction.responseSent"),
      interactionResponse: response, status: "complete", createdAt: now,
    };
    const assistantMessage: SessionMessage = {
      id: crypto.randomUUID(), turnId, role: "assistant", text: "", status: "running", createdAt: now,
    };
    const controller = new AbortController();
    const activeRun: ActiveRun = { assistantMessageId: assistantMessage.id, controller, sessionId: currentSession.id, turnId };
    appendOptimistic(currentSession.id, [userMessage, assistantMessage]);
    activeRunRef.current = activeRun;
    setStopError(null);
    setBusyState(true);
    try {
      let accumulated = "";
      const textSink = createOptimisticTextSink((patch) =>
        updateOptimistic(currentSession.id, assistantMessage.id, patch));
      const terminal = await api.streamChat({
        projectId: project.id,
        sessionId: currentSession.id,
        interactionResponse: response,
        provider: modelSelection?.provider,
        model: modelSelection?.model,
      }, (streamEvent) => {
        if (streamEvent.type === "answer_delta") {
          accumulated += streamEvent.delta;
          textSink.push(accumulated);
        } else if (streamEvent.type === "answer_finished") {
          accumulated = streamEvent.text;
          textSink.flushNow(accumulated);
        } else if (streamEvent.type === "run_failed" && !accumulated) {
          accumulated = streamEvent.message;
          textSink.flushNow(accumulated);
        }
        updateTrace(turnId, assistantMessage.id, streamEvent);
      }, { signal: controller.signal });
      textSink.flushNow();
      if (terminal.turnId && terminal.assistantMessageId) {
        setTraces((current) => {
          const live = current[turnId];
          return live ? { ...current, [terminal.turnId!]: { ...live, assistantMessageId: terminal.assistantMessageId! } } : current;
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof ChatStreamInterruptedError
          ? t("assistant.trace.interrupted")
          : localizeApiError(error, "assistant.interaction.submitFailed");
        setTraces((current) => ({
          ...current,
          [turnId]: { ...(current[turnId] ?? initialChatTrace(assistantMessage.id)), status: "failed", error: message },
        }));
      }
      throw error;
    } finally {
      if (activeRunRef.current === activeRun) activeRunRef.current = null;
      setBusyState(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sessionMessagesQueryKey(currentSession.id) }),
        queryClient.invalidateQueries({ queryKey: ["sessions", project.id] }),
      ]);
    }
  }

  async function stopGeneration() {
    const activeRun = activeRunRef.current;
    const sessionId = activeRun?.sessionId ?? currentSession?.id;
    if (!sessionId || stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      const result = await api.interruptSession(sessionId);
      if (!result.interrupted) throw new Error(t("assistant.nothingToStop"));
      if (activeRun) {
        updateOptimistic(activeRun.sessionId, activeRun.assistantMessageId, { status: "interrupted" });
        setTraces((current) => ({
          ...current,
          [activeRun.turnId]: interruptChatTrace(
            current[activeRun.turnId] ?? initialChatTrace(activeRun.assistantMessageId),
            t("assistant.stopped"),
          ),
        }));
        activeRun.controller.abort();
      } else {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: sessionMessagesQueryKey(sessionId) }),
          project
            ? queryClient.invalidateQueries({ queryKey: ["sessions", project.id] })
            : Promise.resolve(),
        ]);
      }
    } catch (error) {
      setStopError(error instanceof Error && error.message
        ? error.message
        : t("assistant.stopFailed"));
    } finally {
      setStopping(false);
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    // Match either a bare "/lingqi" or "/lingqi <args>" — the args become the
    // message payload the server forwards to buildLingqiPrompt as the request.
    const cmdMatch = CHAT_COMMANDS.find((item) => {
      const slash = `/${item.command}`;
      return text === slash || text.startsWith(`${slash} `);
    });
    if (cmdMatch) {
      const slash = `/${cmdMatch.command}`;
      const args = text.slice(slash.length).trim();
      void sendText(text, cmdMatch.command, args);
    } else if (text) {
      void sendText(text);
    }
  }

  function retry(message: SessionMessage) {
    const original = messages.find((candidate) => candidate.turnId === message.turnId && candidate.role === "user");
    if (original) void sendText(original.text);
  }

  const unavailable = !project || !currentSession || accessMode === "read-only";
  const sessionStale = Boolean(
    currentSession?.isProcessing &&
    currentSession.processingStartedAt &&
    Date.now() - new Date(currentSession.processingStartedAt).getTime() > STALE_PROCESSING_MS,
  );
  const processing = busy || (Boolean(currentSession?.isProcessing) && !sessionStale);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const queueRef = useRef(createSessionQueue(currentSession?.id ?? "none"));
  const [queueRevision, setQueueRevision] = useState(0);
  useEffect(() => {
    queueRef.current = createSessionQueue(currentSession?.id ?? "none");
    setQueueRevision((n) => n + 1);
  }, [currentSession?.id]);
  // Bottom-follow discipline borrowed from dsh: stick to the tail while the
  // reader is already near it, detach as soon as they scroll up, and offer an
  // explicit jump back instead of yanking them down.
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const attachedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // autoFocus only fires when the textarea first mounts; session bootstrap can
  // mount it while still disabled, so re-focus once typing becomes possible.
  useEffect(() => {
    if (composerAutoFocus && !unavailable && !processing) {
      composerRef.current?.focus();
    }
  }, [composerAutoFocus, unavailable, processing]);

  function handleMessagesScroll() {
    const el = messagesScrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = gap < 48;
    attachedRef.current = nearBottom;
    setShowJump(!nearBottom);
  }

  useLayoutEffect(() => {
    const el = messagesScrollRef.current;
    if (!el || !attachedRef.current) return;
    el.scrollTop = el.scrollHeight;
  });

  function jumpToLatest() {
    const el = messagesScrollRef.current;
    attachedRef.current = true;
    setShowJump(false);
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }
  const livePlans = Object.values(traces).flatMap((trace) => trace.runPlan ? [trace.runPlan] : []);
  const persistedPlans = messages.flatMap((message) => message.trace?.steps.flatMap((step) => step.type === "run_plan" ? [step.plan] : []) ?? []);
  const latestRunPlan = livePlans.at(-1) ?? persistedPlans.at(-1);

  return (
    <section className="assistant-chat">
      <div aria-live="polite" className="assistant-messages" onScroll={handleMessagesScroll} ref={messagesScrollRef}>
        {showJump ? (
          <div className="assistant-jump-wrap">
            <button className="assistant-jump" onClick={jumpToLatest} type="button">{t("assistant.jumpToLatest")}</button>
          </div>
        ) : null}
        {hasOlderMessages ? (
          <button className="assistant-load-older" disabled={loadingOlderMessages} onClick={() => void onLoadOlderMessages()} type="button">
            {loadingOlderMessages ? t("assistant.loadingOlder") : t("assistant.loadOlder")}
          </button>
        ) : null}
        {messages.length === 0 ? (
          <AssistantEmptyState
            activeDocumentPath={activeDocumentPath}
            onStart={(message) => void sendText(message)}
            writable={accessMode === "writable"}
          />
        ) : null}
        {messages.map((message) => {
          const original = message.role === "assistant"
            ? messages.find((candidate) => candidate.turnId === message.turnId && candidate.role === "user")
            : null;
          const trace = message.role === "assistant"
            ? traces[message.turnId] ?? (message.trace ? restorePersistedChatTrace(message.trace, message.id, message.status) : null)
            : null;
          const liveInteractions: SessionInteraction[] = trace
            ? Object.values(trace.interactions).flatMap((item) => item.request ? [{
                id: item.request.id,
                assistantMessageId: message.id,
                request: item.request,
                status: item.status,
                ...(item.status === "resolved" ? { response: {
                  schemaVersion: 1 as const,
                  interactionId: item.request.id,
                  idempotencyKey: "live",
                  answers: item.answers ?? [],
                  ...(item.freeAnswer ? { freeAnswer: item.freeAnswer } : {}),
                } } : {}),
              }] : [])
            : [];
          const interactions = [...(message.interactions ?? []), ...liveInteractions]
            .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
          return (
            <article className={`assistant-message ${message.role}`} data-status={message.status} key={message.id}>
              <span>{message.role === "user" ? t("assistant.user") : t("assistant.chiefEditor")}</span>
              {trace ? <ChatTrace trace={trace} /> : null}
              {message.role === "assistant" ? <Markdown live={message.status === "running"}>{message.text || "..."}</Markdown> : <p>{message.text}</p>}
              {trace && Object.keys(trace.documentChanges).length > 0 && project ? (
                <DocumentChangeCard
                  changes={Object.values(trace.documentChanges)}
                  onOpen={(path, versionId) => {
                    if (onOpenDocumentChange) {
                      onOpenDocumentChange(versionId);
                      return;
                    }
                    navigate(
                      `/projects/${project.id}/${inferDocumentModule(path)}?document=${encodeURIComponent(path)}&version=${encodeURIComponent(versionId)}`,
                    );
                  }}
                />
              ) : null}
              {message.role === "assistant" ? interactions.map((interaction) => (
                <InteractionCard
                  disabled={accessMode === "read-only" || processing}
                  interaction={interaction}
                  key={interaction.id}
                  onSubmit={sendInteraction}
                />
              )) : null}
              {message.role === "assistant" && (message.status === "failed" || message.status === "interrupted") && original ? (
                <button aria-label={t("assistant.retryMessage", { message: original.text })} className="assistant-retry" onClick={() => retry(message)} type="button">
                  <RotateCcw size={12} />{t("assistant.retry")}
                </button>
              ) : null}
            </article>
          );
        })}
        <div ref={messageEndRef} />
      </div>

      {latestRunPlan ? <RunPlanCard plan={latestRunPlan} /> : null}

      <QueueDock
        onChange={() => setQueueRevision((n) => n + 1)}
        onSendNow={(text) => void sendText(text)}
        queue={queueRef.current}
        revision={queueRevision}
      />

      <form className="assistant-composer" onSubmit={submit}>
        {(() => {
          const matches = matchCommands(input);
          return matches.length ? (
            <div aria-label={t("assistant.commands.available")} className="assistant-command-menu" data-motion="drawer-reveal" role="listbox">
              {matches.map((item) => (
                <button
                  aria-label={`/${item.command} ${t(item.labelKey)}`}
                  key={item.command}
                  onClick={() => setInput(`/${item.command}`)}
                  role="option"
                  type="button"
                >
                  <strong>/{item.command}</strong>
                  <span>{t(item.labelKey)}</span>
                </button>
              ))}
            </div>
          ) : null;
        })()}
        <textarea
          ref={composerRef}
          aria-label={t("assistant.composerAria")}
          autoFocus={composerAutoFocus}
          disabled={unavailable}
          enterKeyHint="send"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              const text = event.currentTarget.value.trim();
              if (unavailable || !text) return;
              if (resolveSubmit(processing) === "queue") {
                queueRef.current.enqueue(text);
                setInput("");
                setQueueRevision((n) => n + 1);
                return;
              }
              submit();
            }
          }}
          placeholder={accessMode === "read-only" ? t("assistant.readOnly") : currentSession ? t("assistant.placeholder") : t("assistant.preparing")}
          rows={4}
          value={input}
        />
        {stopError ? <p className="assistant-stop-error" role="alert">{stopError}</p> : null}
        <span className="assistant-hint"><kbd>⏎</kbd> {t("assistant.hintSend")} · <kbd>Shift</kbd>+<kbd>⏎</kbd> {t("assistant.hintNewline")}</span>
        {processing && !unavailable ? (
          <button aria-label={t("assistant.stop")} className="assistant-send assistant-stop" disabled={stopping} onClick={() => void stopGeneration()} type="button">
            <Square fill="currentColor" size={12} />
          </button>
        ) : (
          <button aria-label={t("assistant.send")} className="assistant-send" disabled={unavailable || processing || !input.trim()} type="submit">
            <Send size={17} />
          </button>
        )}
      </form>
    </section>
  );
}
