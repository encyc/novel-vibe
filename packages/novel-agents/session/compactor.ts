import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PricingQuote, Usage } from "../lib/usage-cost-types.js";
import type { AgentId, ModelDescriptor } from "./types.js";
import { SessionDomainError } from "./types.js";

export interface SequencedMessage {
  sequence: number;
  turnId: string;
  message: AgentMessage;
}

export interface CompactionWindow {
  compact: SequencedMessage[];
  retain: SequencedMessage[];
  throughSequence: number;
}

/**
 * Provider-reported assistant output tokens are preferred. Other messages use a
 * conservative fallback of one token per two serialized characters.
 */
export function estimateMessageTokens(message: AgentMessage): number {
  if (message.role === "assistant" && message.usage?.output > 0) {
    return message.usage.output;
  }
  const content: unknown = "content" in message ? message.content : message;
  const serialized = typeof content === "string"
    ? content
    : JSON.stringify(content ?? "");
  return serialized.length === 0 ? 0 : Math.max(1, Math.ceil(serialized.length / 2));
}

export function estimateTranscriptTokens(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function toolCallIds(message: AgentMessage): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part) => {
    if (typeof part === "object" && part !== null && part.type === "toolCall" && typeof part.id === "string") {
      return [part.id];
    }
    return [];
  });
}

function boundaryIsAtomic(messages: SequencedMessage[], cut: number): boolean {
  const compact = messages.slice(0, cut);
  const retain = messages.slice(cut);
  const compactTurns = new Set(compact.map((entry) => entry.turnId));
  if (retain.some((entry) => compactTurns.has(entry.turnId))) return false;

  const compactCalls = new Set(compact.flatMap((entry) => toolCallIds(entry.message)));
  const retainedCalls = new Set(retain.flatMap((entry) => toolCallIds(entry.message)));
  for (const entry of compact) {
    if (entry.message.role === "toolResult" && retainedCalls.has(entry.message.toolCallId)) return false;
  }
  for (const entry of retain) {
    if (entry.message.role === "toolResult" && compactCalls.has(entry.message.toolCallId)) return false;
  }
  return true;
}

export function selectCompactionWindow(
  messages: SequencedMessage[],
  contextWindow: number,
): CompactionWindow | null {
  const total = estimateTranscriptTokens(messages.map((entry) => entry.message));
  if (total < contextWindow * 0.7 || messages.length < 2) return null;

  const retainTarget = contextWindow * 0.25;
  let retainedTokens = 0;
  for (let cut = messages.length - 1; cut > 0; cut -= 1) {
    retainedTokens += estimateMessageTokens(messages[cut].message);
    if (retainedTokens < retainTarget || !boundaryIsAtomic(messages, cut)) continue;
    const compact = messages.slice(0, cut);
    const retain = messages.slice(cut);
    const last = compact.at(-1);
    if (!last) return null;
    return { compact, retain, throughSequence: last.sequence };
  }
  return null;
}

export interface CompactionRepository {
  saveAgentSummary(
    sessionId: string,
    agentId: AgentId,
    summary: string,
    throughSequence: number,
  ): Promise<void>;
}

export interface CompactionBilling {
  createPricingQuote(params: {
    userId: string;
    modelId: string;
    modelProvider: string;
    requestStartedAt: Date;
  }): Promise<PricingQuote>;
  recordCompactionUsage(params: {
    userId: string;
    projectId: string;
    sessionId: string;
    modelId: string;
    modelProvider: string;
    quote: PricingQuote;
    usage: Usage;
  }): Promise<void>;
}

export interface SummaryGenerator {
  (input: {
    model: ModelDescriptor;
    prompt: string;
    messages: AgentMessage[];
  }): Promise<{ summary: string; usage: Usage }>;
}

interface SessionCompactorOptions {
  repository: CompactionRepository;
  billing: CompactionBilling;
  generate: SummaryGenerator;
  now?: () => Date;
}

interface CompactIfNeededInput {
  sessionId: string;
  projectId: string;
  userId: string;
  agentId: AgentId;
  model: ModelDescriptor;
  messages: SequencedMessage[];
}

export type CompactionResult =
  | { status: "unchanged"; messages: SequencedMessage[] }
  | { status: "degraded"; messages: SequencedMessage[] }
  | { status: "compacted"; messages: SequencedMessage[]; summary: string; throughSequence: number };

const SUMMARY_INSTRUCTIONS = `请将以下历史压缩为可供小说创作 Agent 继续工作的结构化中文摘要。
必须分别保留：
1. 已确认决定
2. 未解决问题
3. 人物与世界观约束
4. 活跃任务与下一步
5. 工具调用结果及其影响
不要补充历史中不存在的事实。`;

export class SessionCompactor {
  private readonly repository: CompactionRepository;
  private readonly billing: CompactionBilling;
  private readonly generate: SummaryGenerator;
  private readonly now: () => Date;

  constructor(options: SessionCompactorOptions) {
    this.repository = options.repository;
    this.billing = options.billing;
    this.generate = options.generate;
    this.now = options.now ?? (() => new Date());
  }

  async compactIfNeeded(input: CompactIfNeededInput): Promise<CompactionResult> {
    const totalTokens = estimateTranscriptTokens(input.messages.map((entry) => entry.message));
    const selected = selectCompactionWindow(input.messages, input.model.contextWindow);
    if (!selected) {
      if (totalTokens >= input.model.contextWindow * 0.9) {
        throw new SessionDomainError(
          "SESSION_COMPACTION_REQUIRED",
          "Session context requires compaction but has no safe atomic boundary",
          503,
        );
      }
      return { status: "unchanged", messages: input.messages };
    }

    try {
      const quote = await this.billing.createPricingQuote({
        userId: input.userId,
        modelId: input.model.model,
        modelProvider: input.model.provider,
        requestStartedAt: this.now(),
      });
      const generated = await this.generate({
        model: input.model,
        prompt: SUMMARY_INSTRUCTIONS,
        messages: selected.compact.map((entry) => entry.message),
      });
      if (!generated.summary.trim()) throw new Error("Compaction returned an empty summary");
      await this.billing.recordCompactionUsage({
        userId: input.userId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        modelId: input.model.model,
        modelProvider: input.model.provider,
        quote,
        usage: generated.usage,
      });
      await this.repository.saveAgentSummary(
        input.sessionId,
        input.agentId,
        generated.summary,
        selected.throughSequence,
      );
      return {
        status: "compacted",
        messages: selected.retain,
        summary: generated.summary,
        throughSequence: selected.throughSequence,
      };
    } catch (error) {
      if (totalTokens >= input.model.contextWindow * 0.9) {
        const detail = error instanceof Error ? `: ${error.message}` : "";
        throw new SessionDomainError(
          "SESSION_COMPACTION_REQUIRED",
          `Session context requires compaction before continuing${detail}`,
          503,
        );
      }
      return { status: "degraded", messages: input.messages };
    }
  }
}
