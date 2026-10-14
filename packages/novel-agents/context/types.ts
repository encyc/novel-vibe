import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentId, ModelDescriptor, StoredAgentMessage } from "../session/types.js";
import type { PricingQuote, Usage } from "../lib/usage-cost-types.js";
import type { SupportedLanguage } from "../lib/language.js";

// ─── CompleteContext — returned by buildContext() ───────────────

export interface CompleteContext {
  systemPrompt: string;
  messages: AgentMessage[];
  contextWindow: number;
  estimatedTokens: number;
  utilization: number;           // 0-1
  summaryInjected: boolean;
  compactionStatus: "none" | "compacted" | "degraded";
}

// ─── PromptBlock — pluggable system prompt sections ───────────

export interface PromptBlock {
  name: string;
  appliesTo: (agentId: AgentId) => boolean;
  render: (agentId: AgentId) => string;
}

// ─── CompactionStrategy — configurable compaction policy ──────

export interface CompactionStrategy {
  triggerThreshold: number;   // default 0.7
  retainRatio: number;         // default 0.25
  summaryPrompt: string;
}

export const DEFAULT_COMPACTION_STRATEGY: CompactionStrategy = {
  triggerThreshold: 0.7,
  retainRatio: 0.25,
  summaryPrompt: `Compress the following history into a structured summary that lets the novel-writing Agent continue.
Preserve these sections:
1. Confirmed decisions
2. Unresolved questions
3. Character and worldbuilding constraints
4. Active tasks and next steps
5. Tool results and their consequences
Do not add facts that are absent from the history.`,
};

// ─── ContextObserver — lifecycle hooks for monitoring ──────────

export interface ContextObserver {
  onBuilt?: (ctx: CompleteContext) => void;
  onCompacted?: (agentId: AgentId, summary: string, throughSequence: number) => void;
  onCompactionFailed?: (agentId: AgentId, error: Error) => void;
}

// ─── Repository interfaces consumed by ContextManager ────────

export interface ContextRepository {
  loadAgentContext(
    sessionId: string,
    agentId: AgentId,
    model: ModelDescriptor,
  ): Promise<{ summary: string | null; messages: StoredAgentMessage[] }>;
  saveAgentSummary(
    sessionId: string,
    agentId: AgentId,
    summary: string,
    throughSequence: number,
  ): Promise<void>;
}

export interface PromptLoader {
  (agentId: AgentId): string | Promise<string>;
}

export interface SkillLoader {
  (token: string, projectId: string, userId: string | undefined, agentId: AgentId): Promise<string>;
}

export interface InstructionLoader {
  (token: string, projectId: string, userId: string | undefined, agentId: AgentId): Promise<string>;
}

export interface SummaryGenerator {
  (input: {
    model: ModelDescriptor;
    prompt: string;
    messages: AgentMessage[];
  }): Promise<{ summary: string; usage: Usage }>;
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

// ─── ContextManagerConfig — constructor dependencies ──────────

export interface ContextManagerConfig {
  token: string;
  projectId: string;
  userId?: string;
  creativeLanguage: SupportedLanguage;
  repository: ContextRepository;
  promptLoader: PromptLoader;
  skillLoader: SkillLoader;
  instructionLoader?: InstructionLoader;
  modelDescriptors: Partial<Record<AgentId, ModelDescriptor>>;
  summaryGenerator: SummaryGenerator;
  billing: CompactionBilling;
  strategy?: Partial<CompactionStrategy>;
  observer?: ContextObserver;
}
