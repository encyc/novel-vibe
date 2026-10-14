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

export async function listSkills(client: ApiRequestContext): Promise<InstalledSkill[]> {
    return (await client.request<{ skills: InstalledSkill[] }>("/api/skills")).skills;
  
}

export async function createSkillDraft(client: ApiRequestContext, input: {
    source: "upload" | "paste" | "skill_creator";
    slug: string;
    content: string;
    roles: SkillRole[];
    filename?: string;
    session_id?: string;
  }): Promise<SkillDraft> {
    return (await client.request<{ draft: SkillDraft }>("/api/skill-drafts", {
      method: "POST", body: JSON.stringify(input),
    })).draft;
  
}

export async function getSkillDraft(client: ApiRequestContext, draftId: string): Promise<SkillDraft> {
    return (await client.request<{ draft: SkillDraft }>(`/api/skill-drafts/${encodeURIComponent(draftId)}`)).draft;
  
}

export async function reviewSkillDraft(client: ApiRequestContext, draftId: string, version: number): Promise<{ draft: SkillDraft; review: SkillReview }> {
    return client.request(`/api/skill-drafts/${encodeURIComponent(draftId)}/review`, {
      method: "POST", body: JSON.stringify({ version }),
    });
  
}

export async function confirmSkillDraft(client: ApiRequestContext, draftId: string, input: {
    version: number; reviewId: string; candidateHash: string; idempotencyKey: string;
  }): Promise<InstalledSkill> {
    const result = await client.request<{ skill: InstalledSkill }>(`/api/skill-drafts/${encodeURIComponent(draftId)}/confirm`, {
      method: "POST",
      body: JSON.stringify({
        version: input.version, review_id: input.reviewId,
        candidate_hash: input.candidateHash, idempotency_key: input.idempotencyKey,
      }),
    });
    return result.skill;
  
}

export async function cancelSkillDraft(client: ApiRequestContext, draftId: string): Promise<SkillDraft> {
    return (await client.request<{ draft: SkillDraft }>(`/api/skill-drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" })).draft;
  
}

export async function listSkillVersions(client: ApiRequestContext, slug: string): Promise<SkillVersionSummary[]> {
    return (await client.request<{ versions: SkillVersionSummary[] }>(`/api/skills/${encodeURIComponent(slug)}/versions`)).versions;
  
}

export async function revertSkill(client: ApiRequestContext, slug: string, versionNumber: number): Promise<void> {
    await client.request(`/api/skills/${encodeURIComponent(slug)}/revert`, {
      method: "POST", body: JSON.stringify({ version_number: versionNumber }),
    });
  
}

export async function listWorkspaceSkills(client: ApiRequestContext, workspaceId: string): Promise<WorkspaceSkill[]> {
    return (await client.request<{ skills: WorkspaceSkill[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills`)).skills;
  
}

export async function toggleWorkspaceSkill(client: ApiRequestContext, workspaceId: string, slug: string, enabled: boolean): Promise<void> {
    await client.request(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(slug)}`, {
      method: "PUT", body: JSON.stringify({ enabled }),
    });
  
}
