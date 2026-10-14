export type ProjectDeletionStage = "pending" | "excluding_memory" | "deleting_storage" | "deleting_database";

export interface ProjectDeletionJob {
  id: string;
  project_id: string;
  requested_by: string | null;
  stage: ProjectDeletionStage;
  resume_stage: ProjectDeletionStage | null;
  attempts: number;
}

export interface ProjectDeletionStore {
  claimDeletionJobs(now: string, limit: number): Promise<ProjectDeletionJob[]>;
  freezeProject(jobId: string, projectId: string): Promise<void>;
  listProjectSessionIds(projectId: string): Promise<string[]>;
  addMemoryExclusions(projectId: string, rows: Array<{ sessionId: string; memoryId: string }>): Promise<void>;
  advanceDeletionJob(jobId: string, stage: ProjectDeletionStage): Promise<void>;
  retryDeletionJob(jobId: string, stage: ProjectDeletionStage, attempts: number, nextAttemptAt: string, error: string): Promise<void>;
  purgeProjectDatabase(jobId: string, projectId: string): Promise<void>;
}

interface Options {
  repository: ProjectDeletionStore;
  memory: { enumerateSessionMemoryIds(projectId: string, sessionId: string, requestedBy: string | null): Promise<string[]> };
  storage: { deletePrefix(prefix: string): Promise<void> };
  batchSize: number;
  now?: () => Date;
}

export class ProjectDeletionWorker {
  constructor(private readonly options: Options) {}

  async runOnce(): Promise<void> {
    const now = (this.options.now ?? (() => new Date()))();
    const jobs = await this.options.repository.claimDeletionJobs(now.toISOString(), this.options.batchSize);
    for (const job of jobs) {
      try {
        await this.runStage(job);
      } catch (error) {
        const attempts = job.attempts;
        const delayMs = Math.min(3_600_000, 30_000 * (2 ** Math.max(0, attempts - 1)));
        const nextAttemptAt = new Date(now.getTime() + delayMs).toISOString();
        await this.options.repository.retryDeletionJob(
          job.id, job.stage, attempts, nextAttemptAt,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private async runStage(job: ProjectDeletionJob): Promise<void> {
    if (job.stage === "pending") {
      await this.options.repository.freezeProject(job.id, job.project_id);
      await this.options.repository.advanceDeletionJob(job.id, "excluding_memory");
      return;
    }
    if (job.stage === "excluding_memory") {
      const sessionIds = await this.options.repository.listProjectSessionIds(job.project_id);
      const rows: Array<{ sessionId: string; memoryId: string }> = [];
      for (const sessionId of sessionIds) {
        const ids = await this.options.memory.enumerateSessionMemoryIds(job.project_id, sessionId, job.requested_by);
        rows.push(...ids.map((memoryId) => ({ sessionId, memoryId })));
      }
      await this.options.repository.addMemoryExclusions(job.project_id, rows);
      await this.options.repository.advanceDeletionJob(job.id, "deleting_storage");
      return;
    }
    if (job.stage === "deleting_storage") {
      await this.options.storage.deletePrefix(`${job.project_id}/`);
      await this.options.repository.advanceDeletionJob(job.id, "deleting_database");
      return;
    }
    await this.options.repository.purgeProjectDatabase(job.id, job.project_id);
  }
}

export function startProjectDeletionWorker(worker: ProjectDeletionWorker, intervalMs = 5_000): () => Promise<void> {
  let stopped = false;
  let inFlight = Promise.resolve();
  const trigger = () => {
    if (!stopped) inFlight = inFlight.then(() => worker.runOnce()).catch(() => undefined);
  };
  const initial = setTimeout(trigger, 0);
  const interval = setInterval(trigger, intervalMs);
  return async () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
    await inFlight;
  };
}
