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
import { DEFAULT_USER, mockBody, mockDbInstance, mockNoBody, mockReq, mockRes, resetServerMocks } from "../test-kit.js";

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

describe("server community", () => {
  it("allows anonymous community reads but rejects anonymous community interactions", async () => {
      mockDbInstance.listCommunityArticles.mockResolvedValue([]);

      const readReq = mockReq({ method: "GET", url: "/api/community/articles", headers: {} });
      const readRes = mockRes();
      await handleRequest(readReq as any, readRes as any);
      expect(readRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));

      const writeReq = mockReq({ method: "POST", url: "/api/community/articles", headers: {} });
      mockBody(writeReq, { title: "Anon", body: "Body", section: "prompt" });
      const writeRes = mockRes();
      await handleRequest(writeReq as any, writeRes as any);
      expect(writeRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));

      const commentReq = mockReq({ method: "POST", url: "/api/community/articles/a1/comments", headers: {} });
      mockBody(commentReq, { body: "Anon comment" });
      const commentRes = mockRes();
      await handleRequest(commentReq as any, commentRes as any);
      expect(commentRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));

      const likeReq = mockReq({ method: "POST", url: "/api/community/articles/a1/like", headers: {} });
      mockNoBody(likeReq);
      const likeRes = mockRes();
      await handleRequest(likeReq as any, likeRes as any);
      expect(likeRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });

  it("rejects community article creation when the user has no public nickname", async () => {
      mockDbInstance.getUserProfile.mockResolvedValue({
        id: DEFAULT_USER,
        nickname: null,
        avatar_url: null,
      });
      const req = mockReq({ method: "POST", url: "/api/community/articles" });
      mockBody(req, { title: "T", body: "B", section: "prompt", tags: [] });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.upsertUserProfile).not.toHaveBeenCalled();
      expect(mockDbInstance.createCommunityArticle).not.toHaveBeenCalled();
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

  it("creates community content with kind and strips forged user id", async () => {
      mockDbInstance.createCommunityArticle.mockResolvedValue({
        id: "bug-1", author_id: DEFAULT_USER, title: "Bug", body: "Steps", excerpt: null,
        section: "tools", tags: [], status: "draft", kind: "bug",
        is_featured: false, feedback_status: "open", comments_enabled: true,
        like_count: 0, comment_count: 0, bookmark_count: 0,
        published_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      mockDbInstance.getCommunityAuthorProfile.mockResolvedValue(null);
      const req = mockReq({ method: "POST", url: "/api/community/articles" });
      mockBody(req, { kind: "bug", title: "Bug", body: "Steps", user_id: "attacker" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.createCommunityArticle).toHaveBeenCalledWith(expect.objectContaining({
        authorId: DEFAULT_USER,
        kind: "bug",
      }));
    });

  it("updates feedback status through an admin-only route", async () => {
      mockDbInstance.isCommunityAdmin.mockResolvedValue(true);
      mockDbInstance.getCommunityArticle.mockResolvedValue({ id: "r1", kind: "feature_request" });
      const req = mockReq({ method: "PATCH", url: "/api/community/articles/r1/feedback-status" });
      mockBody(req, { feedbackStatus: "planned" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.updateCommunityFeedbackStatus).toHaveBeenCalledWith("r1", "planned");
    });

  it("lists my feedback for the authenticated user", async () => {
      mockDbInstance.listCommunityFeedbackByAuthor.mockResolvedValue([]);
      const req = mockReq({ method: "GET", url: "/api/community/me/feedback" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.listCommunityFeedbackByAuthor).toHaveBeenCalledWith(DEFAULT_USER);
    });

  it("returns the authenticated user's community admin status", async () => {
      mockDbInstance.isCommunityAdmin.mockResolvedValue(true);
      const req = mockReq({ method: "GET", url: "/api/community/me/admin" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.isCommunityAdmin).toHaveBeenCalledWith(DEFAULT_USER);
      expect(JSON.parse((res.end as any).mock.calls[0][0])).toEqual({ isCommunityAdmin: true });
    });

  it("rejects anonymous access to my feedback", async () => {
      const req = mockReq({ method: "GET", url: "/api/community/me/feedback", headers: {} });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });
});
