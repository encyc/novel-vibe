import { afterEach, describe, expect, it, vi } from "vitest";
import { CommunityService, CommunityServiceError } from "./service.js";

function setup() {
  const db = {
    getCommunityArticle: vi.fn(),
    listCommunityArticles: vi.fn(),
    listCommunityComments: vi.fn(),
    getCommunityComment: vi.fn(),
    getCommunityAuthorProfile: vi.fn(),
    listCommunityArticlesByAuthor: vi.fn(),
    createCommunityArticle: vi.fn(),
    updateCommunityArticle: vi.fn(),
    publishCommunityArticle: vi.fn(),
    softDeleteCommunityArticle: vi.fn(),
    createCommunityComment: vi.fn(),
    softDeleteCommunityComment: vi.fn(),
    toggleCommunityArticleLike: vi.fn(),
    toggleCommunityBookmark: vi.fn(),
    toggleCommunityCommentLike: vi.fn(),
    toggleCommunityFollow: vi.fn(),
    getCommunityInteractions: vi.fn(),
    isFollowing: vi.fn(),
    getUserProfile: vi.fn(),
    isCommunityAdmin: vi.fn(),
    getActiveMembershipUserIds: vi.fn().mockResolvedValue(new Set()),
    setCommunityArticleFeatured: vi.fn(),
    hideCommunityArticle: vi.fn(),
    updateCommunityFeedbackStatus: vi.fn(),
    listCommunityFeedbackByAuthor: vi.fn(),
  };
  return { db, service: new CommunityService(db as any) };
}

afterEach(() => vi.clearAllMocks());

describe("CommunityServiceError", () => {
  it("is an Error with code and status", () => {
    const err = new CommunityServiceError("msg", 404, "CODE");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("msg");
    expect(err.status).toBe(404);
    expect(err.code).toBe("CODE");
  });
});

describe("CommunityService.getArticle", () => {
  it("returns mapped article view when found", async () => {
    const { db, service } = setup();
    db.getCommunityArticle.mockResolvedValue({
      id: "a1", author_id: "u1", title: "T", body: "B", excerpt: "E",
      section: "prompt", tags: ["ai"], status: "published",
      like_count: 5, comment_count: 2, bookmark_count: 1,
      published_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    db.getUserProfile.mockResolvedValue({ id: "u1", nickname: "Alice", avatar_url: null });
    db.getCommunityAuthorProfile.mockResolvedValue({ is_official: true });

    const article = await service.getArticle("a1");

    expect(article.id).toBe("a1");
    expect(article.author.nickname).toBe("Alice");
    expect(article.author.isOfficial).toBe(true);
    expect(article.likeCount).toBe(5);
  });

  it("throws CommunityServiceError 404 when not found", async () => {
    const { db, service } = setup();
    db.getCommunityArticle.mockResolvedValue(null);

    await expect(service.getArticle("missing")).rejects.toMatchObject({
      status: 404,
      code: "ARTICLE_NOT_FOUND",
    });
  });
});

describe("CommunityService.createArticle", () => {
  it("throws 400 when title is empty", async () => {
    const { service } = setup();
    await expect(service.createArticle("u1", { title: "", body: "B", section: "prompt" }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("throws 400 when body is empty", async () => {
    const { service } = setup();
    await expect(service.createArticle("u1", { title: "T", body: "", section: "prompt" }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("creates article and returns mapped view", async () => {
    const { db, service } = setup();
    db.createCommunityArticle.mockResolvedValue({
      id: "a1", author_id: "u1", title: "T", body: "B", excerpt: null,
      section: "prompt", tags: [], status: "draft",
      like_count: 0, comment_count: 0, bookmark_count: 0,
      published_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    db.getUserProfile.mockResolvedValue({ nickname: "Alice", avatar_url: null });
    db.getCommunityAuthorProfile.mockResolvedValue(null);

    const article = await service.createArticle("u1", { title: "T", body: "B", section: "prompt" });

    expect(db.createCommunityArticle).toHaveBeenCalledWith({
      authorId: "u1", title: "T", body: "B", section: "prompt", tags: [],
      kind: "article", feedbackStatus: null, commentsEnabled: true,
    });
    expect(article.id).toBe("a1");
    expect(article.status).toBe("draft");
  });

  it("requires an existing public nickname before creating an article", async () => {
    const { db, service } = setup();
    db.getUserProfile.mockResolvedValue({ id: "u1", nickname: null, avatar_url: null });

    await expect(service.createArticle("u1", { title: "T", body: "B", section: "prompt" }))
      .rejects.toMatchObject({ status: 400, code: "NICKNAME_REQUIRED" });
    expect(db.createCommunityArticle).not.toHaveBeenCalled();
  });
});

describe("CommunityService.listArticles", () => {
  it("returns a composite cursor for popular pages", async () => {
    const { db, service } = setup();
    db.listCommunityArticles.mockResolvedValue([{
      id: "a1", author_id: "u1", title: "T", excerpt: null,
      section: "prompt", tags: [], status: "published",
      like_count: 10, comment_count: 0, bookmark_count: 0,
      published_at: "2026-07-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z",
    }]);
    db.getUserProfile.mockResolvedValue({ id: "u1", nickname: "Alice", avatar_url: null });
    db.getCommunityAuthorProfile.mockResolvedValue(null);

    const result = await service.listArticles({ sort: "popular", limit: 1 });

    expect(result.nextCursor).toBe("popular:10:2026-07-01T00%3A00%3A00.000Z:a1");
  });
});

describe("CommunityService.getAuthorProfile", () => {
  it("throws 404 when the user profile does not exist", async () => {
    const { db, service } = setup();
    db.getUserProfile.mockResolvedValue(null);

    await expect(service.getAuthorProfile("missing-user"))
      .rejects.toMatchObject({ status: 404, code: "AUTHOR_NOT_FOUND" });
  });

  it("marks members via the batch membership lookup", async () => {
    const { db, service } = setup();
    db.getUserProfile.mockResolvedValue({ id: "u1", nickname: "Alice", avatar_url: null });
    db.getCommunityAuthorProfile.mockResolvedValue({ is_official: false });
    db.getActiveMembershipUserIds.mockResolvedValue(new Set(["u1"]));

    const profile = await service.getAuthorProfile("u1");
    expect(profile.isMember).toBe(true);
    expect(db.getActiveMembershipUserIds).toHaveBeenCalledWith(["u1"]);
  });

  it("leaves the member flag off for non-members", async () => {
    const { db, service } = setup();
    db.getUserProfile.mockResolvedValue({ id: "u2", nickname: "Bob", avatar_url: null });
    db.getCommunityAuthorProfile.mockResolvedValue({ is_official: false });

    const profile = await service.getAuthorProfile("u2");
    expect(profile.isMember).toBe(false);
  });
});

describe("CommunityService.publishArticle", () => {
  it("throws 404 when article not found", async () => {
    const { db, service } = setup();
    db.getCommunityArticle.mockResolvedValue(null);
    await expect(service.publishArticle("u1", "missing")).rejects.toMatchObject({ status: 404 });
  });

  it("throws 403 when user is not the author", async () => {
    const { db, service } = setup();
    db.getCommunityArticle.mockResolvedValue({ id: "a1", author_id: "other-user", status: "draft" });
    await expect(service.publishArticle("u1", "a1")).rejects.toMatchObject({ status: 403 });
  });

  it("publishes own draft article", async () => {
    const { db, service } = setup();
    db.getCommunityArticle.mockResolvedValue({ id: "a1", author_id: "u1", status: "draft" });
    db.publishCommunityArticle.mockResolvedValue(undefined);

    await service.publishArticle("u1", "a1");

    expect(db.publishCommunityArticle).toHaveBeenCalledWith("a1");
  });
});

describe("CommunityService.deleteArticle", () => {
  it("throws 403 when user is not the author", async () => {
    const { db, service } = setup();
    db.getCommunityArticle.mockResolvedValue({ id: "a1", author_id: "other", status: "published" });
    await expect(service.deleteArticle("u1", "a1")).rejects.toMatchObject({ status: 403 });
  });

  it("soft-deletes own article", async () => {
    const { db, service } = setup();
    db.getCommunityArticle.mockResolvedValue({ id: "a1", author_id: "u1", status: "published" });
    db.softDeleteCommunityArticle.mockResolvedValue(undefined);

    await service.deleteArticle("u1", "a1");

    expect(db.softDeleteCommunityArticle).toHaveBeenCalledWith("a1");
  });
});

describe("CommunityService.createComment", () => {
  it("creates a top-level comment when rootId is not provided", async () => {
    const { db, service } = setup();
    db.getCommunityArticle.mockResolvedValue({ id: "a1", status: "published" });
    db.createCommunityComment.mockResolvedValue({
      id: "c1", article_id: "a1", author_id: "u1", root_id: null,
      reply_to_user_id: null, body: "Nice!", like_count: 0,
      status: "visible", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    db.getUserProfile.mockResolvedValue({ nickname: "Alice", avatar_url: null });
    db.getCommunityAuthorProfile.mockResolvedValue(null);

    const comment = await service.createComment("u1", { articleId: "a1", body: "Nice!" });

    expect(db.createCommunityComment).toHaveBeenCalledWith({
      articleId: "a1", authorId: "u1", body: "Nice!",
    });
    expect(comment.id).toBe("c1");
  });

  it("creates a reply when rootId is provided", async () => {
    const { db, service } = setup();
    db.getCommunityArticle.mockResolvedValue({ id: "a1", status: "published" });
    db.getCommunityComment.mockResolvedValue({ id: "c1", article_id: "a1", root_id: null, status: "visible" });
    db.createCommunityComment.mockResolvedValue({
      id: "c2", article_id: "a1", author_id: "u1", root_id: "c1",
      reply_to_user_id: "u2", body: "Reply!", like_count: 0,
      status: "visible", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    db.getUserProfile.mockResolvedValue({ nickname: "Alice", avatar_url: null });
    db.getCommunityAuthorProfile.mockResolvedValue(null);

    await service.createComment("u1", { articleId: "a1", body: "Reply!", rootId: "c1", replyToUserId: "u2" });

    expect(db.createCommunityComment).toHaveBeenCalledWith({
      articleId: "a1", authorId: "u1", body: "Reply!", rootId: "c1", replyToUserId: "u2",
    });
  });

  it("throws 400 when body is empty", async () => {
    const { service } = setup();
    await expect(service.createComment("u1", { articleId: "a1", body: "" }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("requires an existing public nickname before creating a comment", async () => {
    const { db, service } = setup();
    db.getCommunityArticle.mockResolvedValue({ id: "a1", status: "published" });
    db.getUserProfile.mockResolvedValue({ id: "u1", nickname: "", avatar_url: null });

    await expect(service.createComment("u1", { articleId: "a1", body: "Nice!" }))
      .rejects.toMatchObject({ status: 400, code: "NICKNAME_REQUIRED" });
    expect(db.createCommunityComment).not.toHaveBeenCalled();
  });

  it("throws 404 when commenting on a non-published article", async () => {
    const { db, service } = setup();
    db.getCommunityArticle.mockResolvedValue({ id: "a1", status: "draft" });

    await expect(service.createComment("u1", { articleId: "a1", body: "Nice!" }))
      .rejects.toMatchObject({ status: 404, code: "ARTICLE_NOT_FOUND" });
    expect(db.createCommunityComment).not.toHaveBeenCalled();
  });

  it("throws 400 when replying to a comment from another article", async () => {
    const { db, service } = setup();
    db.getCommunityArticle.mockResolvedValue({ id: "a1", status: "published" });
    db.getCommunityComment.mockResolvedValue({ id: "c1", article_id: "other-article", root_id: null, status: "visible" });

    await expect(service.createComment("u1", { articleId: "a1", body: "Reply", rootId: "c1" }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_COMMENT_THREAD" });
    expect(db.createCommunityComment).not.toHaveBeenCalled();
  });
});

describe("CommunityService interactions", () => {
  it("throws 404 when liking a draft article", async () => {
    const { db, service } = setup();
    db.getCommunityArticle.mockResolvedValue({ id: "a1", status: "draft" });

    await expect(service.toggleLike("u1", "a1", true))
      .rejects.toMatchObject({ status: 404, code: "ARTICLE_NOT_FOUND" });
    expect(db.toggleCommunityArticleLike).not.toHaveBeenCalled();
  });

  it("throws 404 when liking a deleted comment", async () => {
    const { db, service } = setup();
    db.getCommunityComment.mockResolvedValue({ id: "c1", article_id: "a1", status: "deleted" });

    await expect(service.toggleCommentLike("u1", "c1", true))
      .rejects.toMatchObject({ status: 404, code: "COMMENT_NOT_FOUND" });
    expect(db.toggleCommunityCommentLike).not.toHaveBeenCalled();
  });

  it("throws 403 when deleting another user's comment", async () => {
    const { db, service } = setup();
    db.getCommunityComment.mockResolvedValue({ id: "c1", author_id: "other", status: "visible" });

    await expect(service.deleteComment("u1", "c1"))
      .rejects.toMatchObject({ status: 403, code: "NOT_AUTHOR" });
    expect(db.softDeleteCommunityComment).not.toHaveBeenCalled();
  });
});

describe("CommunityService.toggleFollow", () => {
  it("throws 400 when trying to follow self", async () => {
    const { service } = setup();
    await expect(service.toggleFollow("u1", "u1", true)).rejects.toMatchObject({ status: 400 });
  });

  it("calls toggleCommunityFollow when not self", async () => {
    const { db, service } = setup();
    db.toggleCommunityFollow.mockResolvedValue(undefined);

    await service.toggleFollow("u1", "u2", true);

    expect(db.toggleCommunityFollow).toHaveBeenCalledWith("u1", "u2", true);
  });
});

describe("CommunityService content kinds and admin actions", () => {
  it("reports whether the current user is a community admin", async () => {
    const { db, service } = setup();
    db.isCommunityAdmin.mockResolvedValue(true);

    await expect(service.isAdmin("admin")).resolves.toBe(true);

    expect(db.isCommunityAdmin).toHaveBeenCalledWith("admin");
  });

  it("creates a bug with open feedback status", async () => {
    const { db, service } = setup();
    db.getUserProfile.mockResolvedValue({ id: "u1", nickname: "Alice", avatar_url: null });
    db.createCommunityArticle.mockResolvedValue({
      id: "b1", author_id: "u1", title: "Bug", body: "Steps", excerpt: null,
      section: "tools", tags: [], status: "draft", kind: "bug",
      is_featured: false, feedback_status: "open", comments_enabled: true,
      like_count: 0, comment_count: 0, bookmark_count: 0,
      published_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    db.getCommunityAuthorProfile.mockResolvedValue(null);

    await service.createArticle("u1", { kind: "bug", title: "Bug", body: "Steps", section: "tools" });

    expect(db.createCommunityArticle).toHaveBeenCalledWith(expect.objectContaining({
      kind: "bug",
      feedbackStatus: "open",
      commentsEnabled: true,
    }));
  });

  it("rejects announcement creation from non-admin users", async () => {
    const { db, service } = setup();
    db.isCommunityAdmin.mockResolvedValue(false);

    await expect(service.createArticle("u1", {
      kind: "announcement",
      title: "Notice",
      body: "Body",
      section: "announcements",
    })).rejects.toMatchObject({ status: 403, code: "ADMIN_REQUIRED" });
  });

  it("allows admins to feature content", async () => {
    const { db, service } = setup();
    db.isCommunityAdmin.mockResolvedValue(true);
    db.setCommunityArticleFeatured.mockResolvedValue(undefined);

    await service.setFeatured("admin", "a1", true);

    expect(db.setCommunityArticleFeatured).toHaveBeenCalledWith("a1", true);
  });

  it("rejects comments on announcements", async () => {
    const { db, service } = setup();
    db.getCommunityArticle.mockResolvedValue({
      id: "n1",
      status: "published",
      kind: "announcement",
      comments_enabled: false,
    });

    await expect(service.createComment("u1", { articleId: "n1", body: "Question" }))
      .rejects.toMatchObject({ status: 400, code: "COMMENTS_DISABLED" });
  });

  it("validates feedback status for feature requests", async () => {
    const { db, service } = setup();
    db.isCommunityAdmin.mockResolvedValue(true);
    db.getCommunityArticle.mockResolvedValue({ id: "r1", kind: "feature_request" });

    await service.updateFeedbackStatus("admin", "r1", "planned");

    expect(db.updateCommunityFeedbackStatus).toHaveBeenCalledWith("r1", "planned");
  });
});
