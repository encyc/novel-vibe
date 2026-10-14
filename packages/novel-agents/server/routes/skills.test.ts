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
import { DEFAULT_USER, mockBody, mockNoBody, mockReq, mockRes, mockSkillReviewService, resetServerMocks } from "../test-kit.js";

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

describe("server skills", () => {
  it("lists skills on GET /api/skills", async () => {
      const req = mockReq({ method: "GET", url: "/api/skills" });
      mockNoBody(req);
      const res = mockRes();

      const { listAllSkillsForUI } = await import("../../lib/skills.js");

      await handleRequest(req as any, res as any);

      expect(listAllSkillsForUI).toHaveBeenCalled();
    });

  it("creates a reviewed draft instead of directly installing", async () => {
      const req = mockReq({ method: "POST", url: "/api/skill-drafts" });
      mockBody(req, {
        source: "paste",
        slug: "my-skill",
        content: "---\nname: Test\ndescription: Test\n---\n# Body",
        roles: ["writer"],
      });
      const res = mockRes();
      mockSkillReviewService.createDraft.mockResolvedValueOnce({ id: "draft-1", slug: "my-skill" });

      await handleRequest(req as any, res as any);

      expect(mockSkillReviewService.createDraft).toHaveBeenCalledWith(DEFAULT_USER, expect.objectContaining({
        source: "paste", slug: "my-skill", roles: ["writer"],
      }));
      expect(res.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
    });

  it("removes the legacy direct install endpoint", async () => {
      const req = mockReq({ method: "POST", url: "/api/skills/install" });
      mockBody(req, { source: "github", url: "https://github.com/example/repo" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
      expect(mockSkillReviewService.createDraft).not.toHaveBeenCalled();
    });

  it("reviews, reads, confirms, and cancels owner-scoped drafts", async () => {
      mockSkillReviewService.getDraft.mockResolvedValueOnce({ id: "d1" });
      const getReq = mockReq({ method: "GET", url: "/api/skill-drafts/d1" });
      mockNoBody(getReq);
      await handleRequest(getReq as any, mockRes() as any);
      expect(mockSkillReviewService.getDraft).toHaveBeenCalledWith(DEFAULT_USER, "d1");

      mockSkillReviewService.reviewDraft.mockResolvedValueOnce({ review: { id: "r1" } });
      const reviewReq = mockReq({ method: "POST", url: "/api/skill-drafts/d1/review" });
      mockBody(reviewReq, { version: 2 });
      await handleRequest(reviewReq as any, mockRes() as any);
      expect(mockSkillReviewService.reviewDraft).toHaveBeenCalledWith(DEFAULT_USER, "d1", 2);

      mockSkillReviewService.confirmDraft.mockResolvedValueOnce({ id: "s1" });
      const confirmReq = mockReq({ method: "POST", url: "/api/skill-drafts/d1/confirm" });
      mockBody(confirmReq, { version: 2, review_id: "r1", candidate_hash: "hash", idempotency_key: "key" });
      await handleRequest(confirmReq as any, mockRes() as any);
      expect(mockSkillReviewService.confirmDraft).toHaveBeenCalledWith(DEFAULT_USER, "d1", {
        version: 2, reviewId: "r1", candidateHash: "hash", idempotencyKey: "key",
      });

      mockSkillReviewService.cancelDraft.mockResolvedValueOnce({ id: "d1", status: "cancelled" });
      const deleteReq = mockReq({ method: "DELETE", url: "/api/skill-drafts/d1" });
      mockNoBody(deleteReq);
      await handleRequest(deleteReq as any, mockRes() as any);
      expect(mockSkillReviewService.cancelDraft).toHaveBeenCalledWith(DEFAULT_USER, "d1");
    });

  it("gets skill by slug on GET /api/skills/:slug", async () => {
      const req = mockReq({ method: "GET", url: "/api/skills/my-skill" });
      mockNoBody(req);
      const res = mockRes();

      const { loadSkillForUI } = await import("../../lib/skills.js");
      vi.mocked(loadSkillForUI).mockResolvedValueOnce({
        slug: "my-skill",
        metadata: { name: "My Skill", description: "A skill" },
        content: "# Body",
        path: "skills/my-skill",
        source: "user",
      });

      await handleRequest(req as any, res as any);

      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.skill.slug).toBe("my-skill");
    });

  it("returns 404 when skill not found", async () => {
      const req = mockReq({ method: "GET", url: "/api/skills/missing" });
      mockNoBody(req);
      const res = mockRes();

      const { loadSkillForUI } = await import("../../lib/skills.js");
      vi.mocked(loadSkillForUI).mockResolvedValueOnce(null);

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

  it("deletes skill on DELETE /api/skills/:slug", async () => {
      const req = mockReq({ method: "DELETE", url: "/api/skills/old-skill" });
      mockNoBody(req);
      const res = mockRes();

      await handleRequest(req as any, res as any);

      const { uninstallSkill } = await import("../../lib/skills.js");
      expect(uninstallSkill).toHaveBeenCalledWith(expect.any(String), "old-skill", DEFAULT_USER);
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.ok).toBe(true);
    });

  it("lists workspace skills on GET /api/workspaces/:wid/skills", async () => {
      const req = mockReq({ method: "GET", url: "/api/workspaces/ws-1/skills" });
      mockNoBody(req);
      const res = mockRes();

      const { getWorkspaceSkills } = await import("../../lib/skills.js");
      vi.mocked(getWorkspaceSkills).mockResolvedValueOnce([
        { slug: "skill-a", enabled: true, name: "Skill A" },
      ]);

      await handleRequest(req as any, res as any);

      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.skills).toHaveLength(1);
    });

  it("toggles workspace skill on PUT /api/workspaces/:wid/skills/:slug", async () => {
      const req = mockReq({ method: "PUT", url: "/api/workspaces/ws-1/skills/my-skill" });
      mockBody(req, { enabled: true });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      const { toggleWorkspaceSkill } = await import("../../lib/skills.js");
      expect(toggleWorkspaceSkill).toHaveBeenCalledWith(expect.any(String), "ws-1", "my-skill", true, DEFAULT_USER);
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.ok).toBe(true);
    });
});
