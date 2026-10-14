import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentId, ModelDescriptor } from "../session/types.js";
import { estimateTranscriptTokens } from "../session/compactor.js";
import type { SequencedMessage } from "../session/compactor.js";
import { PromptBuilder } from "./prompt-builder.js";
import type { SupportedLanguage } from "../lib/language.js";
import { MessageRestorer } from "./message-restorer.js";
import { ContextCompactor } from "./compactor.js";
import type {
  CompleteContext,
  ContextManagerConfig,
  ContextObserver,
} from "./types.js";

export type { CompleteContext, ContextManagerConfig, ContextObserver } from "./types.js";
export { PromptBuilder } from "./prompt-builder.js";
export { MessageRestorer } from "./message-restorer.js";
export { ContextCompactor } from "./compactor.js";

const SUMMARY_PREFIXES = ["[SESSION_SUMMARY]\n", "[会话摘要]\n"] as const;
const isSummaryMessage = (content: string): boolean =>
  SUMMARY_PREFIXES.some((prefix) => content.startsWith(prefix));

export class ContextManager {
  readonly prompt: PromptBuilder;
  readonly restorer: MessageRestorer;
  readonly compactor: ContextCompactor;
  private modelDescriptors: Partial<Record<AgentId, ModelDescriptor>>;
  private readonly observer?: ContextObserver;
  private projectId: string;
  private userId: string | undefined;
  /** Per-agent known message sequences, updated after restoreEntry for asCallback. */
  private knownMessages: Partial<Record<AgentId, SequencedMessage[]>> = {};

  constructor(config: ContextManagerConfig) {
    this.modelDescriptors = config.modelDescriptors;
    this.observer = config.observer;
    this.projectId = config.projectId;
    this.userId = config.userId;

    this.prompt = new PromptBuilder({
      promptLoader: config.promptLoader,
      skillLoader: config.skillLoader,
      instructionLoader: config.instructionLoader,
      token: config.token,
      projectId: config.projectId,
      userId: config.userId,
      creativeLanguage: config.creativeLanguage,
    });

    this.restorer = new MessageRestorer(config.repository);

    this.compactor = new ContextCompactor({
      repository: config.repository,
      billing: config.billing,
      generate: config.summaryGenerator,
      strategy: config.strategy,
      observer: config.observer,
      creativeLanguage: config.creativeLanguage,
    });
  }

  // ── Mutable state setters (called by orchestrator/server at init time) ──

  setProjectId(projectId: string): void { this.projectId = projectId; }
  setUserId(userId: string): void { this.userId = userId; }
  setCreativeLanguage(language: SupportedLanguage): void {
    this.prompt.setCreativeLanguage(language);
    this.compactor.setCreativeLanguage(language);
  }
  setModelDescriptors(descriptors: Partial<Record<AgentId, ModelDescriptor>>): void {
    this.modelDescriptors = descriptors;
  }

  setKnownMessages(agentId: AgentId, messages: SequencedMessage[]): void {
    this.knownMessages[agentId] = messages;
  }

  getModelDescriptor(agentId: AgentId): ModelDescriptor {
    const descriptor = this.modelDescriptors[agentId];
    if (!descriptor) throw new Error(`Model descriptor not found for agent: ${agentId}`);
    return descriptor;
  }

  /** Build complete pre-turn context for an agent. */
  async buildContext(
    agentId: AgentId,
    sessionId: string,
    _opts?: { forceCompact?: boolean },
  ): Promise<CompleteContext> {
    const model = this.getModelDescriptor(agentId);
    const [systemPrompt, restored] = await Promise.all([
      this.prompt.build(agentId),
      this.restorer.restore(agentId, sessionId, model),
    ]);

    const estimatedTokens = estimateTranscriptTokens(restored.messages);
    const utilization = estimatedTokens / model.contextWindow;

    // Share known sequences so asCallback can track mid-turn compaction
    this.knownMessages[agentId] = restored.sequenced;

    const ctx: CompleteContext = {
      systemPrompt,
      messages: restored.messages,
      contextWindow: model.contextWindow,
      estimatedTokens,
      utilization: Math.min(utilization, 1),
      summaryInjected: restored.summary !== null,
      compactionStatus: "none",
    };

    this.observer?.onBuilt?.(ctx);
    return ctx;
  }

  /**
   * Return a transformContext-compatible callback for the Agent framework.
   * Handles mid-turn compaction: maps messages to sequences, checks window,
   * compacts if needed, and prepends summary.
   */
  asCallback(
    agentId: AgentId,
    sessionId: string,
  ): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
    const model = this.getModelDescriptor(agentId);
    return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
      const known = this.knownMessages[agentId] ?? [];
      const maxSequence = known.at(-1)?.sequence ?? 0;
      let syntheticOffset = 0;
      const sequenced = messages
        .filter((message) => !(
          message.role === "user"
          && typeof message.content === "string"
          && isSummaryMessage(message.content)
        ))
        .map((message) => {
          const stored = known.find((entry) => entry.message === message);
          if (stored) return stored;
          syntheticOffset += 1;
          return {
            sequence: maxSequence + syntheticOffset,
            turnId: "",
            message,
          };
        });

      const result = await this.compactor.compact({
        sessionId,
        projectId: this.projectId,
        userId: this.userId ?? "",
        agentId,
        model,
        messages: sequenced,
      });

      if (result.status !== "compacted") return messages;

      // Update known sequences for subsequent calls
      this.knownMessages[agentId] = result.messages;

      return [
        { role: "user", content: `[SESSION_SUMMARY]\n${result.summary}`, timestamp: 0 },
        ...result.messages.map((entry) => entry.message),
      ];
    };
  }

  /** Compact a pre-restored message set (used for Chief Editor pre-chat compaction). */
  async compactMessages(
    input: {
      sessionId: string;
      agentId: AgentId;
      messages: SequencedMessage[];
    },
  ): Promise<{
    status: "unchanged" | "degraded" | "compacted";
    messages: AgentMessage[];
    sequenced: SequencedMessage[];
    summary?: string;
  }> {
    const model = this.getModelDescriptor(input.agentId);
    const result = await this.compactor.compact({
      sessionId: input.sessionId,
      projectId: this.projectId,
      userId: this.userId ?? "",
      agentId: input.agentId,
      model,
      messages: input.messages,
    });

    if (result.status === "compacted") {
      this.knownMessages[input.agentId] = result.messages;
      return {
        status: "compacted",
        messages: [
          { role: "user", content: `[SESSION_SUMMARY]\n${result.summary}`, timestamp: 0 },
          ...result.messages.map((entry) => entry.message),
        ],
        sequenced: result.messages,
        summary: result.summary,
      };
    }

    return {
      status: result.status,
      messages: input.messages.map((entry) => entry.message),
      sequenced: input.messages,
    };
  }
}
