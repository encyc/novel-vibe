import type { AgentId, SessionMessage } from "../types";

interface ReviewChange {
  versionId: string;
  path: string;
  versionNo: number;
  agentId: AgentId;
  addedLines: number;
  deletedLines: number;
  changedSections: string[];
}

export interface ReviewChangeGroup {
  turnId: string;
  /** The user request that produced this run, truncated for list display. */
  prompt: string;
  createdAt: string;
  status: SessionMessage["status"];
  changes: ReviewChange[];
}

const PROMPT_PREVIEW_LENGTH = 48;

function promptPreview(text: string) {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed.length > PROMPT_PREVIEW_LENGTH
    ? `${collapsed.slice(0, PROMPT_PREVIEW_LENGTH)}…`
    : collapsed;
}

/**
 * Folds a session transcript into per-turn document change groups (newest
 * turn first). Reads only persisted traces, so the review page always shows
 * changes that survived a restart; in-flight runs appear once the run settles.
 */
export function deriveReviewGroups(messages: SessionMessage[]): ReviewChangeGroup[] {
  const groups: ReviewChangeGroup[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !message.trace) continue;
    const changes = message.trace.steps
      .filter((step): step is Extract<typeof step, { type: "document_change" }> => step.type === "document_change")
      .map((step) => ({
        versionId: step.versionId,
        path: step.path,
        versionNo: step.versionNo,
        agentId: step.agentId,
        addedLines: step.addedLines,
        deletedLines: step.deletedLines,
        changedSections: step.changedSections,
      }));
    if (!changes.length) continue;
    const userMessage = messages.find((candidate) =>
      candidate.turnId === message.turnId && candidate.role === "user");
    groups.push({
      turnId: message.turnId,
      prompt: userMessage ? promptPreview(userMessage.text) : "",
      createdAt: message.createdAt,
      status: message.status,
      changes,
    });
  }
  return groups.reverse();
}
