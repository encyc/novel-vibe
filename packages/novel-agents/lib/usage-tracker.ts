import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { TurnUsageBilling } from "./policy-ports.js";
import type { PricingQuote } from "./usage-cost-types.js";

interface TrackableAgent {
  state: { model: { id: string; provider: string } };
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
}

export function attachUsageTracker(options: {
  agent: TrackableAgent;
  billing: TurnUsageBilling;
  userId: string;
  projectId: string;
  sessionId: () => string | undefined;
  agentId: string;
  /** When true for a turn, usage is the user's own BYOK key: audit-only, no quote, no charge. */
  isByokTurn?: () => boolean;
  now?: () => Date;
}): void {
  let pendingQuote: PricingQuote | null = null;
  let pendingByok = false;
  /** A turn the billing implementation declined to quote (local mode): nothing to settle. */
  let pendingUnbilled = false;
  const now = options.now ?? (() => new Date());

  options.agent.subscribe(async (event) => {
    if (event.type === "turn_start") {
      if (pendingQuote || pendingUnbilled) throw new Error(`Unconsumed pricing quote for ${options.agentId}`);
      if (pendingByok) throw new Error(`Unconsumed byok usage for ${options.agentId}`);
      if (options.isByokTurn?.()) {
        pendingByok = true;
        return;
      }
      const model = options.agent.state.model;
      const quote = await options.billing.createPricingQuote({
        userId: options.userId,
        modelId: model.id,
        modelProvider: model.provider,
        requestStartedAt: now(),
      });
      if (quote === null) {
        pendingUnbilled = true;
        return;
      }
      pendingQuote = quote;
      return;
    }

    if (event.type !== "message_end") return;
    const message = event.message as any;
    if (message?.role !== "assistant" || !message.usage || message.usage.totalTokens <= 0) return;
    if (pendingUnbilled) {
      pendingUnbilled = false;
      return;
    }
    if (pendingByok) {
      pendingByok = false;
      await options.billing.recordByokUsage({
        userId: options.userId,
        projectId: options.projectId,
        sessionId: options.sessionId(),
        agentId: options.agentId,
        modelId: message.model ?? "",
        modelProvider: message.provider ?? "",
        usage: message.usage,
      });
      return;
    }
    if (!pendingQuote) throw new Error(`Missing pricing quote for ${options.agentId}`);
    const quote = pendingQuote;
    pendingQuote = null;
    await options.billing.recordAndChargeQuotedUsage({
      userId: options.userId,
      projectId: options.projectId,
      sessionId: options.sessionId(),
      agentId: options.agentId,
      modelId: message.model ?? "",
      modelProvider: message.provider ?? "",
      quote,
      usage: message.usage,
    });
  });
}
