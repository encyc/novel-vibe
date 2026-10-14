import type { DbClient, CommunityArticleRow, CommunityCommentRow, CommunityAuthorProfileRow } from "../lib/db.js";

export type CommunityKind = "article" | "bug" | "feature_request" | "announcement";
export type CommunityFeedbackStatus = "open" | "fixed" | "closed" | "planned" | "shipped" | "declined";

const feedbackStatusByKind: Record<"bug" | "feature_request", Set<CommunityFeedbackStatus>> = {
  bug: new Set(["open", "fixed", "closed"]),
  feature_request: new Set(["open", "planned", "shipped", "declined"]),
};

export class CommunityServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "CommunityServiceError";
  }
}

export interface CommunityAuthorView {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  isOfficial: boolean;
  isMember: boolean;
}

export interface CommunityArticleView {
  id: string;
  author: CommunityAuthorView;
  title: string;
  body: string;
  excerpt: string | null;
  section: string;
  tags: string[];
  status: string;
  kind: CommunityKind;
  isFeatured: boolean;
  feedbackStatus: CommunityFeedbackStatus | null;
  commentsEnabled: boolean;
  likeCount: number;
  commentCount: number;
  bookmarkCount: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommunityArticleSummary {
  id: string;
  author: CommunityAuthorView;
  title: string;
  excerpt: string | null;
  section: string;
  tags: string[];
  kind: CommunityKind;
  isFeatured: boolean;
  feedbackStatus: CommunityFeedbackStatus | null;
  commentsEnabled: boolean;
  likeCount: number;
  commentCount: number;
  bookmarkCount: number;
  publishedAt: string | null;
}

export interface CommunityCommentView {
  id: string;
  articleId: string;
  author: CommunityAuthorView;
  rootId: string | null;
  replyToUserId: string | null;
  body: string;
  likeCount: number;
  status: string;
  createdAt: string;
}

export interface CommunityAuthorProfileView {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  isOfficial: boolean;
  isMember: boolean;
  bio: string | null;
  articleCount: number;
  followerCount: number;
}

export class CommunityService {
  constructor(private readonly db: Pick<DbClient,
    | "getCommunityArticle" | "listCommunityArticles" | "listCommunityComments"
    | "getCommunityComment"
    | "getCommunityAuthorProfile" | "listCommunityArticlesByAuthor"
    | "createCommunityArticle" | "updateCommunityArticle" | "publishCommunityArticle"
    | "softDeleteCommunityArticle" | "createCommunityComment" | "softDeleteCommunityComment"
    | "toggleCommunityArticleLike" | "toggleCommunityBookmark" | "toggleCommunityCommentLike"
    | "toggleCommunityFollow" | "getCommunityInteractions" | "isFollowing"
    | "getUserProfile" | "isCommunityAdmin" | "setCommunityArticleFeatured"
    | "getActiveMembershipUserIds"
    | "hideCommunityArticle" | "updateCommunityFeedbackStatus" | "listCommunityFeedbackByAuthor"
  >) {}

  private async requireAdmin(userId: string): Promise<void> {
    if (!await this.db.isCommunityAdmin(userId)) {
      throw new CommunityServiceError("Admin permission required", 403, "ADMIN_REQUIRED");
    }
  }

  async isAdmin(userId: string): Promise<boolean> {
    return this.db.isCommunityAdmin(userId);
  }

  private normalizeKind(kind?: string): CommunityKind {
    const next = kind || "article";
    if (!["article", "bug", "feature_request", "announcement"].includes(next)) {
      throw new CommunityServiceError("Invalid community content type", 400, "INVALID_KIND");
    }
    return next as CommunityKind;
  }

  private defaultFeedbackStatus(kind: CommunityKind): CommunityFeedbackStatus | null {
    return kind === "bug" || kind === "feature_request" ? "open" : null;
  }

  private async requirePublishedArticle(articleId: string): Promise<CommunityArticleRow> {
    const row = await this.db.getCommunityArticle(articleId);
    if (!row || row.status !== "published") {
      throw new CommunityServiceError("Article not found", 404, "ARTICLE_NOT_FOUND");
    }
    return row;
  }

  private async requireVisibleComment(commentId: string): Promise<CommunityCommentRow> {
    const row = await this.db.getCommunityComment(commentId);
    if (!row || row.status !== "visible") {
      throw new CommunityServiceError("Comment not found", 404, "COMMENT_NOT_FOUND");
    }
    return row;
  }

  private async buildAuthor(userId: string, members?: Set<string>): Promise<CommunityAuthorView> {
    const profile = await this.db.getUserProfile(userId);
    const authorProfile = await this.db.getCommunityAuthorProfile(userId);
    const isMember = members
      ? members.has(userId)
      : (await this.db.getActiveMembershipUserIds([userId])).has(userId);
    return {
      id: userId,
      nickname: profile?.nickname ?? "匿名用户",
      avatarUrl: profile?.avatar_url ?? null,
      isOfficial: authorProfile?.is_official ?? false,
      isMember,
    };
  }

  /** One batch RPC for all authors on a page — keeps the badge N+1-free. */
  private async resolveMembers(authorIds: string[]): Promise<Set<string>> {
    return this.db.getActiveMembershipUserIds(authorIds);
  }

  private async requirePublicNickname(userId: string): Promise<void> {
    const profile = await this.db.getUserProfile(userId);
    if (!profile?.nickname?.trim()) {
      throw new CommunityServiceError("请先设置昵称后再发布内容", 400, "NICKNAME_REQUIRED");
    }
  }

  private summary(row: CommunityArticleRow, author: CommunityAuthorView): CommunityArticleSummary {
    return {
      id: row.id,
      author,
      title: row.title,
      excerpt: row.excerpt,
      section: row.section,
      tags: row.tags,
      kind: this.normalizeKind(row.kind),
      isFeatured: Boolean(row.is_featured),
      feedbackStatus: row.feedback_status ?? null,
      commentsEnabled: row.comments_enabled !== false,
      likeCount: row.like_count,
      commentCount: row.comment_count,
      bookmarkCount: row.bookmark_count,
      publishedAt: row.published_at,
    };
  }

  private articleView(row: CommunityArticleRow, author: CommunityAuthorView): CommunityArticleView {
    return {
      ...this.summary(row, author),
      body: row.body,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listArticles(opts: {
    section?: string;
    tag?: string;
    authorId?: string;
    following?: boolean;
    userId?: string;
    kind?: CommunityKind;
    sort?: "latest" | "popular" | "ranked";
    search?: string;
    featured?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: CommunityArticleSummary[]; nextCursor: string | null }> {
    const rows = await this.db.listCommunityArticles(opts);
    // Fetch author profiles for all unique authors
    const authorIds = [...new Set(rows.map((r) => r.author_id))];
    const members = await this.resolveMembers(authorIds);
    const authorMap = new Map<string, CommunityAuthorView>();
    for (const aid of authorIds) {
      authorMap.set(aid, await this.buildAuthor(aid, members));
    }
    const items = rows.map((r) => this.summary(r, authorMap.get(r.author_id)!));
    const last = rows[rows.length - 1];
    const nextCursor = rows.length === (opts.limit ?? 20) && last
      ? opts.sort === "popular"
        ? `popular:${last.like_count}:${encodeURIComponent(last.published_at ?? "")}:${last.id}`
        : last.published_at
      : null;
    return { items, nextCursor };
  }

  async getArticle(id: string): Promise<CommunityArticleView> {
    const row = await this.db.getCommunityArticle(id);
    if (!row) throw new CommunityServiceError("Article not found", 404, "ARTICLE_NOT_FOUND");
    const author = await this.buildAuthor(row.author_id);
    return this.articleView(row, author);
  }

  async listComments(articleId: string): Promise<CommunityCommentView[]> {
    const rows = await this.db.listCommunityComments(articleId);
    const authorIds = [...new Set(rows.map((r) => r.author_id))];
    const members = await this.resolveMembers(authorIds);
    const authorMap = new Map<string, CommunityAuthorView>();
    for (const aid of authorIds) {
      authorMap.set(aid, await this.buildAuthor(aid, members));
    }
    return rows.map((r) => ({
      id: r.id,
      articleId: r.article_id,
      author: authorMap.get(r.author_id)!,
      rootId: r.root_id,
      replyToUserId: r.reply_to_user_id,
      body: r.body,
      likeCount: r.like_count,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  async getAuthorProfile(userId: string): Promise<CommunityAuthorProfileView> {
    const profile = await this.db.getUserProfile(userId);
    if (!profile) throw new CommunityServiceError("Author not found", 404, "AUTHOR_NOT_FOUND");
    const authorProfile = await this.db.getCommunityAuthorProfile(userId);
    const isMember = (await this.resolveMembers([userId])).has(userId);
    return {
      userId,
      nickname: profile.nickname ?? "匿名用户",
      avatarUrl: profile.avatar_url ?? null,
      isOfficial: authorProfile?.is_official ?? false,
      isMember,
      bio: authorProfile?.bio ?? null,
      articleCount: authorProfile?.article_count ?? 0,
      followerCount: authorProfile?.follower_count ?? 0,
    };
  }

  async listArticlesByAuthor(userId: string, opts?: { cursor?: string; limit?: number }): Promise<{ items: CommunityArticleSummary[]; nextCursor: string | null }> {
    const rows = await this.db.listCommunityArticlesByAuthor(userId, opts);
    const author = await this.buildAuthor(userId);
    const items = rows.map((r) => this.summary(r, author));
    const nextCursor = rows.length === (opts?.limit ?? 20) && rows.length > 0
      ? rows[rows.length - 1].published_at
      : null;
    return { items, nextCursor };
  }

  async createArticle(userId: string, input: {
    kind?: CommunityKind;
    title: string;
    body: string;
    excerpt?: string;
    section?: string;
    tags?: string[];
  }): Promise<CommunityArticleView> {
    if (!input.title?.trim()) throw new CommunityServiceError("Title is required", 400, "INVALID_TITLE");
    if (!input.body?.trim()) throw new CommunityServiceError("Body is required", 400, "INVALID_BODY");
    const kind = this.normalizeKind(input.kind);
    if (kind === "announcement") await this.requireAdmin(userId);
    await this.requirePublicNickname(userId);
    const row = await this.db.createCommunityArticle({
      authorId: userId,
      title: input.title.trim(),
      body: input.body,
      excerpt: input.excerpt?.trim() || undefined,
      section: input.section || (kind === "announcement" ? "announcements" : "tools"),
      tags: input.tags ?? [],
      kind,
      feedbackStatus: this.defaultFeedbackStatus(kind),
      commentsEnabled: kind !== "announcement",
    });
    const author = await this.buildAuthor(userId);
    return this.articleView(row, author);
  }

  async updateArticle(userId: string, articleId: string, input: {
    title?: string; body?: string; excerpt?: string; section?: string; tags?: string[];
  }): Promise<void> {
    const row = await this.db.getCommunityArticle(articleId);
    if (!row) throw new CommunityServiceError("Article not found", 404, "ARTICLE_NOT_FOUND");
    if (row.author_id !== userId) throw new CommunityServiceError("Not the author", 403, "NOT_AUTHOR");
    await this.db.updateCommunityArticle(articleId, input);
  }

  async publishArticle(userId: string, articleId: string): Promise<void> {
    const row = await this.db.getCommunityArticle(articleId);
    if (!row) throw new CommunityServiceError("Article not found", 404, "ARTICLE_NOT_FOUND");
    if (row.author_id !== userId) throw new CommunityServiceError("Not the author", 403, "NOT_AUTHOR");
    await this.db.publishCommunityArticle(articleId);
  }

  async deleteArticle(userId: string, articleId: string): Promise<void> {
    const row = await this.db.getCommunityArticle(articleId);
    if (!row) throw new CommunityServiceError("Article not found", 404, "ARTICLE_NOT_FOUND");
    if (row.author_id !== userId) throw new CommunityServiceError("Not the author", 403, "NOT_AUTHOR");
    await this.db.softDeleteCommunityArticle(articleId);
  }

  async setFeatured(userId: string, articleId: string, featured: boolean): Promise<void> {
    await this.requireAdmin(userId);
    await this.db.setCommunityArticleFeatured(articleId, featured);
  }

  async hideArticle(userId: string, articleId: string): Promise<void> {
    await this.requireAdmin(userId);
    await this.db.hideCommunityArticle(articleId);
  }

  async updateFeedbackStatus(userId: string, articleId: string, feedbackStatus: CommunityFeedbackStatus): Promise<void> {
    await this.requireAdmin(userId);
    const row = await this.db.getCommunityArticle(articleId);
    if (!row) throw new CommunityServiceError("Article not found", 404, "ARTICLE_NOT_FOUND");
    const kind = row.kind;
    if (kind !== "bug" && kind !== "feature_request") {
      throw new CommunityServiceError("Feedback status is only valid for feedback content", 400, "INVALID_FEEDBACK_STATUS");
    }
    if (!feedbackStatusByKind[kind].has(feedbackStatus)) {
      throw new CommunityServiceError("Invalid feedback status", 400, "INVALID_FEEDBACK_STATUS");
    }
    await this.db.updateCommunityFeedbackStatus(articleId, feedbackStatus);
  }

  async listMyFeedback(userId: string): Promise<{ items: CommunityArticleSummary[] }> {
    const rows = await this.db.listCommunityFeedbackByAuthor(userId);
    const authorMap = new Map<string, CommunityAuthorView>();
    for (const authorId of [...new Set(rows.map((row) => row.author_id))]) {
      authorMap.set(authorId, await this.buildAuthor(authorId));
    }
    return { items: rows.map((row) => this.summary(row, authorMap.get(row.author_id)!)) };
  }

  async createComment(userId: string, input: {
    articleId: string; body: string; rootId?: string; replyToUserId?: string;
  }): Promise<CommunityCommentView> {
    if (!input.body?.trim()) throw new CommunityServiceError("Comment body is required", 400, "INVALID_BODY");
    const article = await this.requirePublishedArticle(input.articleId);
    if (article.comments_enabled === false) {
      throw new CommunityServiceError("Comments are disabled", 400, "COMMENTS_DISABLED");
    }
    if (input.rootId) {
      const root = await this.requireVisibleComment(input.rootId);
      if (root.article_id !== input.articleId || root.root_id) {
        throw new CommunityServiceError("Invalid comment thread", 400, "INVALID_COMMENT_THREAD");
      }
    }
    await this.requirePublicNickname(userId);
    const row = await this.db.createCommunityComment({
      articleId: input.articleId,
      authorId: userId,
      body: input.body.trim(),
      rootId: input.rootId,
      replyToUserId: input.replyToUserId,
    });
    const author = await this.buildAuthor(userId);
    return {
      id: row.id, articleId: row.article_id, author, rootId: row.root_id,
      replyToUserId: row.reply_to_user_id, body: row.body, likeCount: row.like_count,
      status: row.status, createdAt: row.created_at,
    };
  }

  async deleteComment(userId: string, commentId: string): Promise<void> {
    const row = await this.db.getCommunityComment(commentId);
    if (!row) throw new CommunityServiceError("Comment not found", 404, "COMMENT_NOT_FOUND");
    if (row.author_id !== userId) throw new CommunityServiceError("Not the author", 403, "NOT_AUTHOR");
    await this.db.softDeleteCommunityComment(commentId);
  }

  async toggleLike(userId: string, articleId: string, on: boolean): Promise<void> {
    if (on) await this.requirePublishedArticle(articleId);
    await this.db.toggleCommunityArticleLike(articleId, userId, on);
  }

  async toggleBookmark(userId: string, articleId: string, on: boolean): Promise<void> {
    if (on) await this.requirePublishedArticle(articleId);
    await this.db.toggleCommunityBookmark(articleId, userId, on);
  }

  async toggleCommentLike(userId: string, commentId: string, on: boolean): Promise<void> {
    if (on) {
      const comment = await this.requireVisibleComment(commentId);
      await this.requirePublishedArticle(comment.article_id);
    }
    await this.db.toggleCommunityCommentLike(commentId, userId, on);
  }

  async toggleFollow(userId: string, targetUserId: string, on: boolean): Promise<void> {
    if (userId === targetUserId) throw new CommunityServiceError("Cannot follow yourself", 400, "SELF_FOLLOW");
    await this.db.toggleCommunityFollow(userId, targetUserId, on);
  }

  async getInteractions(userId: string, articleIds: string[]): Promise<Record<string, { liked: boolean; bookmarked: boolean }>> {
    return this.db.getCommunityInteractions(userId, articleIds);
  }

  async getFollowingState(userId: string, targetUserId: string): Promise<boolean> {
    return this.db.isFollowing(userId, targetUserId);
  }
}
