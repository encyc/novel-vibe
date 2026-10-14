import type {
  ChatStreamEvent,
  ChatSession,
  CursorPage,
  DocumentIndex,
  DocumentDiffPage,
  DocumentSaveResult,
  DocumentSource,
  DocumentVersionSummary,
  Project,
  SessionMessage,
  SessionPage,
  User,
  UserProfile,
  CreditSummary,
  CreditActivityDay,
  CreditTransaction,
  CreditPackage,
  MembershipPlan,
  MembershipStatus,
  MembershipEntitlement,
  ReferralPreview,
  ReferralDashboard,
  ReferralAdminMetrics,
  ReferralAdminBinding,
  AiModel,
  PurchaseStatus,
  InstalledSkill,
  SkillDraft,
  SkillReview,
  SkillRole,
  SkillVersionSummary,
  WorkspaceSkill,
  CommunityArticlePage,
  CommunityArticleDetail,
  CommunityComment,
  CommunityAuthorProfile,
  CommunitySectionMeta,
  CommunityInteractions,
  CommunityKind,
  CommunityFeedbackStatus,
  CommunitySort,
  CommunityFeedbackPage,
  DelegationTranscriptEntry,
} from "../types";

import type { ApiRequestContext } from "./context.js";

export function listCommunityArticles(client: ApiRequestContext, opts?: {
    kind?: CommunityKind; section?: string; tag?: string; authorId?: string;
    sort?: CommunitySort; search?: string; featured?: boolean; cursor?: string; limit?: number;
  }): Promise<CommunityArticlePage> {
    const params = new URLSearchParams();
    if (opts?.kind) params.set("kind", opts.kind);
    if (opts?.section) params.set("section", opts.section);
    if (opts?.tag) params.set("tag", opts.tag);
    if (opts?.authorId) params.set("author_id", opts.authorId);
    if (opts?.sort) params.set("sort", opts.sort);
    if (opts?.search) params.set("search", opts.search);
    if (opts?.featured) params.set("featured", "true");
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.limit) params.set("limit", String(opts.limit));
    return client.request(`/api/community/articles?${params}`);
  
}

export function listFollowingArticles(client: ApiRequestContext, opts?: { sort?: "latest" | "popular"; cursor?: string; limit?: number }): Promise<CommunityArticlePage> {
    const params = new URLSearchParams();
    if (opts?.sort) params.set("sort", opts.sort);
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.limit) params.set("limit", String(opts.limit));
    return client.request(`/api/community/articles/following?${params}`);
  
}

export function getCommunityArticle(client: ApiRequestContext, id: string): Promise<{ article: CommunityArticleDetail }> {
    return client.request(`/api/community/articles/${encodeURIComponent(id)}`);
  
}

export function listCommunityComments(client: ApiRequestContext, articleId: string): Promise<{ comments: CommunityComment[] }> {
    return client.request(`/api/community/articles/${encodeURIComponent(articleId)}/comments`);
  
}

export function getCommunityAuthorProfile(client: ApiRequestContext, userId: string): Promise<{ profile: CommunityAuthorProfile }> {
    return client.request(`/api/community/users/${encodeURIComponent(userId)}/profile`);
  
}

export function listCommunityArticlesByAuthor(client: ApiRequestContext, userId: string, opts?: { cursor?: string; limit?: number }): Promise<CommunityArticlePage> {
    const params = new URLSearchParams();
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.limit) params.set("limit", String(opts.limit));
    return client.request(`/api/community/users/${encodeURIComponent(userId)}/articles?${params}`);
  
}

export function getCommunitySections(client: ApiRequestContext): Promise<{ sections: CommunitySectionMeta[] }> {
    return client.request("/api/community/sections");
  
}

export function getCommunityInteractions(client: ApiRequestContext, articleIds: string[]): Promise<{ interactions: CommunityInteractions }> {
    const params = new URLSearchParams({ ids: articleIds.join(",") });
    return client.request(`/api/community/me/interactions?${params}`);
  
}

export function getCommunityFollowingState(client: ApiRequestContext, userId: string): Promise<{ following: boolean }> {
    return client.request(`/api/community/users/${encodeURIComponent(userId)}/following-state`);
  
}

export function createCommunityArticle(client: ApiRequestContext, input: { kind?: CommunityKind; title: string; body: string; excerpt?: string; section?: string; tags?: string[] }): Promise<{ article: CommunityArticleDetail }> {
    return client.request("/api/community/articles", { method: "POST", body: JSON.stringify(input) });
  
}

export function updateCommunityArticle(client: ApiRequestContext, id: string, input: Partial<{ title: string; body: string; excerpt: string; section: string; tags: string[] }>): Promise<void> {
    return client.request(`/api/community/articles/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
  
}

export function publishCommunityArticle(client: ApiRequestContext, id: string): Promise<void> {
    return client.request(`/api/community/articles/${encodeURIComponent(id)}/publish`, { method: "POST" });
  
}

export function deleteCommunityArticle(client: ApiRequestContext, id: string): Promise<void> {
    return client.request(`/api/community/articles/${encodeURIComponent(id)}`, { method: "DELETE" });
  
}

export function setCommunityArticleFeatured(client: ApiRequestContext, id: string, featured: boolean): Promise<void> {
    return client.request(`/api/community/articles/${encodeURIComponent(id)}/feature`, { method: featured ? "POST" : "DELETE" });
  
}

export function hideCommunityArticle(client: ApiRequestContext, id: string): Promise<void> {
    return client.request(`/api/community/articles/${encodeURIComponent(id)}/hide`, { method: "POST" });
  
}

export function updateCommunityFeedbackStatus(client: ApiRequestContext, id: string, feedbackStatus: CommunityFeedbackStatus): Promise<void> {
    return client.request(`/api/community/articles/${encodeURIComponent(id)}/feedback-status`, {
      method: "PATCH",
      body: JSON.stringify({ feedbackStatus }),
    });
  
}

export function listMyCommunityFeedback(client: ApiRequestContext): Promise<CommunityFeedbackPage> {
    return client.request("/api/community/me/feedback");
  
}

export function likeCommunityArticle(client: ApiRequestContext, id: string): Promise<void> {
    return client.request(`/api/community/articles/${encodeURIComponent(id)}/like`, { method: "POST" });
  
}

export function unlikeCommunityArticle(client: ApiRequestContext, id: string): Promise<void> {
    return client.request(`/api/community/articles/${encodeURIComponent(id)}/like`, { method: "DELETE" });
  
}

export function bookmarkCommunityArticle(client: ApiRequestContext, id: string): Promise<void> {
    return client.request(`/api/community/articles/${encodeURIComponent(id)}/bookmark`, { method: "POST" });
  
}

export function unbookmarkCommunityArticle(client: ApiRequestContext, id: string): Promise<void> {
    return client.request(`/api/community/articles/${encodeURIComponent(id)}/bookmark`, { method: "DELETE" });
  
}

export function createCommunityComment(client: ApiRequestContext, articleId: string, input: { body: string; rootId?: string; replyToUserId?: string }): Promise<{ comment: CommunityComment }> {
    return client.request(`/api/community/articles/${encodeURIComponent(articleId)}/comments`, { method: "POST", body: JSON.stringify(input) });
  
}

export function deleteCommunityComment(client: ApiRequestContext, commentId: string): Promise<void> {
    return client.request(`/api/community/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" });
  
}

export function likeCommunityComment(client: ApiRequestContext, commentId: string): Promise<void> {
    return client.request(`/api/community/comments/${encodeURIComponent(commentId)}/like`, { method: "POST" });
  
}

export function unlikeCommunityComment(client: ApiRequestContext, commentId: string): Promise<void> {
    return client.request(`/api/community/comments/${encodeURIComponent(commentId)}/like`, { method: "DELETE" });
  
}

export function followUser(client: ApiRequestContext, userId: string): Promise<void> {
    return client.request(`/api/community/users/${encodeURIComponent(userId)}/follow`, { method: "POST" });
  
}

export function unfollowUser(client: ApiRequestContext, userId: string): Promise<void> {
    return client.request(`/api/community/users/${encodeURIComponent(userId)}/follow`, { method: "DELETE" });
  
}
