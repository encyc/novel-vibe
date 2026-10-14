import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentId, ModelDescriptor } from "../session/types.js";
import type { SequencedMessage } from "../session/compactor.js";
import type { ContextRepository } from "./types.js";

export interface RestoreResult {
  sequenced: SequencedMessage[];
  messages: AgentMessage[];
  summary: string | null;
}

export class MessageRestorer {
  constructor(private readonly repository: ContextRepository) {}

  /** Load agent messages from DB and prepend summary if it exists. */
  async restore(
    agentId: AgentId,
    sessionId: string,
    model: ModelDescriptor,
  ): Promise<RestoreResult> {
    const context = await this.repository.loadAgentContext(sessionId, agentId, model);
    const sequenced = context.messages.map((stored) => ({
      sequence: stored.sequence,
      turnId: stored.turnId,
      message: stored.message,
    }));
    const messages: AgentMessage[] = [
      ...(context.summary
        ? [{ role: "user" as const, content: `[SESSION_SUMMARY]\n${context.summary}`, timestamp: 0 }]
        : []),
      ...sequenced.map((stored) => stored.message),
    ];
    return { sequenced, messages, summary: context.summary };
  }
}
