import { describe, expect, it, vi } from "vitest";
import { sha256Content } from "../lib/storage.js";
import {
  DocumentVersionRepairWorker,
  startDocumentVersionRepairWorker,
  type DocumentVersionRepairWorkerOptions,
} from "./repair-worker.js";

const before = "# 第一章\n旧稿";
const after = "# 第一章\n新稿";
const row = {
  id: "v1",
  projectId: "p1",
  path: "text/001.md",
  beforeHash: sha256Content(before),
  afterHash: sha256Content(after),
  beforeSnapshotPath: ".versions/text/001.md/before.md",
  afterSnapshotPath: ".versions/text/001.md/after.md",
  leaseId: "lease-2",
};

function setup(head: string | Error | null) {
  const repository = {
    claimRepairs: vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([]),
    completeWrite: vi.fn().mockResolvedValue({ versionNo: 2 }),
    failWrite: vi.fn().mockResolvedValue(undefined),
  };
  const read = vi.fn(async (path: string) => {
    if (path === row.path) {
      if (head === null) throw new Error("Storage read failed [404]: missing");
      if (head instanceof Error) throw head;
      return head;
    }
    if (path === row.beforeSnapshotPath) return before;
    if (path === row.afterSnapshotPath) return after;
    throw new Error(`unexpected ${path}`);
  });
  const logs: unknown[] = [];
  const options: DocumentVersionRepairWorkerOptions = {
    repository,
    storageForProject: () => ({ read }),
    batchSize: 10,
    logger: { info: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) },
  };
  return { worker: new DocumentVersionRepairWorker(options), repository, read, logs };
}

describe("DocumentVersionRepairWorker", () => {
  it("completes metadata when the current head equals the intended after hash", async () => {
    const { worker, repository, read } = setup(after);

    await worker.runOnce(new Date("2026-08-14T09:00:00.000Z"));

    expect(repository.completeWrite).toHaveBeenCalledWith(expect.objectContaining({
      versionId: "v1", leaseId: "lease-2",
      diff: expect.objectContaining({ status: "ready", changedSections: ["第一章"] }),
    }));
    expect(repository.failWrite).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith(row.path);
  });

  it("fails as head_not_written when the current head still equals before", async () => {
    const { worker, repository } = setup(before);
    await worker.runOnce();
    expect(repository.failWrite).toHaveBeenCalledWith("v1", "lease-2", "head_not_written");
    expect(repository.completeWrite).not.toHaveBeenCalled();
  });

  it("fails a new-document intent as head_not_written when the head is absent", async () => {
    const { worker, repository } = setup(null);
    repository.claimRepairs.mockReset();
    repository.claimRepairs.mockResolvedValue([{ ...row, beforeHash: null, beforeSnapshotPath: null }]);
    await worker.runOnce();
    expect(repository.failWrite).toHaveBeenCalledWith("v1", "lease-2", "head_not_written");
  });

  it("fails as newer_head_present when the head matches neither hash", async () => {
    const { worker, repository } = setup("# 第一章\n更新的稿件");
    await worker.runOnce();
    expect(repository.failWrite).toHaveBeenCalledWith("v1", "lease-2", "newer_head_present");
    expect(repository.completeWrite).not.toHaveBeenCalled();
  });

  it("is idempotent when a second claim returns no rows and never writes documents", async () => {
    const { worker, repository, read } = setup(after);
    await worker.runOnce();
    await worker.runOnce();
    expect(repository.completeWrite).toHaveBeenCalledTimes(1);
    expect(repository.claimRepairs).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveProperty("write");
  });

  it("does not leak snapshot content in repair logs", async () => {
    const { worker, logs } = setup(after);
    await worker.runOnce();
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(before);
    expect(serialized).not.toContain(after);
    expect(serialized).not.toContain("旧稿");
    expect(serialized).not.toContain("新稿");
  });

  it("starts immediately and stops future repair polling", async () => {
    vi.useFakeTimers();
    const runOnce = vi.fn().mockResolvedValue(undefined);
    const stop = startDocumentVersionRepairWorker({ runOnce } as unknown as DocumentVersionRepairWorker, 5_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(runOnce).toHaveBeenCalledTimes(1);
    await stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runOnce).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
