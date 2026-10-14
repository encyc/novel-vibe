import type { MemoryJobRow, MemoryStatus } from "./types.js";
import { SessionDomainError } from "./types.js";

export interface MemoryIntegration {
  scope(sessionId: string, projectId: string): MemoryIntegration;
  agentRecall(params: { projectId: string; sessionId?: string }): Promise<unknown>;
  augmentation(request: {
    userMessage: { role: "user"; content: string; type: "text" };
    agentResponse: { role: "assistant"; content: string; type: "text" };
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

export interface MemoryExclusionStore {
  listMemoryExclusionIds(projectId: string): Promise<string[]>;
}

export interface MemoryJobStore {
  claimMemoryJobs(now: string, limit: number): Promise<MemoryJobRow[]>;
  completeMemoryJob(jobId: string): Promise<void>;
  retryMemoryJob(jobId: string, attempts: number, nextAttemptAt: string, error: string): Promise<void>;
}

export interface RecalledMemory {
  id: string;
  content: string;
  score: number;
  context?: string;
}

export interface RecallResult {
  status: MemoryStatus;
  memories: RecalledMemory[];
}

interface ProjectMemoryAdapterOptions {
  projectId: string;
  sessionId: string;
  integration: MemoryIntegration;
  exclusions: MemoryExclusionStore;
}

const RESULT_KEYS = ["facts", "results", "memories", "data"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultItems(value: unknown): unknown[] | null {
  if (!isRecord(value)) return null;
  for (const key of RESULT_KEYS) {
    if (Array.isArray(value[key])) return value[key];
  }
  return null;
}

function normalizeMemory(value: unknown): RecalledMemory | null {
  if (!isRecord(value) || value.id === undefined || typeof value.content !== "string") return null;
  const rawScore = value.score ?? value.rank_score ?? value.similarity ?? 0;
  const score = typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : 0;
  return {
    id: String(value.id),
    content: value.content,
    score,
    ...(typeof value.context === "string" ? { context: value.context } : {}),
  };
}

function memoryDeleteUnavailable(cause?: unknown): SessionDomainError {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return new SessionDomainError(
    "MEMORY_DELETE_UNAVAILABLE",
    `Unable to establish memory exclusions${detail}`,
    503,
  );
}

export class ProjectMemoryAdapter {
  private readonly projectId: string;
  private currentSessionId: string;
  private readonly integration: MemoryIntegration;
  private readonly exclusions: MemoryExclusionStore;

  constructor(options: ProjectMemoryAdapterOptions) {
    this.projectId = options.projectId;
    this.currentSessionId = options.sessionId;
    this.integration = options.integration;
    this.exclusions = options.exclusions;
    this.integration.scope(options.sessionId, options.projectId);
  }

  setSession(sessionId: string): void {
    this.currentSessionId = sessionId;
    this.integration.scope(sessionId, this.projectId);
  }

  async recall(_query: string): Promise<RecallResult> {
    try {
      const [raw, excludedIds] = await Promise.all([
        this.integration.agentRecall({ projectId: this.projectId }),
        this.exclusions.listMemoryExclusionIds(this.projectId),
      ]);
      const items = resultItems(raw);
      if (items === null) return { memories: [], status: "degraded" };
      const excluded = new Set(excludedIds);
      const memories = items
        .map(normalizeMemory)
        .filter((memory): memory is RecalledMemory => memory !== null)
        .filter((memory) => memory.score > 0.4 && !excluded.has(memory.id))
        .slice(0, 10);
      return { memories, status: "healthy" };
    } catch {
      return { memories: [], status: "degraded" };
    }
  }

  async capture(job: MemoryJobRow): Promise<MemoryStatus> {
    try {
      if (job.project_id !== this.projectId) return "degraded";
      const userMessage = job.payload.userMessage;
      const assistantResponse = job.payload.assistantResponse;
      if (typeof userMessage !== "string" || typeof assistantResponse !== "string") {
        return "degraded";
      }
      this.currentSessionId = job.session_id;
      this.integration.scope(job.session_id, job.project_id);
      await this.integration.augmentation({
        userMessage: { role: "user", content: userMessage, type: "text" },
        agentResponse: { role: "assistant", content: assistantResponse, type: "text" },
        metadata: {
          provider: "novel-vibe",
          model: null,
          sdkVersion: null,
          integrationSdkVersion: "novel-vibe",
          platform: "novel-vibe",
        },
      });
      return "healthy";
    } catch {
      return "degraded";
    }
  }

  async enumerateSessionMemoryIds(sessionId: string): Promise<string[]> {
    try {
      const raw = await this.integration.agentRecall({ projectId: this.projectId, sessionId });
      const items = resultItems(raw);
      if (items === null) throw memoryDeleteUnavailable();
      const ids = items.flatMap((item) => {
        if (!isRecord(item) || item.id === undefined) return [];
        return [String(item.id)];
      });
      if (ids.length !== items.length) throw memoryDeleteUnavailable();
      return [...new Set(ids)];
    } catch (error) {
      if (error instanceof SessionDomainError) throw error;
      throw memoryDeleteUnavailable(error);
    }
  }
}

export function formatRecallContext(result: RecallResult): string {
  return result.memories.map((memory) => {
    const escapeAttribute = (value: string) => value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    const context = memory.context
      ? ` context="${escapeAttribute(memory.context)}"`
      : "";
    return `<memory id="${escapeAttribute(memory.id)}"${context}>${memory.content}</memory>`;
  }).join("\n");
}

interface MemoryJobWorkerOptions {
  repository: MemoryJobStore;
  adapter: Pick<ProjectMemoryAdapter, "capture">;
  intervalMs: number;
  batchSize: number;
}

export function startMemoryJobWorker(options: MemoryJobWorkerOptions): () => Promise<void> {
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const run = async (): Promise<void> => {
    if (stopped) return;
    const jobs = await options.repository.claimMemoryJobs(new Date().toISOString(), options.batchSize);
    for (const job of jobs) {
      const status = await options.adapter.capture(job);
      if (status === "healthy") {
        await options.repository.completeMemoryJob(job.id);
        continue;
      }
      const attempts = job.attempts + 1;
      const delaySeconds = Math.min(3600, (2 ** job.attempts) * 30);
      const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
      await options.repository.retryMemoryJob(
        job.id,
        attempts,
        nextAttemptAt,
        "Memori capture degraded",
      );
    }
  };

  const trigger = (): void => {
    if (stopped) return;
    inFlight = inFlight.then(run).catch(() => undefined);
  };
  const initial = setTimeout(trigger, 0);
  const interval = setInterval(trigger, options.intervalMs);

  return async () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
    await inFlight;
  };
}
