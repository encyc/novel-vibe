import type {
  ChatStreamEvent,
  ChatSession,
  CursorPage,
  DocumentIndex,
  DocumentDiffPage,
  DocumentSaveResult,
  DocumentSource,
  DocumentVersionSummary,
  Project,
  SessionMessage,
  SessionPage,
  User,
  UserProfile,
  CreditSummary,
  CreditActivityDay,
  CreditTransaction,
  CreditPackage,
  MembershipPlan,
  MembershipStatus,
  MembershipEntitlement,
  ReferralPreview,
  ReferralDashboard,
  ReferralAdminMetrics,
  ReferralAdminBinding,
  AiModel,
  PurchaseStatus,
  InstalledSkill,
  SkillDraft,
  SkillReview,
  SkillRole,
  SkillVersionSummary,
  WorkspaceSkill,
  CommunityArticlePage,
  CommunityArticleDetail,
  CommunityComment,
  CommunityAuthorProfile,
  CommunitySectionMeta,
  CommunityInteractions,
  CommunityKind,
  CommunityFeedbackStatus,
  CommunitySort,
  CommunityFeedbackPage,
  DelegationTranscriptEntry,
} from "../types";
import { ApiError, ChatStreamInterruptedError, notifyUnauthorized, isRetryableFetchError, sleepWithJitter, interfaceLocaleHeaders } from "./http.js";

import type { ApiRequestContext } from "./context.js";

export async function streamChat(client: ApiRequestContext, input: {
      projectId: string;
      message?: string;
      sessionId: string;
      interactionResponse?: import("../types").InteractionResponseV1;
      activeDocumentPath?: string;
      command?: "skill-creator" | "lingqi";
      provider?: string;
      model?: string;
    }, onEvent: (event: ChatStreamEvent) => void, options: { signal?: AbortSignal } = {}): Promise<{ turnId: string | null; assistantMessageId: string | null }> {
    if (input.interactionResponse && input.message !== undefined) {
      throw new Error("Chat input cannot include both message and interactionResponse");
    }
    const body = JSON.stringify({
      project_id: input.projectId,
      ...(input.message !== undefined ? { message: input.message } : {}),
      session_id: input.sessionId,
      ...(input.interactionResponse ? { interaction_response: input.interactionResponse } : {}),
      active_document_path: input.activeDocumentPath,
      command: input.command,
      ...(input.provider && input.model ? { provider: input.provider, model: input.model } : {}),
    });

    // Retry policy for the *connection-establishment* phase only. Once a single
    // byte of the SSE stream has been received the request is considered
    // committed (a turn + billing may already exist server-side), so mid-stream
    // failures never re-issue the request — they surface as
    // ChatStreamInterruptedError exactly as before.
    const MAX_ATTEMPTS = 4;
    const BACKOFF_MS = [500, 1000, 2000];

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let res: Response | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        res = await fetch("/api/chat/stream", {
          method: "POST",
          credentials: "same-origin",
          headers: interfaceLocaleHeaders({ "Content-Type": "application/json" }),
          body,
          signal: options.signal,
        });
      } catch (err) {
        lastError = err;
        if (!isRetryableFetchError(err) || attempt === MAX_ATTEMPTS - 1) throw err;
        await sleepWithJitter(BACKOFF_MS[attempt]);
        continue;
      }

      // 4xx (incl. 401) are never retried — they won't succeed on replay.
      if (!res.ok) {
        if (res.status === 401) notifyUnauthorized();
        const is5xx = res.status >= 500 && res.status < 600;
        if (!is5xx || attempt === MAX_ATTEMPTS - 1) {
          const text = await res.text();
          let data: unknown = text;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            // Preserve non-JSON upstream errors as text.
          }
          throw new ApiError(res.status, data);
        }
        // Drain the error body before retrying to avoid leaking the stream.
        await res.body?.cancel().catch(() => {});
        await sleepWithJitter(BACKOFF_MS[attempt]);
        continue;
      }
      if (!res.body) {
        throw new ApiError(res.status, { error: "Empty chat response" });
      }

      reader = res.body.getReader();
      break;
    }

    // All attempts exhausted without opening a stream. Surface the last failure.
    if (!reader || !res) {
      throw lastError instanceof Error ? lastError : new TypeError("Chat stream connection failed");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let terminalReceived = false;
    let terminal = { turnId: null as string | null, assistantMessageId: null as string | null };

    const processFrame = (frame: string) => {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) return;
      const parsed = JSON.parse(dataLine.slice(6)) as { type?: string; version?: unknown };
      if (parsed.type === "turn_started") {
        return;
      }
      if (parsed.type === "turn_complete") {
        terminalReceived = true;
        const complete = parsed as { turn_id?: unknown; assistant_message_id?: unknown };
        terminal = {
          turnId: typeof complete.turn_id === "string" ? complete.turn_id : null,
          assistantMessageId: typeof complete.assistant_message_id === "string" ? complete.assistant_message_id : null,
        };
        return;
      }
      if (parsed.version !== 1) {
        throw new Error(`Unsupported chat stream version: ${String(parsed.version)}`);
      }
      const event = parsed as ChatStreamEvent;
      if (
        event.type === "run_finished"
        || event.type === "run_interrupted"
        || event.type === "run_failed"
      ) {
        terminalReceived = true;
      }
      onEvent(event);
    };

    const processBufferedFrames = () => {
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        processFrame(frame);
        boundary = buffer.indexOf("\n\n");
      }
    };

    // Per-read idle timeout. If the server sends no data for this long the
    // connection is likely dead (e.g. a proxy timed out silently). We cancel
    // the reader rather than hanging forever.
    const READ_IDLE_MS = 120_000;
    let receivedAnyData = false;

    while (true) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new ChatStreamInterruptedError()), READ_IDLE_MS),
          ),
        ]);
      } catch (err) {
        await reader.cancel();
        throw err;
      }
      const { value, done } = readResult;
      if (done) break;

      receivedAnyData = true;
      buffer += decoder.decode(value, { stream: true });
      processBufferedFrames();
    }

    buffer += decoder.decode();
    processBufferedFrames();
    if (buffer.trim()) processFrame(buffer);
    if (!terminalReceived) {
      // If the stream ended without delivering even a single byte, treat it as
      // a connection-level failure rather than a mid-stream interruption so
      // the caller can decide to retry safely.
      if (!receivedAnyData) {
        throw new Error("Chat stream closed before any data was received");
      }
      throw new ChatStreamInterruptedError();
    }
    return terminal;
  
}
