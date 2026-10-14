/**
 * NovelApiClient is a facade over the domain modules in ./api/<domain>.ts.
 * Connection plumbing (request/response handling, error types) lives in
 * ./http.ts; domain calls receive the ApiRequestContext implemented here.
 */

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
import { detectBrowserLocale, readStoredLocale } from "../i18n/locale";
import { ApiError, ChatStreamInterruptedError, interfaceLocaleHeaders, parseResponse } from "./http.js";
import { getMode, type ServerMode } from "./mode.js";
import type { ByokConfig, UserLlmKey } from "./settings.js";
import {
  me,
  login,
  sendRegistrationCode,
  verifyRegistrationCode,
  signup,
  logout,
  getProfile,
  updateProfile,
  listApiTokens,
  createApiToken,
  revokeApiToken,
  uploadAvatar,
} from "./auth.js";
import {
  getCreditSummary,
  getCreditActivity,
  listCreditTransactions,
  listCreditPackages,
  listModels,
  createCreditPurchase,
  getCreditPurchase,
} from "./credits.js";
import {
  getMembershipPlans,
  getMembershipStatus,
  getMembershipEntitlements,
  createMembershipPurchase,
  getMembershipPurchase,
} from "./membership.js";
import {
  getByokConfig,
  listLlmKeys,
  saveLlmKey,
  deleteLlmKey,
} from "./settings.js";
import {
  getReferralPreview,
  getReferralDashboard,
  getReferralAdminMetrics,
  updateReferralCampaign,
  listReferralAdminBindings,
  reviewReferralBinding,
} from "./referral.js";
import {
  listProjects,
  getProject,
  updateProject,
  permanentlyDeleteProject,
  runProjectCommand,
  archiveProject,
  trashProject,
  restoreProject,
  createProject,
} from "./projects.js";
import {
  listSkills,
  createSkillDraft,
  getSkillDraft,
  reviewSkillDraft,
  confirmSkillDraft,
  cancelSkillDraft,
  listSkillVersions,
  revertSkill,
  listWorkspaceSkills,
  toggleWorkspaceSkill,
} from "./skills.js";
import {
  listDocuments,
  readDocument,
  saveDocument,
  listDocumentVersions,
  getDocumentVersion,
  getDocumentVersionDiff,
  deleteDocument,
  exportDocument,
} from "./documents.js";
import {
  listSessions,
  createSession,
  listSessionMessages,
  listDelegationMessages,
  openSession,
  renameSession,
  archiveSession,
  restoreSession,
  deleteSession,
  interruptSession,
} from "./sessions.js";
import {
  streamChat,
} from "./chat.js";
import {
  listCommunityArticles,
  listFollowingArticles,
  getCommunityArticle,
  listCommunityComments,
  getCommunityAuthorProfile,
  listCommunityArticlesByAuthor,
  getCommunitySections,
  getCommunityInteractions,
  getCommunityFollowingState,
  createCommunityArticle,
  updateCommunityArticle,
  publishCommunityArticle,
  deleteCommunityArticle,
  setCommunityArticleFeatured,
  hideCommunityArticle,
  updateCommunityFeedbackStatus,
  listMyCommunityFeedback,
  likeCommunityArticle,
  unlikeCommunityArticle,
  bookmarkCommunityArticle,
  unbookmarkCommunityArticle,
  createCommunityComment,
  deleteCommunityComment,
  likeCommunityComment,
  unlikeCommunityComment,
  followUser,
  unfollowUser,
} from "./community.js";

export { ApiError, ChatStreamInterruptedError } from "./http.js";
export type { ApiTokenScope, ApiTokenPreset, ApiTokenLifetimeDays, ApiTokenSummary, CreatedApiToken } from "./auth.js";
import type { ApiTokenScope, ApiTokenPreset, ApiTokenLifetimeDays, ApiTokenSummary, CreatedApiToken } from "./auth.js";

export class NovelApiClient {
async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = interfaceLocaleHeaders(init.headers);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await fetch(path, {
      ...init,
      headers,
      credentials: "same-origin",
    });

    return parseResponse<T>(res);
  }

  async me(): Promise<User | null> {
    return me(this);
  }

  /** Deployment profile reported by the BFF (local-first vs hosted). */
  getMode(): Promise<ServerMode> {
    return getMode(this);
  }

  async login(email: string, password: string, mode: "login" | "signup"): Promise<void> {
    return login(this, email, password, mode);
  }

  sendRegistrationCode(email: string, inviteCode?: string): Promise<{ accepted: true; retryAfterSeconds: number }> {
    return sendRegistrationCode(this, email, inviteCode);
  }

  verifyRegistrationCode(email: string, code: string, inviteCode?: string): Promise<{ ticket: string; expiresInSeconds: number }> {
    return verifyRegistrationCode(this, email, code, inviteCode);
  }

  async signup(email: string, password: string, registrationTicket: string, inviteCode?: string): Promise<void> {
    return signup(this, email, password, registrationTicket, inviteCode);
  }

  async logout(): Promise<void> {
    return logout(this);
  }

  getProfile(): Promise<UserProfile> {
    return getProfile(this);
  }

  updateProfile(input: {
    displayName?: string;
    locale?: UserProfile["locale"];
  }): Promise<UserProfile> {
    return updateProfile(this, input);
  }

  async listApiTokens(): Promise<ApiTokenSummary[]> {
    return listApiTokens(this);
  }

  createApiToken(input: {
    name: string;
    lifetimeDays: ApiTokenLifetimeDays;
    presets: ApiTokenPreset[];
  }): Promise<CreatedApiToken> {
    return createApiToken(this, input);
  }

  revokeApiToken(tokenId: string): Promise<{ ok: true }> {
    return revokeApiToken(this, tokenId);
  }

  async uploadAvatar(file: File): Promise<UserProfile> {
    return uploadAvatar(this, file);
  }

  getCreditSummary(): Promise<CreditSummary> {
    return getCreditSummary(this);
  }

  async getCreditActivity(year: number, timezone: string): Promise<CreditActivityDay[]> {
    return getCreditActivity(this, year, timezone);
  }

  listCreditTransactions(type: "consume" | "topup" | "grant", cursor?: string, limit = 20): Promise<CursorPage<CreditTransaction>> {
    return listCreditTransactions(this, type, cursor, limit);
  }

  async listCreditPackages(): Promise<CreditPackage[]> {
    return listCreditPackages(this);
  }

  async listModels(): Promise<AiModel[]> {
    return listModels(this);
  }

  createCreditPurchase(packageId: string): Promise<{ orderNo: string; payUrl: string }> {
    return createCreditPurchase(this, packageId);
  }

  getCreditPurchase(orderNo: string): Promise<{ orderNo: string; status: PurchaseStatus }> {
    return getCreditPurchase(this, orderNo);
  }

  async getMembershipPlans(): Promise<MembershipPlan[]> {
    return getMembershipPlans(this);
  }

  getMembershipStatus(): Promise<MembershipStatus> {
    return getMembershipStatus(this);
  }

  async getMembershipEntitlements(): Promise<{ catalog: MembershipEntitlement[]; premiumModels: string[] }> {
    return getMembershipEntitlements(this);
  }

  createMembershipPurchase(planId: string): Promise<{ orderNo: string; payUrl: string }> {
    return createMembershipPurchase(this, planId);
  }

  getMembershipPurchase(orderNo: string): Promise<{ orderNo: string; status: PurchaseStatus }> {
    return getMembershipPurchase(this, orderNo);
  }

  getByokConfig(): Promise<ByokConfig> {
    return getByokConfig(this);
  }

  listLlmKeys(): Promise<{ keys: UserLlmKey[] }> {
    return listLlmKeys(this);
  }

  saveLlmKey(provider: string, apiKey: string): Promise<{ key: UserLlmKey }> {
    return saveLlmKey(this, provider, apiKey);
  }

  deleteLlmKey(provider: string): Promise<{ revoked: boolean }> {
    return deleteLlmKey(this, provider);
  }

  getReferralPreview(code: string): Promise<ReferralPreview> {
    return getReferralPreview(this, code);
  }

  getReferralDashboard(): Promise<ReferralDashboard> {
    return getReferralDashboard(this);
  }

  getReferralAdminMetrics(): Promise<ReferralAdminMetrics> {
    return getReferralAdminMetrics(this);
  }

  updateReferralCampaign(input: { bindingEndsAt: string; reason: string }): Promise<{ campaign: ReferralAdminMetrics["campaign"] }> {
    return updateReferralCampaign(this, input);
  }

  async listReferralAdminBindings(input: { search?: string; cursor?: string; limit?: number } = {}): Promise<ReferralAdminBinding[]> {
    return listReferralAdminBindings(this, input);
  }

  reviewReferralBinding(id: string, decision: "approve" | "reject", reason: string) {
    return reviewReferralBinding(this, id, decision, reason);
  }

  async listProjects(status?: "active" | "archived" | "trash"): Promise<Project[]> {
    return listProjects(this, status);
  }

  async getProject(projectId: string): Promise<Project> {
    return getProject(this, projectId);
  }

  async updateProject(projectId: string, patch: {
    title?: string;
    genre?: string | null;
    synopsis?: string | null;
    writing_stage?: Project["writing_stage"];
    creative_language?: Project["creative_language"];
  }): Promise<Project> {
    return updateProject(this, projectId, patch);
  }

  async permanentlyDeleteProject(projectId: string): Promise<{ jobId: string; status: "pending" }> {
    return permanentlyDeleteProject(this, projectId);
  }

  async runProjectCommand(projectId: string, command: "archive" | "trash" | "restore"): Promise<Project> {
    return runProjectCommand(this, projectId, command);
  }

  archiveProject(projectId: string): Promise<Project> {
    return archiveProject(this, projectId);
  }

  trashProject(projectId: string): Promise<Project> {
    return trashProject(this, projectId);
  }

  restoreProject(projectId: string): Promise<Project> {
    return restoreProject(this, projectId);
  }

  async createProject(input: {
    title: string;
    genre?: string;
    synopsis?: string;
    creative_language: Project["creative_language"];
  }): Promise<Project> {
    return createProject(this, input);
  }

  async listSkills(): Promise<InstalledSkill[]> {
    return listSkills(this);
  }

  async createSkillDraft(input: {
    source: "upload" | "paste" | "skill_creator";
    slug: string;
    content: string;
    roles: SkillRole[];
    filename?: string;
    session_id?: string;
  }): Promise<SkillDraft> {
    return createSkillDraft(this, input);
  }

  async getSkillDraft(draftId: string): Promise<SkillDraft> {
    return getSkillDraft(this, draftId);
  }

  async reviewSkillDraft(draftId: string, version: number): Promise<{ draft: SkillDraft; review: SkillReview }> {
    return reviewSkillDraft(this, draftId, version);
  }

  async confirmSkillDraft(draftId: string, input: {
    version: number; reviewId: string; candidateHash: string; idempotencyKey: string;
  }): Promise<InstalledSkill> {
    return confirmSkillDraft(this, draftId, input);
  }

  async cancelSkillDraft(draftId: string): Promise<SkillDraft> {
    return cancelSkillDraft(this, draftId);
  }

  async listSkillVersions(slug: string): Promise<SkillVersionSummary[]> {
    return listSkillVersions(this, slug);
  }

  async revertSkill(slug: string, versionNumber: number): Promise<void> {
    return revertSkill(this, slug, versionNumber);
  }

  async listWorkspaceSkills(workspaceId: string): Promise<WorkspaceSkill[]> {
    return listWorkspaceSkills(this, workspaceId);
  }

  async toggleWorkspaceSkill(workspaceId: string, slug: string, enabled: boolean): Promise<void> {
    return toggleWorkspaceSkill(this, workspaceId, slug, enabled);
  }

  async listDocuments(projectId: string, type?: string): Promise<DocumentIndex[]> {
    return listDocuments(this, projectId, type);
  }

  async readDocument(projectId: string, path: string): Promise<DocumentSource> {
    return readDocument(this, projectId, path);
  }

  async saveDocument(projectId: string, path: string, content: string, baseHash: string): Promise<DocumentSaveResult> {
    return saveDocument(this, projectId, path, content, baseHash);
  }

  async listDocumentVersions(projectId: string, path: string, cursor: string | null = null, limit = 20): Promise<CursorPage<DocumentVersionSummary>> {
    return listDocumentVersions(this, projectId, path, cursor, limit);
  }

  async getDocumentVersion(versionId: string): Promise<DocumentVersionSummary> {
    return getDocumentVersion(this, versionId);
  }

  async getDocumentVersionDiff(versionId: string, cursor: string | null = null, limit = 20): Promise<DocumentDiffPage> {
    return getDocumentVersionDiff(this, versionId, cursor, limit);
  }

  async deleteDocument(projectId: string, path: string): Promise<void> {
    return deleteDocument(this, projectId, path);
  }

  async exportDocument(projectId: string, path: string, format: string): Promise<void> {
    return exportDocument(this, projectId, path, format);
  }

  async listSessions(projectId: string, options: { cursor?: string; limit?: number; search?: string; status?: "active" | "archived" } = {}): Promise<SessionPage> {
    return listSessions(this, projectId, options);
  }

  async createSession(projectId: string): Promise<ChatSession> {
    return createSession(this, projectId);
  }

  async listSessionMessages(sessionId: string, options: { cursor?: string; limit?: number } = {}): Promise<CursorPage<SessionMessage>> {
    return listSessionMessages(this, sessionId, options);
  }

  async listDelegationMessages(sessionId: string, callId: string, options: { cursor?: string; limit?: number } = {}): Promise<CursorPage<DelegationTranscriptEntry>> {
    return listDelegationMessages(this, sessionId, callId, options);
  }

  async openSession(sessionId: string): Promise<ChatSession> {
    return openSession(this, sessionId);
  }

  async renameSession(sessionId: string, title: string): Promise<ChatSession> {
    return renameSession(this, sessionId, title);
  }

  async archiveSession(sessionId: string): Promise<ChatSession> {
    return archiveSession(this, sessionId);
  }

  async restoreSession(sessionId: string): Promise<ChatSession> {
    return restoreSession(this, sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    return deleteSession(this, sessionId);
  }

  interruptSession(sessionId: string): Promise<{ interrupted: boolean }> {
    return interruptSession(this, sessionId);
  }

  async streamChat(input: {
      projectId: string;
      message?: string;
      sessionId: string;
      interactionResponse?: import("../types").InteractionResponseV1;
      activeDocumentPath?: string;
      command?: "skill-creator" | "lingqi";
      provider?: string;
      model?: string;
    }, onEvent: (event: ChatStreamEvent) => void, options: { signal?: AbortSignal } = {}): Promise<{ turnId: string | null; assistantMessageId: string | null }> {
    return streamChat(this, input, onEvent, options);
  }

  listCommunityArticles(opts?: {
    kind?: CommunityKind; section?: string; tag?: string; authorId?: string;
    sort?: CommunitySort; search?: string; featured?: boolean; cursor?: string; limit?: number;
  }): Promise<CommunityArticlePage> {
    return listCommunityArticles(this, opts);
  }

  listFollowingArticles(opts?: { sort?: "latest" | "popular"; cursor?: string; limit?: number }): Promise<CommunityArticlePage> {
    return listFollowingArticles(this, opts);
  }

  getCommunityArticle(id: string): Promise<{ article: CommunityArticleDetail }> {
    return getCommunityArticle(this, id);
  }

  listCommunityComments(articleId: string): Promise<{ comments: CommunityComment[] }> {
    return listCommunityComments(this, articleId);
  }

  getCommunityAuthorProfile(userId: string): Promise<{ profile: CommunityAuthorProfile }> {
    return getCommunityAuthorProfile(this, userId);
  }

  listCommunityArticlesByAuthor(userId: string, opts?: { cursor?: string; limit?: number }): Promise<CommunityArticlePage> {
    return listCommunityArticlesByAuthor(this, userId, opts);
  }

  getCommunitySections(): Promise<{ sections: CommunitySectionMeta[] }> {
    return getCommunitySections(this);
  }

  getCommunityInteractions(articleIds: string[]): Promise<{ interactions: CommunityInteractions }> {
    return getCommunityInteractions(this, articleIds);
  }

  getCommunityFollowingState(userId: string): Promise<{ following: boolean }> {
    return getCommunityFollowingState(this, userId);
  }

  createCommunityArticle(input: { kind?: CommunityKind; title: string; body: string; excerpt?: string; section?: string; tags?: string[] }): Promise<{ article: CommunityArticleDetail }> {
    return createCommunityArticle(this, input);
  }

  updateCommunityArticle(id: string, input: Partial<{ title: string; body: string; excerpt: string; section: string; tags: string[] }>): Promise<void> {
    return updateCommunityArticle(this, id, input);
  }

  publishCommunityArticle(id: string): Promise<void> {
    return publishCommunityArticle(this, id);
  }

  deleteCommunityArticle(id: string): Promise<void> {
    return deleteCommunityArticle(this, id);
  }

  setCommunityArticleFeatured(id: string, featured: boolean): Promise<void> {
    return setCommunityArticleFeatured(this, id, featured);
  }

  hideCommunityArticle(id: string): Promise<void> {
    return hideCommunityArticle(this, id);
  }

  updateCommunityFeedbackStatus(id: string, feedbackStatus: CommunityFeedbackStatus): Promise<void> {
    return updateCommunityFeedbackStatus(this, id, feedbackStatus);
  }

  listMyCommunityFeedback(): Promise<CommunityFeedbackPage> {
    return listMyCommunityFeedback(this);
  }

  likeCommunityArticle(id: string): Promise<void> {
    return likeCommunityArticle(this, id);
  }

  unlikeCommunityArticle(id: string): Promise<void> {
    return unlikeCommunityArticle(this, id);
  }

  bookmarkCommunityArticle(id: string): Promise<void> {
    return bookmarkCommunityArticle(this, id);
  }

  unbookmarkCommunityArticle(id: string): Promise<void> {
    return unbookmarkCommunityArticle(this, id);
  }

  createCommunityComment(articleId: string, input: { body: string; rootId?: string; replyToUserId?: string }): Promise<{ comment: CommunityComment }> {
    return createCommunityComment(this, articleId, input);
  }

  deleteCommunityComment(commentId: string): Promise<void> {
    return deleteCommunityComment(this, commentId);
  }

  likeCommunityComment(commentId: string): Promise<void> {
    return likeCommunityComment(this, commentId);
  }

  unlikeCommunityComment(commentId: string): Promise<void> {
    return unlikeCommunityComment(this, commentId);
  }

  followUser(userId: string): Promise<void> {
    return followUser(this, userId);
  }

  unfollowUser(userId: string): Promise<void> {
    return unfollowUser(this, userId);
  }
}

export const api = new NovelApiClient();
