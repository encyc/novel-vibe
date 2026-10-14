import { describe, expect, it, vi } from "vitest";
import { DocumentVersionRepository, type DocumentVersionDataSource } from "./repository.js";

function source(overrides: Partial<DocumentVersionDataSource> = {}): DocumentVersionDataSource {
  return {
    claimDocumentWrite: vi.fn(),
    completeDocumentWrite: vi.fn(),
    failDocumentWrite: vi.fn(),
    listDocumentVersions: vi.fn(),
    getDocumentVersion: vi.fn(),
    getDocumentVersionDiff: vi.fn(),
    claimDocumentVersionRepairs: vi.fn(),
    ...overrides,
  };
}

const completedRow = {
  id: "version-1",
  project_id: "project-1",
  doc_path: "chapters/001.md",
  version_no: 3,
  source_type: "agent",
  agent_id: "writer",
  session_id: "session-1",
  turn_id: "turn-1",
  tool_call_id: "tool-1",
  created_by: "user-1",
  before_hash: "before",
  after_hash: "after",
  state: "complete",
  created_at: "2026-08-14T08:00:00.000Z",
  completed_at: "2026-08-14T08:00:01.000Z",
  document_version_diffs: {
    status: "ready",
    added_lines: 4,
    deleted_lines: 2,
    changed_sections: ["雨夜"],
  },
};

describe("DocumentVersionRepository", () => {
  it("maps completed rows to a safe camelCase summary", async () => {
    const dataSource = source({ getDocumentVersion: vi.fn().mockResolvedValue(completedRow) });
    const repository = new DocumentVersionRepository(dataSource);

    await expect(repository.getVersion("version-1", "project-1")).resolves.toEqual({
      id: "version-1",
      projectId: "project-1",
      path: "chapters/001.md",
      versionNo: 3,
      sourceType: "agent",
      agentId: "writer",
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "tool-1",
      createdBy: "user-1",
      beforeHash: "before",
      afterHash: "after",
      state: "complete",
      diffStatus: "ready",
      addedLines: 4,
      deletedLines: 2,
      changedSections: ["雨夜"],
      createdAt: "2026-08-14T08:00:00.000Z",
      completedAt: "2026-08-14T08:00:01.000Z",
    });
    expect(await repository.getVersion("version-1", "project-1")).not.toHaveProperty("leaseId");
    expect(dataSource.getDocumentVersion).toHaveBeenCalledWith("version-1", "project-1");
  });

  it("uses a positive version cursor and returns the next cursor", async () => {
    const rows = [completedRow, { ...completedRow, id: "version-2", version_no: 2 }];
    const dataSource = source({ listDocumentVersions: vi.fn().mockResolvedValue(rows) });
    const repository = new DocumentVersionRepository(dataSource);

    const page = await repository.listVersions("project-1", "chapters/001.md", "4", 1);

    expect(dataSource.listDocumentVersions).toHaveBeenCalledWith("project-1", "chapters/001.md", 4, 2);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe("3");
  });

  it("maps claim, completion, failure, diff, and repair operations", async () => {
    const diff = {
      algorithm_version: "jsdiff-v1",
      status: "ready",
      body_hunks: [],
      frontmatter_changes: [],
      added_lines: 1,
      deleted_lines: 0,
      changed_sections: ["开篇"],
      truncated: false,
    };
    const dataSource = source({
      claimDocumentWrite: vi.fn().mockResolvedValue({ outcome: "claimed", version_id: "version-1" }),
      completeDocumentWrite: vi.fn().mockResolvedValue({ version_no: 3 }),
      getDocumentVersionDiff: vi.fn().mockResolvedValue(diff),
      claimDocumentVersionRepairs: vi.fn().mockResolvedValue([{
        id: "version-1", project_id: "project-1", doc_path: "a.md",
        before_hash: null, after_hash: "after", before_snapshot_path: null,
        after_snapshot_path: "snapshots/after.md", lease_id: "lease-1",
      }]),
    });
    const repository = new DocumentVersionRepository(dataSource);

    await expect(repository.claimWrite({
      projectId: "project-1", path: "a.md", beforeHash: null, afterHash: "after",
      sourceType: "user", leaseId: "lease-1", leaseExpiresAt: "2026-08-14T09:00:00.000Z",
    })).resolves.toEqual({ outcome: "claimed", versionId: "version-1" });
    await expect(repository.completeWrite({
      versionId: "version-1", leaseId: "lease-1", beforeSnapshotPath: null,
      afterSnapshotPath: "snapshots/after.md",
      diff: {
        algorithmVersion: "jsdiff-v1", status: "ready", hunks: [], frontmatterChanges: [],
        addedLines: 1, deletedLines: 0, changedSections: ["开篇"], truncated: false,
      },
    })).resolves.toEqual({ versionNo: 3 });
    await repository.failWrite("version-1", "lease-1", "storage_failed");
    await expect(repository.getDiff("version-1")).resolves.toMatchObject({
      algorithmVersion: "jsdiff-v1", addedLines: 1, changedSections: ["开篇"],
    });
    await expect(repository.claimRepairs("2026-08-14T10:00:00.000Z", 5)).resolves.toEqual([{
      id: "version-1", projectId: "project-1", path: "a.md", beforeHash: null,
      afterHash: "after", beforeSnapshotPath: null, afterSnapshotPath: "snapshots/after.md",
      leaseId: "lease-1",
    }]);
    expect(dataSource.failDocumentWrite).toHaveBeenCalledWith("version-1", "lease-1", "storage_failed");
  });
});
