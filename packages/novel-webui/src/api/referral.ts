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

export function getReferralPreview(client: ApiRequestContext, code: string): Promise<ReferralPreview> {
    return client.request(`/api/referrals/preview/${encodeURIComponent(code.trim().toUpperCase())}`);
  
}

export function getReferralDashboard(client: ApiRequestContext): Promise<ReferralDashboard> {
    return client.request("/api/referrals/me");
  
}

export function getReferralAdminMetrics(client: ApiRequestContext): Promise<ReferralAdminMetrics> {
    return client.request("/api/referrals/admin/metrics");
  
}

export function updateReferralCampaign(client: ApiRequestContext, input: { bindingEndsAt: string; reason: string }): Promise<{ campaign: ReferralAdminMetrics["campaign"] }> {
    return client.request("/api/referrals/admin/campaign", {
      method: "PATCH", body: JSON.stringify(input),
    });
  
}

export async function listReferralAdminBindings(client: ApiRequestContext, input: { search?: string; cursor?: string; limit?: number } = {}): Promise<ReferralAdminBinding[]> {
    const params = new URLSearchParams();
    if (input.search) params.set("search", input.search);
    if (input.cursor) params.set("cursor", input.cursor);
    if (input.limit) params.set("limit", String(input.limit));
    const query = params.size ? `?${params}` : "";
    return (await client.request<{ items: ReferralAdminBinding[] }>(`/api/referrals/admin/bindings${query}`)).items;
  
}

export function reviewReferralBinding(client: ApiRequestContext, id: string, decision: "approve" | "reject", reason: string) {
    return client.request(`/api/referrals/admin/bindings/${encodeURIComponent(id)}/${decision}`, {
      method: "POST", body: JSON.stringify({ reason }),
    });
  
}
