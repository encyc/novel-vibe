import type { TurnOutcome } from "../types.ts";
import type { BffClient } from "./bff-client.ts";

export interface ChatTurnInput {
  projectId: string;
  sessionId: string;
  message: string;
  provider?: string;
  model?: string;
  /** Whole-turn budget including queue retries and the SSE stream. */
  timeoutMs: number;
  /** Abort when no SSE frames (data or keepalive) arrive for this long. */
  stallTimeoutMs?: number;
}

export interface RetryPolicy {
  attempts: number;
  backoffMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, backoffMs: 2_000 };

interface SseEvent {
  type?: string;
  message?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive one chat turn to its terminal state over the BFF SSE stream.
 * Success is `turn_complete`; `run_failed`/`run_interrupted` are failures;
 * a stream that ends without any terminal event is a failure.
 * Retries 409 SESSION_BUSY with exponential backoff (stale lease takeover);
 * one AbortController spans the whole turn including retries.
 */
export async function runChatTurn(
  client: BffClient,
  input: ChatTurnInput,
  retry: RetryPolicy = DEFAULT_RETRY,
): Promise<TurnOutcome> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let abortReason = "turn timed out";
  const timer = setTimeout(() => {
    abortReason = `turn timed out after ${input.timeoutMs}ms`;
    controller.abort();
  }, input.timeoutMs);
  try {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await client.chatStream(input, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) {
          return { kind: "failed", reason: abortReason, startedAt, endedAt: Date.now() };
        }
        return { kind: "failed", reason: "chat request failed: " + String(err), startedAt, endedAt: Date.now() };
      }
      if (!res.ok) {
        const outcome = await classifyHttpError(res, controller.signal);
        if (outcome.retry && attempt < retry.attempts) {
          await sleep(retry.backoffMs * 2 ** attempt);
          continue;
        }
        return outcome.turn;
      }
      if (!res.body) {
        return { kind: "failed", reason: "SSE response has no body", startedAt, endedAt: Date.now() };
      }
      return await consumeStream(res.body, startedAt, controller.signal, input.stallTimeoutMs ?? 180_000, () => {
        abortReason = `no stream activity for ${(input.stallTimeoutMs ?? 180_000) / 1000}s`;
        controller.abort();
      }, () => abortReason);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function classifyHttpError(
  res: Response,
  signal: AbortSignal,
): Promise<{ turn: TurnOutcome; retry: boolean }> {
  const startedAt = Date.now();
  const bodyText = await res.text().catch(() => "");
  let code = "HTTP_ERROR";
  let message = `status ${res.status}: ${bodyText.slice(0, 200)}`;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: string; message?: string } };
    if (parsed.error?.code) code = parsed.error.code;
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    // non-JSON error body
  }
  return {
    turn: {
      kind: "failed",
      reason: `${code}: ${message}`,
      startedAt,
      endedAt: Date.now(),
    },
    retry: res.status === 409 && code === "SESSION_BUSY" && !signal.aborted,
  };
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  startedAt: number,
  signal: AbortSignal,
  stallTimeoutMs: number,
  onStall: () => void,
  abortReason: () => string,
): Promise<TurnOutcome> {
  const decoder = new TextDecoder();
  let buffer = "";
  let turnStartedAt: number | null = null;
  let lastFrameAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastFrameAt > stallTimeoutMs) onStall();
  }, 5_000);
  if (typeof watchdog.unref === "function") watchdog.unref();
  try {
    for await (const chunk of body) {
      lastFrameAt = Date.now();
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const event = parseFrame(frame);
        if (!event) continue;
        if (event.type === "turn_started" && turnStartedAt === null) {
          turnStartedAt = Date.now();
        }
        const outcome = onEvent(event, turnStartedAt ?? startedAt);
        if (outcome) return outcome;
      }
    }
    return { kind: "failed", reason: "stream ended without terminal event", startedAt: turnStartedAt ?? startedAt, endedAt: Date.now() };
  } catch (err) {
    const reason = signal.aborted
      ? abortReason()
      : "SSE read failed: " + String(err);
    return { kind: "failed", reason, startedAt: turnStartedAt ?? startedAt, endedAt: Date.now() };
  } finally {
    clearInterval(watchdog);
  }
}

function parseFrame(frame: string): SseEvent | null {
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // keepalive comment frame
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        return JSON.parse(payload) as SseEvent;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function onEvent(event: SseEvent, startedAt: number): TurnOutcome | null {
  if (event.type === "turn_complete") {
    return { kind: "complete", startedAt, endedAt: Date.now() };
  }
  if (event.type === "run_failed" || event.type === "run_interrupted") {
    return { kind: "failed", reason: `${event.type}: ${event.message ?? ""}`.trim(), startedAt, endedAt: Date.now() };
  }
  return null;
}
