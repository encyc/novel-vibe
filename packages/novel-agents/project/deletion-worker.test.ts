import { describe, expect, it, vi } from "vitest";
import { ProjectDeletionWorker, type ProjectDeletionJob } from "./deletion-worker.js";

function job(stage: ProjectDeletionJob["stage"], attempts = 1): ProjectDeletionJob {
  return { id: "job-1", project_id: "project-1", requested_by: "user-1", stage, resume_stage: null, attempts };
}

function harness(current: ProjectDeletionJob) {
  const repository = {
    claimDeletionJobs: vi.fn().mockResolvedValue([current]),
    freezeProject: vi.fn().mockResolvedValue(undefined),
    listProjectSessionIds: vi.fn().mockResolvedValue(["session-1"]),
    addMemoryExclusions: vi.fn().mockResolvedValue(undefined),
    advanceDeletionJob: vi.fn().mockResolvedValue(undefined),
    retryDeletionJob: vi.fn().mockResolvedValue(undefined),
    purgeProjectDatabase: vi.fn().mockResolvedValue(undefined),
  };
  const memory = { enumerateSessionMemoryIds: vi.fn().mockResolvedValue(["memory-1"]) };
  const storage = { deletePrefix: vi.fn().mockResolvedValue(undefined) };
  return { repository, memory, storage, worker: new ProjectDeletionWorker({ repository, memory, storage, batchSize: 5 }) };
}

describe("ProjectDeletionWorker", () => {
  it.each([
    ["pending", "freezeProject", "excluding_memory"],
    ["excluding_memory", "addMemoryExclusions", "deleting_storage"],
    ["deleting_storage", "deletePrefix", "deleting_database"],
    ["deleting_database", "purgeProjectDatabase", null],
  ] as const)("resumes durably from %s", async (stage, operation, next) => {
    const h = harness(job(stage));
    await h.worker.runOnce();
    const target = operation === "deletePrefix" ? h.storage : operation === "addMemoryExclusions" ? h.repository : h.repository;
    expect(target[operation]).toHaveBeenCalled();
    if (next) expect(h.repository.advanceDeletionJob).toHaveBeenCalledWith("job-1", next);
  });

  it("accepts a successful empty memory enumeration", async () => {
    const h = harness(job("excluding_memory"));
    h.repository.listProjectSessionIds.mockResolvedValue([]);
    await h.worker.runOnce();
    expect(h.repository.addMemoryExclusions).toHaveBeenCalledWith("project-1", []);
    expect(h.repository.advanceDeletionJob).toHaveBeenCalledWith("job-1", "deleting_storage");
  });

  it("retries the same stage with exponential backoff and never cascades early", async () => {
    const h = harness(job("deleting_storage", 3));
    h.storage.deletePrefix.mockRejectedValue(new Error("S3 unavailable"));
    await h.worker.runOnce();
    expect(h.repository.retryDeletionJob).toHaveBeenCalledWith("job-1", "deleting_storage", 3, expect.any(String), "S3 unavailable");
    expect(h.repository.purgeProjectDatabase).not.toHaveBeenCalled();
  });

  it("does not advance when memory enumeration is indeterminate", async () => {
    const h = harness(job("excluding_memory"));
    h.memory.enumerateSessionMemoryIds.mockRejectedValue(new Error("indeterminate"));
    await h.worker.runOnce();
    expect(h.repository.retryDeletionJob).toHaveBeenCalled();
    expect(h.repository.advanceDeletionJob).not.toHaveBeenCalled();
    expect(h.storage.deletePrefix).not.toHaveBeenCalled();
  });
});
