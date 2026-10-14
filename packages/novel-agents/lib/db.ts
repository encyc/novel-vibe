/**
 * Database client using PostgREST for CRUD operations.
 * User mode forwards the verified InsForge JWT so PostgREST can enforce RLS.
 * System mode mints a postgres-role JWT for workers and other trusted jobs.
 *
 * DbClient is a facade: connection plumbing lives here; domain queries live in
 * ./db/<domain>.ts and receive the DbRequestContext implemented by this class.
 */

import type { AgentId, MemoryJobRow, SessionMessageRow, SessionRow } from "../session/types.js";
import type {
  ProjectDeletionEnqueueResult,
  ProjectLifecycleCommand,
  ProjectLifecycleStatus,
  ProjectRow,
  ProjectTransitionResult,
} from "../project/types.js";
import type { ProjectDeletionJob } from "../project/deletion-worker.js";
import type {
  ClaimDocumentWriteInput,
  CompleteDocumentWriteInput,
  DocumentVersionDataSource,
} from "../document-version/repository.js";
import type { SupportedLanguage } from "./language.js";
import type {
  InteractionRpcResult,
  SessionInteractionRow,
} from "../interactions/repository.js";
import type { InteractionResponseV1 } from "../interactions/types.js";
import {
  mapRuntimeModelRow,
  type DisableRuntimeModelInput,
  type RuntimeModelApiRow,
  type RuntimeModelRow,
} from "../model-runtime/types.js";
import { generateStorageToken, generateToken } from "./db/context.js";
import type { DbRequestContext } from "./db/context.js";
import type { UserProfileRow } from "./db/users.js";
import type { CreditActivityRow, CreditTransactionCursorRow } from "./db/credits.js";
import type { CommunityKind, CommunityFeedbackStatus, CommunityArticleRow, CommunityCommentRow, CommunityAuthorProfileRow } from "./db/community.js";
import {
  upsertDocumentIndex,
  listDocuments,
  getDocument,
  updateDocumentStatus,
  deleteDocument,
  deleteForeshadow,
  claimDocumentWrite,
  completeDocumentWrite,
  failDocumentWrite,
  listDocumentVersions,
  getDocumentVersion,
  getDocumentVersionDiff,
  claimDocumentVersionRepairs,
  upsertForeshadow,
  listForeshadows,
} from "./db/documents.js";
import {
  createProject,
  getProject,
  updateProject,
  transitionProjectLifecycle,
  enqueueProjectDeletion,
  claimProjectDeletionJobs,
  freezeProjectForDeletion,
  patchProjectDeletionJob,
  purgeProjectDatabase,
  listProjects,
  createTask,
  updateTaskStatus,
  listTasks,
  ownsProject,
  countProjectsByOwner,
} from "./db/projects.js";
import {
  enqueueContinuityJob,
  claimContinuityJobs,
  completeContinuityJob,
  retryContinuityJob,
  failContinuityJob,
} from "./db/continuity.js";
import {
  listProjectSessionIds,
  createSession,
  listSessions,
  updateSession,
  addMessage,
  deleteSession,
  getOwnedSessionRow,
  listSessionRows,
  getActiveSessionId,
  insertSessionRow,
  patchSessionRow,
  deleteSessionRow,
  insertSessionInteractionRow,
  getSessionInteractionRow,
  listSessionInteractionRows,
  respondToSessionInteraction,
  listDisplayMessageRows,
  listAgentMessageRows,
  listDelegationMessageRows,
  insertSessionMessageRow,
  patchSessionMessageRow,
  acquireSessionLease,
  releaseSessionLease,
  releaseStaleLeases,
  insertMemoryJobRow,
  claimMemoryJobRows,
  patchMemoryJobRow,
  listMemoryExclusionRows,
  insertMemoryExclusionRows,
  getAgentStateRow,
  upsertAgentStateRow,
  prepareSessionMemoryDelete,
} from "./db/sessions.js";
import {
  getLevelConfig,
  listLevelConfigs,
  recalcUserLevel,
  getUserProfile,
  upsertUserProfile,
  ensureUserRow,
} from "./db/users.js";
import {
  getActiveAgentResource,
  getNextAgentResourceVersion,
  publishAgentResourceVersion,
  activateAgentResourceVersion,
} from "./db/agent-resources.js";
import {
  listSkillRegistry,
  getSkillRegistrySource,
  getSkillFromRegistry,
  getSkillForUser,
  installSkill,
  createSkillDraft,
  getSkillDraft,
  updateSkillDraft,
  createSkillReview,
  getSkillReview,
  findSkillConfirmation,
  listSkillRoles,
  installReviewedSkill,
  quarantineOutdatedSkills,
  uninstallSkill,
  findInstalledSkillBySlug,
  updateInstalledSkill,
  getNextSkillVersionNumber,
  createSkillVersion,
  listSkillVersions,
  getSkillVersion,
  listWorkspaceSkills,
  getWorkspaceSkill,
  toggleWorkspaceSkill,
} from "./db/skills.js";
import {
  getCreditBalance,
  createCreditBalance,
  topUpCredits,
  deductCreditsAtomic,
  listCreditTransactions,
  listCreditTransactionsCursor,
  insertUsageRecord,
  listUsageRecords,
  getCreditActivity,
  listCreditRates,
  listCreditRateTimeWindows,
  listCreditRateContextTiers,
  upsertCreditRate,
} from "./db/credits.js";
import {
  getRuntimeModel,
  disableRuntimeModel,
} from "./db/model-runtime.js";
import {
  createPurchase,
  getPurchase,
  updatePurchaseCompleted,
  completeCreditPurchase,
  listCreditPackages,
} from "./db/purchases.js";
import {
  listMembershipPlans,
  createMembershipPurchase,
  getMembershipPurchase,
  completeMembershipPurchase,
  getActiveMembership,
  getActiveMembershipUserIds,
} from "./db/membership.js";
import {
  findActiveUserLlmKey,
  listActiveUserLlmKeys,
  revokeUserLlmKey,
  upsertUserLlmKey,
} from "./db/user-llm-keys.js";
import {
  previewReferralCode,
  getReferralDashboard,
  updateReferralCampaign,
  getReferralAdminMetrics,
  listReferralAdminBindings,
  reviewReferralBinding,
} from "./db/referrals.js";
import {
  requestRegistrationCode,
  verifyRegistrationCode,
  reserveRegistrationTicket,
  releaseRegistrationReservation,
  finalizeRegistrationReservation,
} from "./db/registration.js";
import {
  listCommunityArticles,
  listCommunityFolloweeIds,
  isCommunityAdmin,
  getCommunityArticle,
  listCommunityComments,
  getCommunityComment,
  getCommunityAuthorProfile,
  listCommunityArticlesByAuthor,
  listCommunityFeedbackByAuthor,
  createCommunityArticle,
  updateCommunityArticle,
  publishCommunityArticle,
  softDeleteCommunityArticle,
  setCommunityArticleFeatured,
  hideCommunityArticle,
  updateCommunityFeedbackStatus,
  createCommunityComment,
  softDeleteCommunityComment,
  toggleCommunityArticleLike,
  toggleCommunityBookmark,
  toggleCommunityCommentLike,
  toggleCommunityFollow,
  getCommunityInteractions,
  isFollowing,
} from "./db/community.js";

export type { UserProfileRow } from "./db/users.js";
export type { CreditActivityRow, CreditTransactionCursorRow } from "./db/credits.js";
export type { CommunityKind, CommunityFeedbackStatus, CommunityArticleRow, CommunityCommentRow, CommunityAuthorProfileRow } from "./db/community.js";

export class DbClient implements DocumentVersionDataSource, DbRequestContext {
  readonly pgUrl: string;
  readonly apiUrl: string;
  private token: string;
  private tokenExp: number;
  readonly mode: "user" | "system" | "anon";

  private constructor(
    token: string,
    mode: "user" | "system" | "anon",
    options?: { pgUrl?: string; apiUrl?: string },
  ) {
    this.pgUrl = options?.pgUrl ?? process.env.POSTGREST_URL ?? "http://localhost:5430";
    this.apiUrl = options?.apiUrl ?? process.env.INSFORGE_URL ?? "http://localhost:7130";
    this.mode = mode;
    if (mode === "user") {
      if (!token) throw new Error("User access token is required");
      this.token = token;
      this.tokenExp = Number.POSITIVE_INFINITY;
    } else if (mode === "anon") {
      this.token = "";
      this.tokenExp = Number.POSITIVE_INFINITY;
    } else {
      this.token = generateToken();
      this.tokenExp = Math.floor(Date.now() / 1000) + 3500; // refresh 100s before expiry
    }
  }

  static forUser(accessToken: string, options?: { pgUrl?: string; apiUrl?: string }): DbClient {
    return new DbClient(accessToken, "user", options);
  }

  static forSystem(options?: { pgUrl?: string; apiUrl?: string }): DbClient {
    return new DbClient("", "system", options);
  }

  static forAnon(options?: { pgUrl?: string; apiUrl?: string }): DbClient {
    return new DbClient("", "anon", options);
  }

  get pgToken(): string {
    if (this.mode !== "system") {
      throw new Error("System token is unavailable from a user-scoped DbClient");
    }
    this.refreshToken();
    return this.token;
  }

  get storageToken(): string {
    if (this.mode !== "system") {
      throw new Error("Storage system token is unavailable from a user-scoped DbClient");
    }
    return generateStorageToken();
  }

  private refreshToken(): void {
    if (this.mode === "user") return;
    const now = Math.floor(Date.now() / 1000);
    if (now >= this.tokenExp) {
      this.token = generateToken();
      this.tokenExp = now + 3500;
    }
  }

  headers(extra?: Record<string, string>): Record<string, string> {
    this.refreshToken();
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept-Profile": "novel",
      ...extra,
    };
    // anon mode sends no Authorization header so PostgREST uses the anon role
    if (this.mode !== "anon") {
      h["Authorization"] = `Bearer ${this.token}`;
    }
    return h;
  }

  async upsertDocumentIndex(params: {
    projectId: string;
    docPath: string;
    docType: string;
    name?: string;
    status?: string;
    chapterNum?: number;
    volumeNum?: number;
    meta: Record<string, unknown>;
    wordCount?: number;
    checksum?: string;
  }): Promise<void> {
    return upsertDocumentIndex(this, params);
  }

  async listDocuments(projectId: string, docType?: string): Promise<any[]> {
    return listDocuments(this, projectId, docType);
  }

  async getDocument(projectId: string, docPath: string): Promise<any | null> {
    return getDocument(this, projectId, docPath);
  }

  async updateDocumentStatus(projectId: string, docPath: string, status: string): Promise<void> {
    return updateDocumentStatus(this, projectId, docPath, status);
  }

  async deleteDocument(projectId: string, docPath: string): Promise<void> {
    return deleteDocument(this, projectId, docPath);
  }

  async deleteForeshadow(projectId: string, foreshadowId: string): Promise<void> {
    return deleteForeshadow(this, projectId, foreshadowId);
  }

  async listForeshadows(projectId: string): Promise<any[]> {
    return listForeshadows(this, projectId);
  }

  async claimDocumentWrite(input: ClaimDocumentWriteInput): Promise<Record<string, unknown>> {
    return claimDocumentWrite(this, input);
  }

  async completeDocumentWrite(input: CompleteDocumentWriteInput): Promise<Record<string, unknown>> {
    return completeDocumentWrite(this, input);
  }

  async failDocumentWrite(versionId: string, leaseId: string, failureCode: string): Promise<void> {
    return failDocumentWrite(this, versionId, leaseId, failureCode);
  }

  async listDocumentVersions(projectId: string, path: string, beforeVersionNo: number | null, limit: number): Promise<Record<string, unknown>[]> {
    return listDocumentVersions(this, projectId, path, beforeVersionNo, limit);
  }

  async getDocumentVersion(versionId: string, projectId?: string): Promise<Record<string, unknown> | null> {
    return getDocumentVersion(this, versionId, projectId);
  }

  async getDocumentVersionDiff(versionId: string): Promise<Record<string, unknown> | null> {
    return getDocumentVersionDiff(this, versionId);
  }

  async claimDocumentVersionRepairs(now: string, limit: number): Promise<Record<string, unknown>[]> {
    return claimDocumentVersionRepairs(this, now, limit);
  }

  async upsertForeshadow(params: {
    projectId: string;
    foreshadowId: string;
    docPath: string;
    description?: string;
    importance?: number;
    plantChapter?: number;
    plannedResolve?: number;
    actualResolve?: number | null;
    status?: string;
  }): Promise<void> {
    return upsertForeshadow(this, params);
  }

  async createProject(params: {
    ownerId?: string;
    title: string;
    genre?: string;
    synopsis?: string;
    creativeLanguage?: SupportedLanguage;
  }): Promise<ProjectRow> {
    return createProject(this, params);
  }

  async getProject(projectId: string): Promise<ProjectRow | null> {
    return getProject(this, projectId);
  }

  async updateProject(projectId: string, patch: Record<string, unknown>): Promise<ProjectRow | null> {
    return updateProject(this, projectId, patch);
  }

  async transitionProjectLifecycle(projectId: string, command: ProjectLifecycleCommand): Promise<ProjectTransitionResult> {
    return transitionProjectLifecycle(this, projectId, command);
  }

  async enqueueProjectDeletion(projectId: string, requestedBy: string, jobId: string): Promise<ProjectDeletionEnqueueResult> {
    return enqueueProjectDeletion(this, projectId, requestedBy, jobId);
  }

  async claimProjectDeletionJobs(now: string, limit: number): Promise<ProjectDeletionJob[]> {
    return claimProjectDeletionJobs(this, now, limit);
  }

  async freezeProjectForDeletion(jobId: string, projectId: string): Promise<boolean> {
    return freezeProjectForDeletion(this, jobId, projectId);
  }

  async patchProjectDeletionJob(jobId: string, patch: Record<string, unknown>): Promise<void> {
    return patchProjectDeletionJob(this, jobId, patch);
  }

  async listProjectSessionIds(projectId: string): Promise<string[]> {
    return listProjectSessionIds(this, projectId);
  }

  async purgeProjectDatabase(jobId: string, projectId: string): Promise<void> {
    return purgeProjectDatabase(this, jobId, projectId);
  }

  async listProjects(ownerId?: string, lifecycleStatus?: ProjectLifecycleStatus): Promise<ProjectRow[]> {
    return listProjects(this, ownerId, lifecycleStatus);
  }

  async createTask(params: {
    projectId: string;
    agent: string;
    taskType: string;
    description?: string;
    parentTaskId?: string;
    inputRefs?: Array<{ type: string; path: string }>;
    outputPath?: string;
  }): Promise<any> {
    return createTask(this, params);
  }

  async updateTaskStatus(taskId: string, status: string, reviewNote?: string): Promise<void> {
    return updateTaskStatus(this, taskId, status, reviewNote);
  }

  async listTasks(projectId: string, limit = 50): Promise<any[]> {
    return listTasks(this, projectId, limit);
  }

  async enqueueContinuityJob(input: {
    projectId: string; chapterNumber: number; chapterPath: string; confirmedHash: string;
  }): Promise<void> {
    return enqueueContinuityJob(this, input);
  }

  async claimContinuityJobs(now: string, limit: number) {
    return claimContinuityJobs(this, now, limit);
  }

  async completeContinuityJob(jobId: string): Promise<void> {
    return completeContinuityJob(this, jobId);
  }

  async retryContinuityJob(jobId: string, attempts: number, nextAttemptAt: string, error: string): Promise<void> {
    return retryContinuityJob(this, jobId, attempts, nextAttemptAt, error);
  }

  async failContinuityJob(jobId: string, error: string): Promise<void> {
    return failContinuityJob(this, jobId, error);
  }

  async createSession(params: {
    id: string;
    projectId: string;
    title: string;
  }): Promise<void> {
    return createSession(this, params);
  }

  async listSessions(ownerId?: string): Promise<any[]> {
    return listSessions(this, ownerId);
  }

  async updateSession(sessionId: string, updates: {
    title?: string;
    isProcessing?: boolean;
    lastMessageAt?: string;
  }): Promise<void> {
    return updateSession(this, sessionId, updates);
  }

  async addMessage(sessionId: string, msg: {
    id: string;
    role: string;
    content: any[];
    timestamp: number;
    model?: string;
  }): Promise<void> {
    return addMessage(this, sessionId, msg);
  }

  async deleteSession(sessionId: string): Promise<void> {
    return deleteSession(this, sessionId);
  }

  async getOwnedSessionRow(sessionId: string, userId: string): Promise<SessionRow | null> {
    return getOwnedSessionRow(this, sessionId, userId);
  }

  async listSessionRows(input: {
    projectId: string;
    userId: string;
    limit: number;
    cursor?: { lastMessageAt: string; id: string };
    search?: string;
    lifecycleStatus: import("../session/types.js").SessionLifecycleStatus;
  }): Promise<SessionRow[]> {
    return listSessionRows(this, input);
  }

  async getActiveSessionId(projectId: string, userId: string): Promise<string | null> {
    return getActiveSessionId(this, projectId, userId);
  }

  async insertSessionRow(row: Pick<SessionRow, "id" | "project_id" | "title">, userId: string): Promise<SessionRow> {
    return insertSessionRow(this, row, userId);
  }

  async patchSessionRow(sessionId: string, patch: Partial<SessionRow>): Promise<SessionRow> {
    return patchSessionRow(this, sessionId, patch);
  }

  async deleteSessionRow(sessionId: string): Promise<void> {
    return deleteSessionRow(this, sessionId);
  }

  async insertSessionInteractionRow(row: Omit<SessionInteractionRow, "created_at" | "updated_at">): Promise<SessionInteractionRow> {
    return insertSessionInteractionRow(this, row);
  }

  async getSessionInteractionRow(id: string): Promise<SessionInteractionRow | null> {
    return getSessionInteractionRow(this, id);
  }

  async listSessionInteractionRows(assistantMessageIds: string[]): Promise<SessionInteractionRow[]> {
    return listSessionInteractionRows(this, assistantMessageIds);
  }

  async respondToSessionInteraction(input: {
    interactionId: string;
    response: InteractionResponseV1;
    idempotencyKey: string;
    responseMessageId: string;
    turnId: string;
    messageText: string;
    timestamp: number;
  }): Promise<InteractionRpcResult> {
    return respondToSessionInteraction(this, input);
  }

  async listDisplayMessageRows(input: {
    sessionId: string;
    limit: number;
    cursor?: { sequence: number };
  }): Promise<SessionMessageRow[]> {
    return listDisplayMessageRows(this, input);
  }

  async listAgentMessageRows(sessionId: string, agentId: AgentId, afterSequence: number): Promise<SessionMessageRow[]> {
    return listAgentMessageRows(this, sessionId, agentId, afterSequence);
  }

  async listDelegationMessageRows(input: {
    sessionId: string;
    agentId: string;
    turnId: string;
    limit: number;
    before?: { sequence: number };
  }): Promise<SessionMessageRow[]> {
    return listDelegationMessageRows(this, input);
  }

  async insertSessionMessageRow(row: Omit<SessionMessageRow, "sequence">): Promise<SessionMessageRow> {
    return insertSessionMessageRow(this, row);
  }

  async patchSessionMessageRow(messageId: string, patch: Partial<Omit<SessionMessageRow, "id" | "session_id" | "sequence">>): Promise<SessionMessageRow> {
    return patchSessionMessageRow(this, messageId, patch);
  }

  async acquireSessionLease(sessionId: string, leaseId: string, staleBefore: string): Promise<boolean> {
    return acquireSessionLease(this, sessionId, leaseId, staleBefore);
  }

  async releaseSessionLease(sessionId: string, leaseId: string): Promise<boolean> {
    return releaseSessionLease(this, sessionId, leaseId);
  }

  async releaseStaleLeases(staleBefore: string): Promise<number> {
    return releaseStaleLeases(this, staleBefore);
  }

  async insertMemoryJobRow(row: Pick<MemoryJobRow,
    "id" | "session_id" | "project_id" | "turn_id" | "operation" | "payload" | "status"
  >): Promise<void> {
    return insertMemoryJobRow(this, row);
  }

  async claimMemoryJobRows(now: string, limit: number): Promise<MemoryJobRow[]> {
    return claimMemoryJobRows(this, now, limit);
  }

  async patchMemoryJobRow(jobId: string, patch: Partial<MemoryJobRow>): Promise<void> {
    return patchMemoryJobRow(this, jobId, patch);
  }

  async listMemoryExclusionRows(projectId: string): Promise<Array<{ external_memory_id: string }>> {
    return listMemoryExclusionRows(this, projectId);
  }

  async insertMemoryExclusionRows(rows: Array<{
    project_id: string;
    deleted_session_id: string;
    external_memory_id: string;
  }>): Promise<void> {
    return insertMemoryExclusionRows(this, rows);
  }

  async getAgentStateRow(sessionId: string, agentId: AgentId): Promise<{
    summary: string | null;
    summary_through_sequence: number | null;
  } | null> {
    return getAgentStateRow(this, sessionId, agentId);
  }

  async upsertAgentStateRow(row: {
    session_id: string;
    agent_id: AgentId;
    summary: string;
    summary_through_sequence: number;
  }): Promise<void> {
    return upsertAgentStateRow(this, row);
  }

  async prepareSessionMemoryDelete(sessionId: string): Promise<boolean> {
    return prepareSessionMemoryDelete(this, sessionId);
  }

  async getLevelConfig(level: number): Promise<any | null> {
    return getLevelConfig(this, level);
  }

  async listLevelConfigs(): Promise<any[]> {
    return listLevelConfigs(this);
  }

  async recalcUserLevel(userId: string): Promise<void> {
    return recalcUserLevel(this, userId);
  }

  async getActiveAgentResource(resourceType: string, resourceKey: string): Promise<any | null> {
    return getActiveAgentResource(this, resourceType, resourceKey);
  }

  async getNextAgentResourceVersion(resourceType: string, resourceKey: string): Promise<number> {
    return getNextAgentResourceVersion(this, resourceType, resourceKey);
  }

  async publishAgentResourceVersion(input: {
    resourceType: string; resourceKey: string; versionNumber: number;
    storagePath: string; contentHash: string; changeNote?: string;
  }): Promise<any> {
    return publishAgentResourceVersion(this, input);
  }

  async activateAgentResourceVersion(resourceType: string, resourceKey: string, versionNumber: number): Promise<any> {
    return activateAgentResourceVersion(this, resourceType, resourceKey, versionNumber);
  }

  async listSkillRegistry(userId?: string): Promise<any[]> {
    return listSkillRegistry(this, userId);
  }

  async getSkillRegistrySource(slug: string): Promise<string | null> {
    return getSkillRegistrySource(this, slug);
  }

  async getSkillFromRegistry(slug: string): Promise<any | null> {
    return getSkillFromRegistry(this, slug);
  }

  async getSkillForUser(slug: string, userId?: string): Promise<any | null> {
    return getSkillForUser(this, slug, userId);
  }

  async installSkill(params: {
    slug: string;
    name: string;
    description?: string;
    storagePath: string;
    version?: string;
    userId?: string;
    source?: string;
    metadata?: Record<string, unknown>;
  }): Promise<any> {
    return installSkill(this, params);
  }

  async createSkillDraft(params: {
    userId: string; slug: string; source: string; originalContent: string;
    candidateContent: string; selectedRoles: string[]; sessionId?: string;
  }): Promise<any> {
    return createSkillDraft(this, params);
  }

  async getSkillDraft(id: string, userId: string): Promise<any | null> {
    return getSkillDraft(this, id, userId);
  }

  async updateSkillDraft(id: string, userId: string, patch: Record<string, unknown>): Promise<any> {
    return updateSkillDraft(this, id, userId, patch);
  }

  async createSkillReview(params: Record<string, any>): Promise<any> {
    return createSkillReview(this, params);
  }

  async getSkillReview(id: string, draftId: string): Promise<any | null> {
    return getSkillReview(this, id, draftId);
  }

  async findSkillConfirmation(userId: string, confirmationKey: string): Promise<any | null> {
    return findSkillConfirmation(this, userId, confirmationKey);
  }

  async listSkillRoles(skillId: string): Promise<string[]> {
    return listSkillRoles(this, skillId);
  }

  async installReviewedSkill(params: {
    slug: string; name: string; description: string; storagePath: string; userId: string;
    activeReviewId: string; approvedContentHash: string; reviewPolicyVersion: string;
    requiredCapabilities: string[]; roles: string[]; confirmationKey: string;
  }): Promise<any> {
    return installReviewedSkill(this, params);
  }

  async quarantineOutdatedSkills(activePolicyVersion: string): Promise<number> {
    return quarantineOutdatedSkills(this, activePolicyVersion);
  }

  async uninstallSkill(slug: string, userId?: string): Promise<void> {
    return uninstallSkill(this, slug, userId);
  }

  async findInstalledSkillBySlug(userId: string, slug: string): Promise<any | null> {
    return findInstalledSkillBySlug(this, userId, slug);
  }

  async updateInstalledSkill(params: {
    skillId: string; slug: string; name: string; description: string;
    userId: string; activeReviewId: string; approvedContentHash: string;
    reviewPolicyVersion: string; requiredCapabilities: string[];
    roles: string[]; confirmationKey: string;
  }): Promise<any> {
    return updateInstalledSkill(this, params);
  }

  async getNextSkillVersionNumber(skillId: string): Promise<number> {
    return getNextSkillVersionNumber(this, skillId);
  }

  async createSkillVersion(params: {
    skillId: string; versionNumber: number; contentHash: string;
    storagePath: string; activeReviewId?: string | null; snapshotReason: string;
  }): Promise<any> {
    return createSkillVersion(this, params);
  }

  async listSkillVersions(userId: string, slug: string): Promise<any[]> {
    return listSkillVersions(this, userId, slug);
  }

  async getSkillVersion(skillId: string, versionNumber: number): Promise<any | null> {
    return getSkillVersion(this, skillId, versionNumber);
  }

  async getUserProfile(userId: string): Promise<UserProfileRow | null> {
    return getUserProfile(this, userId);
  }

  async upsertUserProfile(params: {
    userId: string;
    nickname: string | null;
    avatarUrl: string | null;
    locale: SupportedLanguage;
  }): Promise<UserProfileRow> {
    return upsertUserProfile(this, params);
  }

  /** Bootstrap a user row when none exists — used by local-first startup. */
  async ensureUserRow(params: { userId: string; email: string; nickname?: string | null }): Promise<void> {
    return ensureUserRow(this, params);
  }

  async getCreditBalance(userId: string): Promise<any | null> {
    return getCreditBalance(this, userId);
  }

  async createCreditBalance(userId: string, initialBalance: number): Promise<any> {
    return createCreditBalance(this, userId, initialBalance);
  }

  async topUpCredits(userId: string, amount: number, description?: string, metadata?: Record<string, unknown>, type: "topup" | "grant" = "topup"): Promise<any> {
    return topUpCredits(this, userId, amount, description, metadata, type);
  }

  async deductCreditsAtomic(userId: string, amount: number, referenceType: string, referenceId: string, description: string, metadata?: Record<string, unknown>): Promise<{ success: boolean; new_balance: number }> {
    return deductCreditsAtomic(this, userId, amount, referenceType, referenceId, description, metadata);
  }

  async listCreditTransactions(userId: string, limit = 50, offset = 0): Promise<any[]> {
    return listCreditTransactions(this, userId, limit, offset);
  }

  async listCreditTransactionsCursor(params: {
    userId: string;
    type: "consume" | "topup" | "grant";
    beforeCreatedAt?: string;
    beforeId?: string;
    limit?: number;
  }): Promise<CreditTransactionCursorRow[]> {
    return listCreditTransactionsCursor(this, params);
  }

  async insertUsageRecord(params: {
    userId: string;
    projectId: string;
    sessionId?: string;
    agentId: string;
    modelId: string;
    modelProvider: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    costUsd: number;
    creditsConsumed: number;
    creditRateId?: string;
    requestStartedAt?: string;
    pricingPeriod?: string;
    creditRateWindowId?: string | null;
    contextTokens?: number;
    creditRateContextTierId?: string | null;
    rateSnapshot?: Record<string, unknown>;
    billingMultiplier?: number;
  }): Promise<any> {
    return insertUsageRecord(this, params);
  }

  async listUsageRecords(userId: string, projectId?: string, limit = 50): Promise<any[]> {
    return listUsageRecords(this, userId, projectId, limit);
  }

  async getCreditActivity(params: {
    userId: string;
    year: number;
    timezone: string;
  }): Promise<CreditActivityRow[]> {
    return getCreditActivity(this, params);
  }

  async listCreditRates(): Promise<any[]> {
    return listCreditRates(this);
  }

  async listCreditRateTimeWindows(): Promise<any[]> {
    return listCreditRateTimeWindows(this);
  }

  async listCreditRateContextTiers(): Promise<any[]> {
    return listCreditRateContextTiers(this);
  }

  async upsertCreditRate(params: {
    name: string;
    modelPattern: string;
    providerPattern?: string;
    inputRate: number;
    outputRate: number;
    cacheReadRate: number;
    cacheWriteRate: number;
    priority?: number;
  }): Promise<any> {
    return upsertCreditRate(this, params);
  }

  async getRuntimeModel(provider: string, modelId: string): Promise<RuntimeModelRow | null> {
    return getRuntimeModel(this, provider, modelId);
  }

  async disableRuntimeModel(input: DisableRuntimeModelInput): Promise<boolean> {
    return disableRuntimeModel(this, input);
  }

  async listWorkspaceSkills(workspaceId: string): Promise<any[]> {
    return listWorkspaceSkills(this, workspaceId);
  }

  async getWorkspaceSkill(workspaceId: string, skillSlug: string): Promise<any | null> {
    return getWorkspaceSkill(this, workspaceId, skillSlug);
  }

  async toggleWorkspaceSkill(workspaceId: string, skillSlug: string, enabled: boolean): Promise<void> {
    return toggleWorkspaceSkill(this, workspaceId, skillSlug, enabled);
  }

  async createPurchase(params: {
    userId: string;
    outTradeNo: string;
    packageId: string;
    packageName: string;
    credits: number;
    bonusCredits: number;
    priceCents: number;
  }): Promise<any> {
    return createPurchase(this, params);
  }

  async getPurchase(outTradeNo: string): Promise<any | null> {
    return getPurchase(this, outTradeNo);
  }

  async updatePurchaseCompleted(outTradeNo: string, paymentId: string): Promise<void> {
    return updatePurchaseCompleted(this, outTradeNo, paymentId);
  }

  async completeCreditPurchase(outTradeNo: string, paymentId: string): Promise<any> {
    return completeCreditPurchase(this, outTradeNo, paymentId);
  }

  async listCreditPackages(): Promise<any[]> {
    return listCreditPackages(this);
  }

  async countProjectsByOwner(userId: string): Promise<number> {
    return countProjectsByOwner(this, userId);
  }

  async listMembershipPlans(): Promise<any[]> {
    return listMembershipPlans(this);
  }

  async createMembershipPurchase(params: {
    userId: string;
    outTradeNo: string;
    planId: string;
    planName: string;
    priceCents: number;
    durationDays: number;
    bonusCredits: number;
    features: string[];
    source?: string;
  }): Promise<any> {
    return createMembershipPurchase(this, params);
  }

  async getMembershipPurchase(outTradeNo: string): Promise<any | null> {
    return getMembershipPurchase(this, outTradeNo);
  }

  async completeMembershipPurchase(outTradeNo: string, paymentId: string): Promise<any> {
    return completeMembershipPurchase(this, outTradeNo, paymentId);
  }

  async getActiveMembership(userId: string): Promise<any | null> {
    return getActiveMembership(this, userId);
  }

  async getActiveMembershipUserIds(userIds: string[]): Promise<Set<string>> {
    return getActiveMembershipUserIds(this, userIds);
  }

  async listActiveUserLlmKeys(userId: string): Promise<any[]> {
    return listActiveUserLlmKeys(this, userId);
  }

  async findActiveUserLlmKey(userId: string, provider: string): Promise<any | null> {
    return findActiveUserLlmKey(this, userId, provider);
  }

  async upsertUserLlmKey(params: {
    userId: string;
    provider: string;
    encryptedKey: string;
    keyLast4: string;
  }): Promise<any> {
    return upsertUserLlmKey(this, params);
  }

  async revokeUserLlmKey(userId: string, provider: string): Promise<boolean> {
    return revokeUserLlmKey(this, userId, provider);
  }

  async previewReferralCode(code: string): Promise<Record<string, unknown> | null> {
    return previewReferralCode(this, code);
  }

  async getReferralDashboard(userId: string): Promise<Record<string, unknown> | null> {
    return getReferralDashboard(this, userId);
  }

  updateReferralCampaign(input: { bindingEndsAt: string; adminUserId: string; reason: string }) {
    return updateReferralCampaign(this, input);
  }

  getReferralAdminMetrics() {
    return getReferralAdminMetrics(this);
  }

  listReferralAdminBindings(input: { search?: string; cursor?: string; limit?: number }) {
    return listReferralAdminBindings(this, input);
  }

  reviewReferralBinding(input: {
    bindingId: string; decision: "approve" | "reject"; adminUserId: string; reason: string;
  }) {
    return reviewReferralBinding(this, input);
  }

  requestRegistrationCode(input: {
    email: string; codeHash: string; ipHash: string; subject: string; text: string; html: string;
    inviteCode?: string; deviceHash?: string;
  }) {
    return requestRegistrationCode(this, input);
  }

  verifyRegistrationCode(input: { email: string; codeHash: string; ticketHash: string; inviteCode?: string }) {
    return verifyRegistrationCode(this, input);
  }

  reserveRegistrationTicket(input: {
    email: string; ticketHash: string; reservationHash: string; inviteCode?: string;
  }) {
    return reserveRegistrationTicket(this, input);
  }

  releaseRegistrationReservation(reservationHash: string): Promise<boolean> {
    return releaseRegistrationReservation(this, reservationHash);
  }

  finalizeRegistrationReservation(input: { reservationHash: string; userId: string; email: string }): Promise<boolean> {
    return finalizeRegistrationReservation(this, input);
  }

  async listCommunityArticles(opts: {
    section?: string;
    tag?: string;
    authorId?: string;
    kind?: CommunityKind;
    following?: boolean;
    userId?: string;
    sort?: "latest" | "popular" | "ranked";
    search?: string;
    featured?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<CommunityArticleRow[]> {
    return listCommunityArticles(this, opts);
  }

  async listCommunityFolloweeIds(userId: string): Promise<string[]> {
    return listCommunityFolloweeIds(this, userId);
  }

  async isCommunityAdmin(userId: string): Promise<boolean> {
    return isCommunityAdmin(this, userId);
  }

  async getCommunityArticle(id: string): Promise<CommunityArticleRow | null> {
    return getCommunityArticle(this, id);
  }

  async listCommunityComments(articleId: string, opts?: { cursor?: string; limit?: number }): Promise<CommunityCommentRow[]> {
    return listCommunityComments(this, articleId, opts);
  }

  async getCommunityComment(id: string): Promise<CommunityCommentRow | null> {
    return getCommunityComment(this, id);
  }

  async getCommunityAuthorProfile(userId: string): Promise<CommunityAuthorProfileRow | null> {
    return getCommunityAuthorProfile(this, userId);
  }

  async listCommunityArticlesByAuthor(userId: string, opts?: { cursor?: string; limit?: number }): Promise<CommunityArticleRow[]> {
    return listCommunityArticlesByAuthor(this, userId, opts);
  }

  async listCommunityFeedbackByAuthor(userId: string): Promise<CommunityArticleRow[]> {
    return listCommunityFeedbackByAuthor(this, userId);
  }

  async createCommunityArticle(input: {
    authorId: string;
    title: string;
    body: string;
    excerpt?: string;
    section: string;
    tags?: string[];
    kind?: CommunityKind;
    feedbackStatus?: CommunityFeedbackStatus | null;
    commentsEnabled?: boolean;
  }): Promise<CommunityArticleRow> {
    return createCommunityArticle(this, input);
  }

  async updateCommunityArticle(id: string, input: {
    title?: string;
    body?: string;
    excerpt?: string;
    section?: string;
    tags?: string[];
  }): Promise<void> {
    return updateCommunityArticle(this, id, input);
  }

  async publishCommunityArticle(id: string): Promise<void> {
    return publishCommunityArticle(this, id);
  }

  async softDeleteCommunityArticle(id: string): Promise<void> {
    return softDeleteCommunityArticle(this, id);
  }

  async setCommunityArticleFeatured(id: string, featured: boolean): Promise<void> {
    return setCommunityArticleFeatured(this, id, featured);
  }

  async hideCommunityArticle(id: string): Promise<void> {
    return hideCommunityArticle(this, id);
  }

  async updateCommunityFeedbackStatus(id: string, feedbackStatus: CommunityFeedbackStatus): Promise<void> {
    return updateCommunityFeedbackStatus(this, id, feedbackStatus);
  }

  async createCommunityComment(input: {
    articleId: string;
    authorId: string;
    body: string;
    rootId?: string;
    replyToUserId?: string;
  }): Promise<CommunityCommentRow> {
    return createCommunityComment(this, input);
  }

  async softDeleteCommunityComment(id: string): Promise<void> {
    return softDeleteCommunityComment(this, id);
  }

  async toggleCommunityArticleLike(articleId: string, userId: string, on: boolean): Promise<void> {
    return toggleCommunityArticleLike(this, articleId, userId, on);
  }

  async toggleCommunityBookmark(articleId: string, userId: string, on: boolean): Promise<void> {
    return toggleCommunityBookmark(this, articleId, userId, on);
  }

  async toggleCommunityCommentLike(commentId: string, userId: string, on: boolean): Promise<void> {
    return toggleCommunityCommentLike(this, commentId, userId, on);
  }

  async toggleCommunityFollow(followerId: string, followeeId: string, on: boolean): Promise<void> {
    return toggleCommunityFollow(this, followerId, followeeId, on);
  }

  async getCommunityInteractions(userId: string, articleIds: string[]): Promise<Record<string, { liked: boolean; bookmarked: boolean }>> {
    return getCommunityInteractions(this, userId, articleIds);
  }

  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    return isFollowing(this, followerId, followeeId);
  }
}
