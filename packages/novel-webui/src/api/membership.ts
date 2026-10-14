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

export async function getMembershipPlans(client: ApiRequestContext): Promise<MembershipPlan[]> {
    return (await client.request<{ plans: MembershipPlan[] }>("/api/membership/plans")).plans;
  
}

export function getMembershipStatus(client: ApiRequestContext): Promise<MembershipStatus> {
    return client.request("/api/membership/status");
  
}

export async function getMembershipEntitlements(client: ApiRequestContext): Promise<{ catalog: MembershipEntitlement[]; premiumModels: string[] }> {
    return client.request("/api/membership/entitlements");
  
}

export function createMembershipPurchase(client: ApiRequestContext, planId: string): Promise<{ orderNo: string; payUrl: string }> {
    return client.request("/api/membership/purchases", { method: "POST", body: JSON.stringify({ planId }) });
  
}

export function getMembershipPurchase(client: ApiRequestContext, orderNo: string): Promise<{ orderNo: string; status: PurchaseStatus }> {
    return client.request(`/api/membership/purchases/${encodeURIComponent(orderNo)}`);
  
}
