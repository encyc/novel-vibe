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

export function getCreditSummary(client: ApiRequestContext): Promise<CreditSummary> {
    return client.request("/api/credits/summary");
  
}

export async function getCreditActivity(client: ApiRequestContext, year: number, timezone: string): Promise<CreditActivityDay[]> {
    const params = new URLSearchParams({ year: String(year), timezone });
    return (await client.request<{ days: CreditActivityDay[] }>(`/api/credits/activity?${params}`)).days;
  
}

export function listCreditTransactions(client: ApiRequestContext, type: "consume" | "topup" | "grant", cursor?: string, limit = 20): Promise<CursorPage<CreditTransaction>> {
    const params = new URLSearchParams({ type, limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    return client.request(`/api/credits/transactions?${params}`);
  
}

export async function listCreditPackages(client: ApiRequestContext): Promise<CreditPackage[]> {
    return (await client.request<{ packages: CreditPackage[] }>("/api/credits/packages")).packages;
  
}

export async function listModels(client: ApiRequestContext): Promise<AiModel[]> {
    const raw = (await client.request<{ models: Array<{ id: string; name: string; provider: string; input_rate?: number; output_rate?: number }> }>(
      "/api/models",
    )).models;
    return raw.map((m) => ({
      id: `${m.provider}:${m.id}`,
      name: m.name,
      provider: m.provider,
      model: m.id,
      inputRate: m.input_rate,
      outputRate: m.output_rate,
    }));
  
}

export function createCreditPurchase(client: ApiRequestContext, packageId: string): Promise<{ orderNo: string; payUrl: string }> {
    return client.request("/api/credits/purchases", { method: "POST", body: JSON.stringify({ packageId }) });
  
}

export function getCreditPurchase(client: ApiRequestContext, orderNo: string): Promise<{ orderNo: string; status: PurchaseStatus }> {
    return client.request(`/api/credits/purchases/${encodeURIComponent(orderNo)}`);
  
}
