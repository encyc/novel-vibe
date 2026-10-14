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

export async function listSessions(client: ApiRequestContext, projectId: string, options: { cursor?: string; limit?: number; search?: string; status?: "active" | "archived" } = {}): Promise<SessionPage> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.search) params.set("search", options.search);
    if (options.status) params.set("status", options.status);
    const query = params.size ? `?${params.toString()}` : "";
    return client.request<SessionPage>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions${query}`,
    );
  
}

export async function createSession(client: ApiRequestContext, projectId: string): Promise<ChatSession> {
    const result = await client.request<{ session: ChatSession }>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions`,
      { method: "POST", body: JSON.stringify({}) },
    );
    return result.session;
  
}

export async function listSessionMessages(client: ApiRequestContext, sessionId: string, options: { cursor?: string; limit?: number } = {}): Promise<CursorPage<SessionMessage>> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.size ? `?${params.toString()}` : "";
    return client.request<CursorPage<SessionMessage>>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages${query}`,
    );
  
}

export async function listDelegationMessages(client: ApiRequestContext, sessionId: string, callId: string, options: { cursor?: string; limit?: number } = {}): Promise<CursorPage<DelegationTranscriptEntry>> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.size ? `?${params.toString()}` : "";
    return client.request<CursorPage<DelegationTranscriptEntry>>(
      `/api/sessions/${encodeURIComponent(sessionId)}/delegations/${encodeURIComponent(callId)}/messages${query}`,
    );
  
}

export async function openSession(client: ApiRequestContext, sessionId: string): Promise<ChatSession> {
    const result = await client.request<{ session: ChatSession }>(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { method: "PATCH", body: JSON.stringify({ action: "open" }) },
    );
    return result.session;
  
}

export async function renameSession(client: ApiRequestContext, sessionId: string, title: string): Promise<ChatSession> {
    const result = await client.request<{ session: ChatSession }>(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { method: "PATCH", body: JSON.stringify({ title }) },
    );
    return result.session;
  
}

export async function archiveSession(client: ApiRequestContext, sessionId: string): Promise<ChatSession> {
    const result = await client.request<{ session: ChatSession }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH", body: JSON.stringify({ action: "archive" }),
    });
    return result.session;
  
}

export async function restoreSession(client: ApiRequestContext, sessionId: string): Promise<ChatSession> {
    const result = await client.request<{ session: ChatSession }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH", body: JSON.stringify({ action: "restore" }),
    });
    return result.session;
  
}

export async function deleteSession(client: ApiRequestContext, sessionId: string): Promise<void> {
    await client.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      body: JSON.stringify({}),
    });
  
}

export function interruptSession(client: ApiRequestContext, sessionId: string): Promise<{ interrupted: boolean }> {
    return client.request(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  
}
