export interface ContinuityJob {
  id: string;
  project_id: string;
  chapter_number: number;
  chapter_path: string;
  confirmed_hash: string;
  attempts: number;
}

interface ContinuityRepository {
  claimContinuityJobs(now: string, limit: number): Promise<ContinuityJob[]>;
  completeContinuityJob(jobId: string): Promise<void>;
  retryContinuityJob(jobId: string, attempts: number, nextAttemptAt: string, error: string): Promise<void>;
  failContinuityJob(jobId: string, error: string): Promise<void>;
}

export class ContinuityWorker {
  constructor(private readonly options: {
    repository: ContinuityRepository;
    execute(job: ContinuityJob): Promise<void>;
    batchSize: number;
  }) {}

  async runOnce(now = new Date()): Promise<void> {
    const jobs = await this.options.repository.claimContinuityJobs(now.toISOString(), this.options.batchSize);
    for (const job of jobs) {
      try {
        await this.options.execute(job);
        await this.options.repository.completeContinuityJob(job.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (job.attempts >= 5) {
          await this.options.repository.failContinuityJob(job.id, message);
          continue;
        }
        const delayMs = Math.min(3_600_000, 30_000 * (2 ** Math.max(0, job.attempts - 1)));
        await this.options.repository.retryContinuityJob(
          job.id,
          job.attempts,
          new Date(now.getTime() + delayMs).toISOString(),
          message,
        );
      }
    }
  }
}

export function startContinuityWorker(worker: ContinuityWorker, intervalMs = 5_000): () => Promise<void> {
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
