import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { handleRequest } from "../../server.js";
import { documentWrites } from "../../lib/document-write-coordinator.js";
import { signTestToken } from "../../lib/auth.js";
import { SessionTurnInterruptedError } from "../../session/service.js";
import { SessionDomainError } from "../../session/types.js";
import { sha256Content } from "../../lib/storage.js";
import { VersionedDocumentWriter } from "../../document-version/service.js";
import { parseFrontmatter } from "../../lib/frontmatter.js";
import { DEFAULT_USER, mockBody, mockDbInstance, mockNoBody, mockReq, mockRes, mockStorageInstance, resetServerMocks } from "../test-kit.js";

vi.mock("../../lib/agent-resources/runtime.js", () => import("../test-kit.js").then((k) => k.agentResourcesMockFactory()));
vi.mock("../../model-runtime/system-resolver.js", () => import("../test-kit.js").then((k) => k.modelResolverMockFactory()));
vi.mock("../../auth/api-token-repository.js", () => import("../test-kit.js").then((k) => k.apiTokenRepoMockFactory()));
vi.mock("../../lib/db.js", () => import("../test-kit.js").then((k) => k.dbMockFactory()));
vi.mock("../../lib/storage.js", (importOriginal) => import("../test-kit.js").then((k) => k.storageMockFactory(importOriginal)));
vi.mock("../../agents.js", () => import("../test-kit.js").then((k) => k.agentsMockFactory()));
vi.mock("../../session/service.js", () => import("../test-kit.js").then((k) => k.sessionServiceMockFactory()));
vi.mock("../../lib/frontmatter.js", () => import("../test-kit.js").then((k) => k.frontmatterMockFactory()));
vi.mock("../../lib/skills.js", () => import("../test-kit.js").then((k) => k.skillsMockFactory()));
vi.mock("../../skills/runtime.js", () => import("../test-kit.js").then((k) => k.skillReviewMockFactory()));

beforeEach(async () => {
  await resetServerMocks();
});

describe("server documents", () => {
  it("keeps document reads available for archived projects", async () => {
      mockDbInstance.listDocuments.mockResolvedValue([{ doc_path: "text/chapter-001.md" }]);
      const req = mockReq({ method: "GET", url: "/api/documents/p1" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockDbInstance.listDocuments).toHaveBeenCalledWith("p1", undefined);
    });

  it("lists documents on GET /api/documents/:pid", async () => {
      const req = mockReq({ method: "GET", url: "/api/documents/proj-1?type=character" });
      mockNoBody(req);
      const res = mockRes();

      mockDbInstance.listDocuments.mockResolvedValue([
        { doc_path: "chars/lin-fan.md", name: "林凡", status: "draft" },
      ]);

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.listDocuments).toHaveBeenCalledWith("proj-1", "character");
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.documents).toHaveLength(1);
    });

  it("lists safe document version summaries with a clamped limit", async () => {
      const version = {
        id: "v1", project_id: "proj-1", doc_path: "text/第一章.md", version_no: 2,
        source_type: "agent", agent_id: "writer", session_id: "s1", turn_id: "t1",
        tool_call_id: "call-1", created_by: DEFAULT_USER, before_hash: "before", after_hash: "after",
        state: "complete", created_at: "2026-08-14T00:00:00Z", completed_at: "2026-08-14T00:00:01Z",
        document_version_diffs: { status: "ready", added_lines: 2, deleted_lines: 1, changed_sections: ["开篇"] },
      };
      mockDbInstance.listDocumentVersions.mockResolvedValue([version]);
      const req = mockReq({ method: "GET", url: "/api/documents/proj-1/text/%E7%AC%AC%E4%B8%80%E7%AB%A0.md/versions?limit=999" });
      mockNoBody(req);
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.listDocumentVersions).toHaveBeenCalledWith("proj-1", "text/第一章.md", null, 101);
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.items[0]).toMatchObject({ id: "v1", projectId: "proj-1", path: "text/第一章.md", versionNo: 2, diffStatus: "ready" });
      expect(body.items[0]).not.toHaveProperty("leaseId");
    });

  it("returns a version detail or owner-scoped 404", async () => {
      mockDbInstance.getDocumentVersion.mockResolvedValueOnce(null);
      const missingReq = mockReq({ method: "GET", url: "/api/document-versions/cross-owner" });
      mockNoBody(missingReq);
      const missingRes = mockRes();
      await handleRequest(missingReq as any, missingRes as any);
      expect(missingRes.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

  it("paginates a ready diff and rejects malformed cursors", async () => {
      const version = {
        id: "v1", project_id: "proj-1", doc_path: "text/1.md", version_no: 1,
        source_type: "user", before_hash: "before", after_hash: "after", state: "complete",
        created_at: "2026-08-14T00:00:00Z", completed_at: "2026-08-14T00:00:01Z",
        document_version_diffs: { status: "ready", added_lines: 1, deleted_lines: 0, changed_sections: [] },
      };
      mockDbInstance.getDocumentVersion.mockResolvedValue(version);
      mockDbInstance.getDocumentVersionDiff.mockResolvedValue({
        status: "ready", algorithm_version: "jsdiff-v1", body_hunks: [{ index: 0, section: null, oldStart: 1, newStart: 1, lines: [] }],
        frontmatter_changes: [], added_lines: 1, deleted_lines: 0, changed_sections: [], truncated: false,
      });
      const req = mockReq({ method: "GET", url: "/api/document-versions/v1/diff?limit=10&cursor=0" });
      mockNoBody(req);
      const res = mockRes();
      await handleRequest(req as any, res as any);
      expect(JSON.parse((res.end as any).mock.calls[0][0])).toMatchObject({ items: [{ index: 0 }], nextCursor: null });

      const invalidReq = mockReq({ method: "GET", url: "/api/document-versions/v1/diff?cursor=nope" });
      mockNoBody(invalidReq);
      const invalidRes = mockRes();
      await handleRequest(invalidReq as any, invalidRes as any);
      expect(invalidRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(JSON.parse((invalidRes.end as any).mock.calls[0][0]).error.code).toBe("INVALID_CURSOR");
    });

  it("reports unavailable diffs as repairable conflicts", async () => {
      mockDbInstance.getDocumentVersion.mockResolvedValue({
        id: "v1", project_id: "proj-1", doc_path: "a.md", version_no: 1,
        source_type: "user", before_hash: null, after_hash: "after", state: "complete",
        created_at: "2026-08-14T00:00:00Z", completed_at: "2026-08-14T00:00:01Z",
        document_version_diffs: { status: "unavailable", added_lines: 0, deleted_lines: 0, changed_sections: [] },
      });
      mockDbInstance.getDocumentVersionDiff.mockResolvedValue({
        status: "unavailable", algorithm_version: "jsdiff-v1", body_hunks: [], frontmatter_changes: [],
        added_lines: 0, deleted_lines: 0, changed_sections: [], truncated: false,
      });
      const req = mockReq({ method: "GET", url: "/api/document-versions/v1/diff" });
      mockNoBody(req);
      const res = mockRes();
      await handleRequest(req as any, res as any);
      expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
      expect(JSON.parse((res.end as any).mock.calls[0][0]).error).toMatchObject({
        code: "DOCUMENT_DIFF_UNAVAILABLE", details: { repairable: true },
      });
    });

  it("reads document content on GET /api/documents/:pid/:path", async () => {
      const req = mockReq({ method: "GET", url: "/api/documents/proj-1/characters/lin-fan.md" });
      mockNoBody(req);
      const res = mockRes();

      mockStorageInstance.read.mockResolvedValue("# Hello\n\nContent");

      await handleRequest(req as any, res as any);

      expect(mockStorageInstance.read).toHaveBeenCalledWith("characters/lin-fan.md");
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.content).toBe("# Hello\n\nContent");
      expect(body.hash).toBe(sha256Content("# Hello\n\nContent"));
      expect(body.path).toBe("characters/lin-fan.md");
    });

  it("writes document and syncs index on PUT /api/documents/:pid/:path", async () => {
      const req = mockReq({ method: "PUT", url: "/api/documents/proj-1/characters/test.md" });
      mockBody(req, {
        content: "---\ntype: character\nname: Test\nslug: test\nrole: supporting\nstatus: draft\ntags: []\nabilities: []\narc_stage: origin\nappears_in: []\n---\n# Body",
        base_hash: sha256Content("# Existing"),
      });
      const res = mockRes();

      mockStorageInstance.read.mockResolvedValue("# Existing");
      mockStorageInstance.write.mockResolvedValue(undefined);
      mockDbInstance.upsertDocumentIndex.mockResolvedValue(undefined);
      const versionedWrite = vi.spyOn(VersionedDocumentWriter.prototype, "write");

      await handleRequest(req as any, res as any);

      expect(mockStorageInstance.write).toHaveBeenCalledWith(
        "characters/test.md",
        expect.stringContaining("type: character"),
      );
      expect(mockDbInstance.upsertDocumentIndex).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-1",
          docPath: "characters/test.md",
          docType: "character",
          name: "Test",
        }),
      );
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.ok).toBe(true);
      expect(body).toMatchObject({ changed: true, versionId: "version-1", versionNo: 1 });
      expect(body.hash).toBe(sha256Content("---\ntype: character\nname: Test\nslug: test\nrole: supporting\nstatus: draft\ntags: []\nabilities: []\narc_stage: origin\nappears_in: []\n---\n# Body"));
      expect(body.indexed).toBe(true);
      expect(versionedWrite).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "proj-1",
        path: "characters/test.md",
        source: { type: "user", userId: DEFAULT_USER },
      }));
      versionedWrite.mockRestore();
    });

  it("enqueues continuity when a manual save confirms a chapter", async () => {
      const content = "---\ntype: chapter-text\nchapter: 3\nvolume: 1\npov: hero\nstatus: confirmed\nword_count: 2\ncharacters_present: []\nstyle_tags: []\n---\n# Chapter";
      vi.mocked(parseFrontmatter).mockReturnValueOnce({
        frontmatter: {
          type: "chapter-text", chapter: 3, volume: 1, pov: "hero", status: "confirmed",
          word_count: 2, characters_present: [], style_tags: [],
        },
        body: "# Chapter",
      });
      mockDbInstance.getDocument.mockResolvedValue({ status: "draft" });
      mockStorageInstance.read.mockResolvedValue("old draft");
      const req = mockReq({ method: "PUT", url: "/api/documents/proj-1/text/ch-003.md" });
      mockBody(req, { content, base_hash: sha256Content("old draft") });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.enqueueContinuityJob).toHaveBeenCalledWith({
        projectId: "proj-1",
        chapterNumber: 3,
        chapterPath: "text/ch-003.md",
        confirmedHash: sha256Content(content),
      });
    });

  it("skips continuity enqueue when the membership lacks the continuity feature", async () => {
      const content = "---\ntype: chapter-text\nchapter: 3\nvolume: 1\npov: hero\nstatus: confirmed\nword_count: 2\ncharacters_present: []\nstyle_tags: []\n---\n# Chapter";
      vi.mocked(parseFrontmatter).mockReturnValueOnce({
        frontmatter: {
          type: "chapter-text", chapter: 3, volume: 1, pov: "hero", status: "confirmed",
          word_count: 2, characters_present: [], style_tags: [],
        },
        body: "# Chapter",
      });
      mockDbInstance.getDocument.mockResolvedValue({ status: "draft" });
      mockDbInstance.getActiveMembership.mockResolvedValueOnce({ active: true, features: ["unlimited_projects"] });
      mockStorageInstance.read.mockResolvedValue("old draft");
      const req = mockReq({ method: "PUT", url: "/api/documents/proj-1/text/ch-003.md" });
      mockBody(req, { content, base_hash: sha256Content("old draft") });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body).toMatchObject({ ok: true });
      expect(mockDbInstance.enqueueContinuityJob).not.toHaveBeenCalled();
    });

  it("returns changed false without claiming a version for identical content", async () => {
      const content = "# Same";
      const req = mockReq({ method: "PUT", url: "/api/documents/proj-1/text/same.md" });
      mockBody(req, { content, base_hash: sha256Content(content) });
      const res = mockRes();
      mockStorageInstance.read.mockResolvedValue(content);

      await handleRequest(req as any, res as any);

      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body).toMatchObject({ ok: true, changed: false, hash: sha256Content(content), indexed: false });
      expect(body).not.toHaveProperty("versionId");
      expect(mockDbInstance.claimDocumentWrite).not.toHaveBeenCalled();
      expect(mockStorageInstance.write).not.toHaveBeenCalled();
    });

  it("returns 400 on PUT document without content or base hash", async () => {
      const req = mockReq({ method: "PUT", url: "/api/documents/proj-1/test.md" });
      mockBody(req, {});
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

  it("returns a fixed safe 403 when document ownership does not match", async () => {
      mockDbInstance.getProject
        .mockResolvedValueOnce({ id: "proj-1", lifecycle_status: "active" })
        .mockResolvedValueOnce({ id: "proj-1", owner_id: "another-user" });
      const req = mockReq({ method: "PUT", url: "/api/documents/proj-1/test.md" });
      mockBody(req, { content: "local", base_hash: "hash:old" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body).toEqual({
        error: { code: "FORBIDDEN", message: "You do not own this project" },
      });
      expect(JSON.stringify(body)).not.toMatch(/another-user|default-user|proj-1/);
    });

  it("returns a non-leaking 500 when document ownership lookup fails", async () => {
      mockDbInstance.getProject
        .mockResolvedValueOnce({ id: "proj-1", lifecycle_status: "active" })
        .mockRejectedValueOnce(new Error("PostgREST projects secret schema detail"));
      const req = mockReq({ method: "PUT", url: "/api/documents/proj-1/test.md" });
      mockBody(req, { content: "local", base_hash: "hash:old" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body).toEqual({ error: { code: "INTERNAL_ERROR" } });
      expect(JSON.stringify(body)).not.toMatch(/PostgREST|projects|secret|schema|detail/i);
    });

  it("returns the remote version without writing on hash conflict", async () => {
      const req = mockReq({ method: "PUT", url: "/api/documents/proj-1/text/chapter-001.md" });
      mockBody(req, { content: "local draft", base_hash: sha256Content("stale") });
      const res = mockRes();
      mockStorageInstance.read.mockResolvedValue("remote content");

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
      expect(mockStorageInstance.write).not.toHaveBeenCalled();
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body).toEqual({
        error: {
          code: "DOCUMENT_CONFLICT",
          message: "Document conflict",
          details: {
            content: "remote content",
            hash: sha256Content("remote content"),
            path: "text/chapter-001.md",
          },
        },
      });
    });

  it("reports a persisted save when index synchronization fails", async () => {
      const req = mockReq({ method: "PUT", url: "/api/documents/proj-1/characters/test.md" });
      mockBody(req, { content: "---\ntype: character\nname: Test\nslug: test\nrole: supporting\nstatus: draft\ntags: []\nabilities: []\narc_stage: origin\nappears_in: []\n---\n# New", base_hash: sha256Content("old") });
      const res = mockRes();
      mockStorageInstance.read.mockResolvedValue("old");
      mockDbInstance.upsertDocumentIndex.mockRejectedValue(new Error("index unavailable"));

      await handleRequest(req as any, res as any);

      expect(mockStorageInstance.write).toHaveBeenCalled();
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body).toMatchObject({ ok: true, indexed: false });
    });

  it("coordinates document deletion by project and path", async () => {
      const req = mockReq({ method: "DELETE", url: "/api/documents/proj-1/text/chapter-001.md" });
      mockNoBody(req);
      const res = mockRes();
      const run = vi.spyOn(documentWrites, "run");
      mockStorageInstance.read.mockResolvedValue("# Chapter");

      await handleRequest(req as any, res as any);

      expect(run).toHaveBeenCalledWith(
        "proj-1:text/chapter-001.md",
        expect.any(Function),
      );
      expect(mockStorageInstance.delete).toHaveBeenCalledWith("text/chapter-001.md");
    });
});
