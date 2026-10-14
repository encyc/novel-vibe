import { describe, expect, it, vi } from "vitest";
import { DocumentWriteCoordinator } from "../lib/document-write-coordinator.js";
import { sha256Content } from "../lib/storage.js";
import {
  DocumentConflictError,
  VersionedDocumentWriter,
  type VersionedDocumentWriterOptions,
} from "./service.js";

const oldContent = "---\nstatus: draft\n---\n# 开篇\n旧正文";
const newContent = "---\nstatus: draft\n---\n# 开篇\n新正文";

function setup(overrides: Partial<VersionedDocumentWriterOptions> = {}) {
  const storage = {
    read: vi.fn().mockResolvedValue(oldContent),
    write: vi.fn().mockResolvedValue(undefined),
    writeDocumentSnapshot: vi.fn(async (path: string, hash: string) => `.versions/${path}/${hash}.md`),
  };
  const repository = {
    claimWrite: vi.fn().mockResolvedValue({ outcome: "claimed", versionId: "v1" }),
    completeWrite: vi.fn().mockResolvedValue({ versionNo: 1 }),
    failWrite: vi.fn().mockResolvedValue(undefined),
  };
  const logs: unknown[] = [];
  const options: VersionedDocumentWriterOptions = {
    storage,
    repository,
    coordinator: new DocumentWriteCoordinator(),
    now: () => new Date("2026-08-14T08:00:00.000Z"),
    uuid: () => "11111111-1111-4111-8111-111111111111",
    logger: { info: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) },
    ...overrides,
  };
  return { writer: new VersionedDocumentWriter(options), storage, repository, logs };
}

describe("VersionedDocumentWriter", () => {
  it("captures baseline and completes a changed write", async () => {
    const { writer, storage, repository } = setup({ afterHeadWrite: vi.fn().mockResolvedValue(true) });

    const result = await writer.write({
      projectId: "p1", path: "text/ch-001.md", content: newContent,
      source: { type: "agent", userId: "u1", agentId: "writer", sessionId: "s1", turnId: "t1", toolCallId: "call1" },
    });

    expect(storage.writeDocumentSnapshot).toHaveBeenNthCalledWith(1, "text/ch-001.md", sha256Content(oldContent), oldContent);
    expect(storage.writeDocumentSnapshot).toHaveBeenNthCalledWith(2, "text/ch-001.md", sha256Content(newContent), newContent);
    expect(storage.write).toHaveBeenCalledWith("text/ch-001.md", newContent);
    expect(repository.claimWrite).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1", path: "text/ch-001.md", sourceType: "agent", agentId: "writer",
      sessionId: "s1", turnId: "t1", toolCallId: "call1", createdBy: "u1",
    }));
    expect(result).toMatchObject({ changed: true, versionId: "v1", versionNo: 1, indexed: true });
  });

  it("does not claim on identical content", async () => {
    const { writer, repository } = setup();
    const result = await writer.write({
      projectId: "p1", path: "text/ch-001.md", content: oldContent,
      source: { type: "user", userId: "u1" },
    });

    expect(result).toMatchObject({ changed: false, afterHash: sha256Content(oldContent), indexed: false });
    expect(repository.claimWrite).not.toHaveBeenCalled();
  });

  it("fails intent before head write when snapshot fails", async () => {
    const { writer, storage, repository } = setup();
    storage.writeDocumentSnapshot.mockRejectedValueOnce(new Error("storage down"));

    await expect(writer.write({
      projectId: "p1", path: "text/ch-001.md", content: newContent,
      source: { type: "user", userId: "u1" },
    })).rejects.toThrow("storage down");

    expect(repository.failWrite).toHaveBeenCalledWith(
      "v1", "11111111-1111-4111-8111-111111111111", "snapshot_write_failed",
    );
    expect(storage.write).not.toHaveBeenCalled();
  });

  it("enforces base hash and returns current content with a conflict", async () => {
    const { writer, repository } = setup();
    const error = await writer.write({
      projectId: "p1", path: "text/ch-001.md", content: newContent, baseHash: "stale",
      source: { type: "user", userId: "u1" },
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(DocumentConflictError);
    expect(error).toMatchObject({ content: oldContent, hash: sha256Content(oldContent), path: "text/ch-001.md" });
    expect(repository.claimWrite).not.toHaveBeenCalled();
  });

  it("rejects empty base hash against an existing document", async () => {
    const { writer, repository } = setup();
    const error = await writer.write({
      projectId: "p1", path: "text/ch-001.md", content: newContent, baseHash: "",
      source: { type: "user", userId: "u1" },
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(DocumentConflictError);
    expect(repository.claimWrite).not.toHaveBeenCalled();
  });

  it("treats empty base hash on an absent document as create-if-absent consent", async () => {
    const absentStorage = {
      read: vi.fn().mockRejectedValue(new Error("[404] not found")),
      write: vi.fn().mockResolvedValue(undefined),
      writeDocumentSnapshot: vi.fn(async (path: string, hash: string) => `.versions/${path}/${hash}.md`),
    };
    const { writer, repository } = setup({ storage: absentStorage });

    const result = await writer.write({
      projectId: "p1", path: "worldview/new-doc.md", content: newContent, baseHash: "",
      source: { type: "user", userId: "u1" },
    });

    expect(result).toMatchObject({ changed: true, versionId: "v1", versionNo: 1 });
    expect(absentStorage.write).toHaveBeenCalledWith("worldview/new-doc.md", newContent);
    expect(repository.claimWrite).toHaveBeenCalledWith(expect.objectContaining({ beforeHash: null }));
  });

  it("still conflicts when base hash is stale against an absent document", async () => {
    const absentStorage = {
      read: vi.fn().mockRejectedValue(new Error("[404] not found")),
      write: vi.fn().mockResolvedValue(undefined),
      writeDocumentSnapshot: vi.fn(async (path: string, hash: string) => `.versions/${path}/${hash}.md`),
    };
    const { writer, repository } = setup({ storage: absentStorage });

    const error = await writer.write({
      projectId: "p1", path: "worldview/new-doc.md", content: newContent, baseHash: "stale",
      source: { type: "user", userId: "u1" },
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(DocumentConflictError);
    expect(repository.claimWrite).not.toHaveBeenCalled();
  });

  it("completes with an unavailable diff if derivation fails after the head write", async () => {
    const { writer, repository } = setup({ computeDiff: () => { throw new Error("diff broke"); } });

    await expect(writer.write({
      projectId: "p1", path: "text/ch-001.md", content: newContent,
      source: { type: "system", jobId: "job-1" },
    })).resolves.toMatchObject({ changed: true, addedLines: 0, deletedLines: 0 });
    expect(repository.completeWrite).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "diff_compute_failed",
      diff: expect.objectContaining({ status: "unavailable", hunks: [] }),
    }));
  });

  it("never serializes document contents into lifecycle logs", async () => {
    const { writer, logs } = setup();
    await writer.write({
      projectId: "p1", path: "text/ch-001.md", content: newContent,
      source: { type: "user", userId: "u1" },
    });

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(oldContent);
    expect(serialized).not.toContain(newContent);
    expect(serialized).not.toContain("旧正文");
    expect(serialized).not.toContain("新正文");
  });
});
