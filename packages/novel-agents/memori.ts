/**
 * Compatibility facade for callers that have not moved to SessionService yet.
 * Durable session code owns the real exclusion store and memory job repository.
 */
import { randomUUID } from "node:crypto";
import { Memori as MemoriClass } from "@memorilabs/memori";
import { OpenClawIntegration } from "@memorilabs/memori/integrations";
import {
  formatRecallContext,
  ProjectMemoryAdapter,
  type MemoryExclusionStore,
  type MemoryIntegration,
} from "./session/memory-adapter.js";
import type { MemoryJobRow } from "./session/types.js";

export class ProjectMemory {
  private readonly adapter: ProjectMemoryAdapter;
  private currentSessionId: string;
  private readonly projectId: string;

  constructor(userId: string, projectId: string, sessionId: string) {
    this.currentSessionId = sessionId;
    this.projectId = projectId;
    if (!MemoriClass) throw new Error("Memori SDK not available");

    this.adapter = createProjectMemoryAdapter(
      userId,
      projectId,
      sessionId,
      { listMemoryExclusionIds: async () => [] },
    );
  }

  setSession(sessionId: string): void {
    this.currentSessionId = sessionId;
    this.adapter.setSession(sessionId);
  }

  async recallContext(query: string): Promise<string> {
    return formatRecallContext(await this.adapter.recall(query));
  }

  async captureTurn(userMessage: string, assistantResponse: string): Promise<void> {
    const now = new Date().toISOString();
    const row: MemoryJobRow = {
      id: randomUUID(),
      session_id: this.currentSessionId,
      project_id: this.projectId,
      turn_id: randomUUID(),
      operation: "capture",
      payload: { userMessage, assistantResponse },
      status: "running",
      attempts: 0,
      next_attempt_at: now,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    await this.adapter.capture(row);
  }
}

export function isMemoriAvailable(): boolean {
  return true;
}

export function createProjectMemoryAdapter(
  userId: string,
  projectId: string,
  sessionId: string,
  exclusions: MemoryExclusionStore,
): ProjectMemoryAdapter {
  const integration = new MemoriClass()
    .integrate(OpenClawIntegration)
    .attribution(`user:${userId}:${projectId}`, "novel")
    .scope(sessionId, projectId) as unknown as MemoryIntegration;
  return new ProjectMemoryAdapter({
    projectId,
    sessionId,
    integration,
    exclusions,
  });
}
