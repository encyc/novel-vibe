import { describe, expect, it, vi } from "vitest";
import { ContinuityWorker, type ContinuityJob } from "./worker.js";

function job(overrides: Partial<ContinuityJob> = {}): ContinuityJob {
  return {
    id: "job-1",
    project_id: "project-1",
    chapter_number: 3,
    chapter_path: "text/ch-003.md",
    confirmed_hash: "hash-3",
    attempts: 1,
    ...overrides,
  };
}

describe("ContinuityWorker", () => {
  it("completes a claimed job after extraction succeeds", async () => {
    const repository = {
      claimContinuityJobs: vi.fn().mockResolvedValue([job()]),
      completeContinuityJob: vi.fn().mockResolvedValue(undefined),
      retryContinuityJob: vi.fn(),
      failContinuityJob: vi.fn(),
    };
    const execute = vi.fn().mockResolvedValue(undefined);
    const worker = new ContinuityWorker({ repository, execute, batchSize: 5 });

    await worker.runOnce(new Date("2026-08-19T00:00:00.000Z"));

    expect(execute).toHaveBeenCalledWith(job());
    expect(repository.completeContinuityJob).toHaveBeenCalledWith("job-1");
    expect(repository.retryContinuityJob).not.toHaveBeenCalled();
  });

  it("retries a failed job with bounded exponential backoff", async () => {
    const repository = {
      claimContinuityJobs: vi.fn().mockResolvedValue([job({ attempts: 2 })]),
      completeContinuityJob: vi.fn(),
      retryContinuityJob: vi.fn().mockResolvedValue(undefined),
      failContinuityJob: vi.fn(),
    };
    const worker = new ContinuityWorker({
      repository,
      execute: vi.fn().mockRejectedValue(new Error("model unavailable")),
      batchSize: 5,
    });

    await worker.runOnce(new Date("2026-08-19T00:00:00.000Z"));

    expect(repository.retryContinuityJob).toHaveBeenCalledWith(
      "job-1", 2, "2026-08-19T00:01:00.000Z", "model unavailable",
    );
  });

  it("marks a job failed after the fifth claimed attempt", async () => {
    const repository = {
      claimContinuityJobs: vi.fn().mockResolvedValue([job({ attempts: 5 })]),
      completeContinuityJob: vi.fn(),
      retryContinuityJob: vi.fn(),
      failContinuityJob: vi.fn().mockResolvedValue(undefined),
    };
    const worker = new ContinuityWorker({
      repository,
      execute: vi.fn().mockRejectedValue(new Error("invalid output")),
      batchSize: 5,
    });

    await worker.runOnce(new Date("2026-08-19T00:00:00.000Z"));

    expect(repository.failContinuityJob).toHaveBeenCalledWith("job-1", "invalid output");
    expect(repository.retryContinuityJob).not.toHaveBeenCalled();
  });
});
