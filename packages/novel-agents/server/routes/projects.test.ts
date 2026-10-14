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
import { DEFAULT_USER, mockBody, mockDbInstance, mockNoBody, mockReq, mockRes, mockSessionService, resetServerMocks } from "../test-kit.js";

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

describe("server projects", () => {
  it("lists projects on GET /api/projects scoped to the authenticated user", async () => {
      const req = mockReq({ method: "GET", url: "/api/projects" });
      mockNoBody(req);
      const res = mockRes();

      mockDbInstance.listProjects.mockResolvedValue([{ id: "proj-1", title: "Test Novel" }]);

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.listProjects).toHaveBeenCalledWith(undefined, "active");
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.projects).toEqual([{ id: "proj-1", title: "Test Novel" }]);
    });

  it("filters projects and ignores a forged user id", async () => {
      mockDbInstance.listProjects.mockResolvedValue([]);
      const req = mockReq({ method: "GET", url: "/api/projects?status=archived&user_id=forged" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.listProjects).toHaveBeenCalledWith(undefined, "archived");
    });

  it("updates project metadata through the authenticated project service", async () => {
      mockDbInstance.updateProject.mockResolvedValue({ id: "proj-1", lifecycle_status: "active", title: "Renamed" });
      const req = mockReq({ method: "PATCH", url: "/api/projects/proj-1" });
      mockBody(req, { title: " Renamed ", writing_stage: "drafting", creative_language: "en", user_id: "forged" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.updateProject).toHaveBeenCalledWith("proj-1", {
        title: "Renamed",
        writing_stage: "drafting",
        creative_language: "en",
      });
    });

  it("rejects unsupported creative language during project update", async () => {
      const req = mockReq({ method: "PATCH", url: "/api/projects/proj-1" });
      mockBody(req, { creative_language: "fr" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(JSON.parse((res.end as any).mock.calls[0][0])).toMatchObject({
        error: { code: "INVALID_PROJECT_INPUT" },
      });
      expect(mockDbInstance.updateProject).not.toHaveBeenCalled();
    });

  it("enqueues permanent deletion with the authenticated user", async () => {
      mockDbInstance.enqueueProjectDeletion.mockResolvedValue({ outcome: "ok", jobId: "job-1" });
      const req = mockReq({ method: "DELETE", url: "/api/projects/proj-1/permanent" });
      mockNoBody(req);
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.enqueueProjectDeletion).toHaveBeenCalledWith(
        "proj-1",
        DEFAULT_USER,
        expect.any(String),
      );
      expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
    });

  it("maps project domain errors to structured conflicts", async () => {
      mockDbInstance.transitionProjectLifecycle.mockResolvedValue({ outcome: "invalid", from: "trash", command: "archive" });
      const req = mockReq({ method: "POST", url: "/api/projects/proj-1/archive" });
      mockNoBody(req);
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
      expect(res.end).toHaveBeenCalledWith(expect.stringContaining("INVALID_LIFECYCLE_TRANSITION"));
    });

  it("creates a project with the requested creative language", async () => {
      const req = mockReq({ method: "POST", url: "/api/projects" });
      mockBody(req, { title: "English novel", genre: "玄幻", synopsis: "A story", creative_language: "en" });
      const res = mockRes();

      mockDbInstance.createProject.mockResolvedValue({ id: "proj-1", title: "English novel", creative_language: "en" });

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.createProject).toHaveBeenCalledWith(
        expect.objectContaining({ title: "English novel", creativeLanguage: "en" }),
      );
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.project.id).toBe("proj-1");
    });

  it("rejects unsupported creative language during project creation", async () => {
      const req = mockReq({ method: "POST", url: "/api/projects" });
      mockBody(req, { title: "Test novel", creative_language: "fr" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(JSON.parse((res.end as any).mock.calls[0][0])).toMatchObject({
        error: { code: "INVALID_PROJECT_INPUT" },
      });
      expect(mockDbInstance.createProject).not.toHaveBeenCalled();
    });

  it("gets project on GET /api/projects/:id", async () => {
      const req = mockReq({ method: "GET", url: "/api/projects/proj-1" });
      mockNoBody(req);
      const res = mockRes();

      mockDbInstance.getProject.mockResolvedValue({ id: "proj-1", title: "Test Novel" });

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.getProject).toHaveBeenCalledWith("proj-1");
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.project.id).toBe("proj-1");
    });

  it("returns 404 when project not found", async () => {
      const req = mockReq({ method: "GET", url: "/api/projects/missing" });
      mockNoBody(req);
      const res = mockRes();

      mockDbInstance.getProject.mockResolvedValue(null);

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

  it("returns 403 when the authenticated user does not own the project", async () => {
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, {
        project_id: "proj-1",
        session_id: "sess-1",
        message: "Hello",
        user_id: "u2",
      });
      const res = mockRes();

      mockSessionService.chat.mockRejectedValueOnce(
        new SessionDomainError("SESSION_FORBIDDEN", "Forbidden", 403),
      );

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.error).toMatchObject({ code: "SESSION_FORBIDDEN" });
    });
});
