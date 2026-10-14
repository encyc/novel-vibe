import type { AgentId, ModelDescriptor } from "../session/types.js";
import {
  estimateTranscriptTokens,
  selectCompactionWindow,
  type CompactionResult,
  type SequencedMessage,
} from "../session/compactor.js";
import { SessionDomainError } from "../session/types.js";
import type {
  CompactionBilling,
  CompactionStrategy,
  ContextObserver,
  SummaryGenerator,
} from "./types.js";
import { DEFAULT_COMPACTION_STRATEGY } from "./types.js";
import type { SupportedLanguage } from "../lib/language.js";
import { renderLanguageContext } from "./prompt-builder.js";

export class ContextCompactor {
  private readonly repository: {
    saveAgentSummary(
      sessionId: string,
      agentId: AgentId,
      summary: string,
      throughSequence: number,
    ): Promise<void>;
  };
  private readonly billing: CompactionBilling;
  private readonly generate: SummaryGenerator;
  private readonly strategy: CompactionStrategy;
  private readonly observer?: ContextObserver;
  private creativeLanguage: SupportedLanguage;
  private readonly now: () => Date;

  constructor(opts: {
    repository: ContextCompactor["repository"];
    billing: CompactionBilling;
    generate: SummaryGenerator;
    strategy?: Partial<CompactionStrategy>;
    observer?: ContextObserver;
    creativeLanguage: SupportedLanguage;
    now?: () => Date;
  }) {
    this.repository = opts.repository;
    this.billing = opts.billing;
    this.generate = opts.generate;
    this.strategy = { ...DEFAULT_COMPACTION_STRATEGY, ...opts.strategy };
    this.observer = opts.observer;
    this.creativeLanguage = opts.creativeLanguage;
    this.now = opts.now ?? (() => new Date());
  }

  setCreativeLanguage(language: SupportedLanguage): void {
    this.creativeLanguage = language;
  }

  async compact(input: {
    sessionId: string;
    projectId: string;
    userId: string;
    agentId: AgentId;
    model: ModelDescriptor;
    messages: SequencedMessage[];
  }): Promise<CompactionResult> {
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
      const summaryLanguageInstruction = this.creativeLanguage === "en"
        ? "Write the summary in English."
        : "请使用简体中文撰写摘要。";
      const generated = await this.generate({
        model: input.model,
        prompt: `${this.strategy.summaryPrompt}\n\n${summaryLanguageInstruction}\n\n${renderLanguageContext(this.creativeLanguage)}`,
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
      this.observer?.onCompacted?.(input.agentId, generated.summary, selected.throughSequence);
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
      this.observer?.onCompactionFailed?.(
        input.agentId,
        error instanceof Error ? error : new Error(String(error)),
      );
      return { status: "degraded", messages: input.messages };
    }
  }
}
