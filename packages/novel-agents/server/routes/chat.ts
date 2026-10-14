import { InsufficientCreditsError } from "../../lib/policy-ports.js";
import { DbClient } from "../../lib/db.js";
import { byokEncryptionConfigured, splitByokProvider } from "../../lib/byok.js";
import { ByokCipherError, decryptByokSecret } from "../../lib/crypto.js";
import { ProjectDomainError, type ProjectLifecycleStatus } from "../../project/types.js";
import { SessionDomainError } from "../../session/types.js";
import { SessionService, SessionTurnInterruptedError } from "../../session/service.js";
import { buildLingqiPrompt } from "../../skills/lingqi-command.js";
import { buildSkillCreatorPrompt, parseChatCommand } from "../../skills/creator-command.js";
import { corsHeaders } from "../http.js";
import { createChatTraceAdapter, type AgentId as TraceAgentId, type ChatStreamEvent } from "../../lib/chat-trace.js";
import { createPersistedTracePersistence } from "../../lib/persisted-chat-trace.js";
import { createProjectService } from "../runtime.js";
import { errorResponse } from "../http.js";
import { getSessionRuntime } from "../runtime.js";
import { parseBody } from "../http.js";
import { parseInteractionResponseEnvelope } from "../http.js";
import { randomUUID } from "node:crypto";

import type { RouteContext } from "../http.js";

import { createLogger } from "../../lib/logger.js";

const log = createLogger("server");

const FREE_MODEL_LIMIT_MESSAGE = "免费模型使用额度已达上限或当前受限，请切换付费模型。";

const INSUFFICIENT_CREDIT_MESSAGE = "账户额度不足，请充值后再试。";

/**
 * Neutral message for failures that belong to the platform, not the user's
 * wallet. The detail stays in the server log: telling a funded user to top up
 * (or exposing the platform's own provider billing state) is both misleading
 * and an information disclosure.
 */
const SERVICE_UNAVAILABLE_MESSAGE = "模型服务暂时不可用，请稍后重试。";

const PREMIUM_MODEL_MESSAGE = "高级模型为月卡会员专属，请开通月卡或切换其他模型。";

const BYOK_DISABLED_MESSAGE = "自带模型密钥功能暂未开放。";

const BYOK_MEMBERSHIP_MESSAGE = "自带模型密钥（BYOK）为月卡会员专属，请开通月卡或切换平台模型。";

const BYOK_KEY_MISSING_MESSAGE = "尚未配置该模型的 API Key，请到 设置 → 自带模型密钥 保存 Key 后再试。";

const BYOK_KEY_INVALID_MESSAGE = "你的 API Key 无效或已被上游拒绝，请到 设置 → 自带模型密钥 更换 Key 后重试。";

const BYOK_RATE_LIMIT_MESSAGE = "你的 API Key 触发上游限流或额度不足，请稍后再试。";

const BYOK_DECRYPT_MESSAGE = "你的 API Key 无法解密，请到 设置 → 自带模型密钥 重新保存。";

/**
 * Failures caused by the platform side: upstream provider billing/quota
 * problems, infrastructure permission errors, rate limits, auth problems.
 * Their raw text never reaches the user, and they never become a top-up prompt.
 */
function isPlatformFailure(msg: string, lower: string): boolean {
  return (
    /\b(401|402|403|429)\b/.test(msg) ||
    lower.includes("payment") ||
    lower.includes("billing") ||
    lower.includes("insufficient") ||
    lower.includes("quota") ||
    lower.includes("credit") ||
    lower.includes("exceeded") ||
    lower.includes("rate limit") ||
    lower.includes("unauthorized") ||
    lower.includes("permission denied") ||
    msg.includes("额度") ||
    msg.includes("余额")
  );
}

/** Strips credentials and caps length before an error reaches the log. */
function sanitizeErrorForLog(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function classifyChatError(err: unknown, isByokRequest = false): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("freeusagelimiterror")) return FREE_MODEL_LIMIT_MESSAGE;
  if (isByokRequest) {
    if (lower.includes("429") || lower.includes("rate limit") || lower.includes("quota")) {
      return BYOK_RATE_LIMIT_MESSAGE;
    }
    if (/\b401\b/.test(msg) || /\b403\b/.test(msg) || lower.includes("unauthorized")) {
      return BYOK_KEY_INVALID_MESSAGE;
    }
    if (err instanceof ByokCipherError) return BYOK_DECRYPT_MESSAGE;
    return msg;
  }
  // Only a real balance rejection may ask the user to top up.
  if (err instanceof InsufficientCreditsError) return INSUFFICIENT_CREDIT_MESSAGE;
  if (isPlatformFailure(msg, lower)) return SERVICE_UNAVAILABLE_MESSAGE;
  return msg;
}

export async function chatPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService, entitlements, chatPreflight }: RouteContext) {
  const body = JSON.parse(await parseBody(req));
  const { project_id, message, session_id, provider, model, active_document_path } = body;
  const command = parseChatCommand(body);
  const interactionResponse = parseInteractionResponseEnvelope(body.interaction_response);
  if (interactionResponse && (command || (typeof message === "string" && message.trim()))) {
    errorResponse(res, 400, "INVALID_CHAT_INPUT", "Use either message, command, or interaction_response");
    return;
  }
  const chatMessage = interactionResponse
    ? `The user submitted this typed interaction response. Continue from it without asking them to repeat it:\n${JSON.stringify(interactionResponse)}`
    : command?.type === "skill-creator"
    ? buildSkillCreatorPrompt(typeof message === "string" ? message : undefined)
    : command?.type === "lingqi"
      ? buildLingqiPrompt(typeof message === "string" ? message : undefined)
      : message;

  if (!project_id || !session_id || !chatMessage) {
    errorResponse(res, 400, "INVALID_CHAT_INPUT", "Missing project_id, session_id, or message");
    return;
  }

  const project = await createProjectService(token).get(project_id);
  if (project.lifecycle_status !== "active") {
    throw new ProjectDomainError(
      "PROJECT_READ_ONLY",
      "Project is read-only",
      409,
      { lifecycleStatus: project.lifecycle_status },
    );
  }

  // Keep track of whether the response is still writable to avoid
  // writing to a closed stream after cleanup.
  let ended = false;
  let streamStarted = false;
  const ensureStream = () => {
    if (streamStarted) return;
    streamStarted = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    });
  };
  const writeTraceEvent = (event: ChatStreamEvent) => {
    if (ended || res.writableEnded || res.destroyed) return;
    ensureStream();
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  // SSE keepalive — prevents proxies (nginx, etc.) from killing the
  // connection during long gaps between events (e.g. tool calls, model
  // thinking after loading a skill).
  const keepaliveInterval = setInterval(() => {
    if (ended || res.writableEnded || res.destroyed) return;
    if (streamStarted) res.write(": keepalive\n\n");
  }, 30_000);
  const runtime = getSessionRuntime(userId, token);
  let assistantMessageId: string | null = null;
  const tracePersistence = createPersistedTracePersistence({
    save: (messageId, snapshot) => runtime.repository.saveMessageTrace(messageId, snapshot),
  });
  const runId = randomUUID();
  const trace = createChatTraceAdapter({
    runId,
    projectId: project_id,
    emit: (event) => {
      tracePersistence.push(event);
      writeTraceEvent(event);
    },
    rawLogEnabled: process.env.AGENT_TRACE_LOG === "1",
  });
  let traceStarted = false;
  let interactionResolutionEmitted = false;
  // Declared above the try so the catch can classify BYOK-scoped errors.
  let byokBase: ReturnType<typeof splitByokProvider> = null;
  let byokApiKey: string | undefined;
  const ensureTraceStarted = () => {
    if (traceStarted) return;
    traceStarted = true;
    trace.runStarted();
  };

  try {
    // Pre-flight credit authorization: every chat turn costs tokens, so
    // block before calling the LLM rather than discovering it mid-run.
    // Free models (all rate components zero in credit_rates) are exempt.
    // Throwing here lets the catch below emit a uniform run_failed event.
    // The facts come from the composition root's turn-cost port; the gate
    // itself — branch order, messages, error identity — stays here.
    const turnCost = chatPreflight();
    const entitlementPort = entitlements();
    const effectiveProvider = provider ?? process.env.LLM_PROVIDER ?? "deepseek";
    const effectiveModel = model ?? process.env.LLM_MODEL ?? "deepseek-v4-flash";
    byokBase = splitByokProvider(effectiveProvider);
    if (byokBase) {
      // BYOK turns bill the user's own provider account: entitlement + key
      // presence replace the platform premium gate and balance pre-check.
      if (!byokEncryptionConfigured()) throw new Error(BYOK_DISABLED_MESSAGE);
      if (!(await entitlementPort.has(userId, "byok"))) throw new Error(BYOK_MEMBERSHIP_MESSAGE);
      const row = await DbClient.forSystem().findActiveUserLlmKey(userId, byokBase);
      if (!row) throw new Error(BYOK_KEY_MISSING_MESSAGE);
      byokApiKey = decryptByokSecret(String(row.encrypted_key));
    } else {
      if (turnCost.isPremiumModel(effectiveModel)) {
        if (!(await entitlementPort.has(userId, "premium_models"))) {
          throw new Error(PREMIUM_MODEL_MESSAGE);
        }
      }
      const isFreeModel = await turnCost.isFreeModel(effectiveModel, effectiveProvider);
      if (!isFreeModel) {
        const balance = await turnCost.getBalance(userId);
        if (!balance || balance.balance <= 0) {
          throw new InsufficientCreditsError(balance?.balance ?? 0);
        }
      }
    }

    const contextualMessage = typeof active_document_path === "string" && active_document_path
      ? `<active_document path=${JSON.stringify(active_document_path)} />\n${chatMessage}`
      : chatMessage;
    const result = await runtime.service.chat({
      token,
      userId,
      projectId: project_id,
      sessionId: session_id,
      message: contextualMessage,
      ...(interactionResponse ? { interactionResponse } : {}),
      provider,
      model,
      ...(byokApiKey ? { byokApiKey } : {}),
      creativeLanguage: project.creative_language,
      onTurnStarted: (turn) => {
        assistantMessageId = turn.assistantMessageId;
        tracePersistence.attach(turn.assistantMessageId);
        if (!ended) {
          ensureStream();
          res.write(`data: ${JSON.stringify({
            type: "turn_started",
            session_id,
            turn_id: turn.turnId,
            assistant_message_id: turn.assistantMessageId,
          })}\n\n`);
        }
        if (interactionResponse) {
          ensureTraceStarted();
          trace.interactionResolved(
            interactionResponse.interactionId,
            interactionResponse.answers,
            interactionResponse.freeAnswer,
          );
          interactionResolutionEmitted = true;
        }
      },
      traceSink: (event) => {
        ensureTraceStarted();
        const { agentId, ...runtimeEvent } = event;
        trace.handle(agentId as TraceAgentId, runtimeEvent);
      },
    });
    if (interactionResponse && result.replayed && !interactionResolutionEmitted) {
      ensureTraceStarted();
      trace.interactionResolved(
        interactionResponse.interactionId,
        interactionResponse.answers,
        interactionResponse.freeAnswer,
      );
    }
    ensureTraceStarted();
    trace.answerFinished(result.reply);
    trace.runFinished();
    if (assistantMessageId && !await tracePersistence.flush(true)) {
      log.error(`Failed to persist final chat trace for Session ${session_id}`);
    }
    if (!ended) {
      ensureStream();
      res.write(`data: ${JSON.stringify({
        type: "turn_complete",
        session_id,
        turn_id: result.turnId,
        assistant_message_id: assistantMessageId,
      })}\n\n`);
    }
  } catch (err: any) {
    if (err instanceof SessionDomainError && !streamStarted) throw err;
    ensureTraceStarted();
    if (err instanceof SessionTurnInterruptedError) {
      trace.runInterrupted("已停止生成");
    } else {
      const clientMessage = classifyChatError(err, Boolean(byokBase));
      // The run_failed frame carries only the user-facing message, so without
      // the raw error here a misclassified failure cannot be diagnosed after
      // the fact. Secrets are redacted and the text is truncated.
      log.error(
        `Chat turn failed (run ${runId}, session ${session_id}): ${sanitizeErrorForLog(err)} | user saw: ${clientMessage}`,
      );
      trace.runFailed(clientMessage);
    }
    if (assistantMessageId && !await tracePersistence.flush(true)) {
      log.error(`Failed to persist failed chat trace for Session ${session_id}`);
    }
  } finally {
    clearInterval(keepaliveInterval);
    ended = true;
    if (streamStarted) res.end();
  }
  return;

}
