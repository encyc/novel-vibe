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
import { ApiError } from "./http.js";
import { parseResponse, interfaceLocaleHeaders } from "./http.js";

import type { ApiRequestContext } from "./context.js";

export type ApiTokenScope =
  | "profile:read" | "profile:write" | "billing:read" | "billing:purchase"
  | "projects:read" | "projects:write" | "projects:lifecycle" | "projects:delete"
  | "documents:read" | "documents:write" | "documents:export" | "documents:delete"
  | "sessions:read" | "sessions:write" | "sessions:delete" | "agents:run"
  | "skills:read" | "skills:write" | "skills:manage";

export type ApiTokenPreset = "read" | "write" | "agent:run";

export type ApiTokenLifetimeDays = 30 | 90 | 365;

export interface ApiTokenSummary {
  id: string;
  public_id: string;
  user_id: string;
  name: string;
  scopes: ApiTokenScope[];
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export type CreatedApiToken = ApiTokenSummary & { token: string };

export async function me(client: ApiRequestContext): Promise<User | null> {
    try {
      const result = await client.request<{ user: User }>("/api/me");
      return result.user;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  
}

export async function login(client: ApiRequestContext, email: string, password: string, mode: "login" | "signup"): Promise<void> {
    await client.request<{ ok: true }>("/api/auth", {
      method: "POST",
      body: JSON.stringify({ email, password, mode }),
    });
  
}

export function sendRegistrationCode(client: ApiRequestContext, email: string, inviteCode?: string): Promise<{ accepted: true; retryAfterSeconds: number }> {
    return client.request("/api/auth/registration/code", {
      method: "POST", body: JSON.stringify({ email, ...(inviteCode ? { inviteCode } : {}) }),
    });
  
}

export function verifyRegistrationCode(client: ApiRequestContext, email: string, code: string, inviteCode?: string): Promise<{ ticket: string; expiresInSeconds: number }> {
    return client.request("/api/auth/registration/verify", {
      method: "POST", body: JSON.stringify({ email, code, ...(inviteCode ? { inviteCode } : {}) }),
    });
  
}

export async function signup(client: ApiRequestContext, email: string, password: string, registrationTicket: string, inviteCode?: string): Promise<void> {
    await client.request<{ ok: true }>("/api/auth", {
      method: "POST",
      body: JSON.stringify({
        email, password, mode: "signup", registrationTicket,
        ...(inviteCode ? { inviteCode } : {}),
      }),
    });
  
}

export async function logout(client: ApiRequestContext): Promise<void> {
    await client.request<{ ok: true }>("/api/auth/logout", { method: "POST" });
  
}

export function getProfile(client: ApiRequestContext): Promise<UserProfile> {
    return client.request("/api/profile");
  
}

export function updateProfile(client: ApiRequestContext, input: {
    displayName?: string;
    locale?: UserProfile["locale"];
  }): Promise<UserProfile> {
    return client.request("/api/profile", { method: "PATCH", body: JSON.stringify(input) });
  
}

export async function listApiTokens(client: ApiRequestContext): Promise<ApiTokenSummary[]> {
    return (await client.request<{ tokens: ApiTokenSummary[] }>("/api/profile/tokens")).tokens;
  
}

export function createApiToken(client: ApiRequestContext, input: {
    name: string;
    lifetimeDays: ApiTokenLifetimeDays;
    presets: ApiTokenPreset[];
  }): Promise<CreatedApiToken> {
    return client.request("/api/profile/tokens", { method: "POST", body: JSON.stringify(input) });
  
}

export function revokeApiToken(client: ApiRequestContext, tokenId: string): Promise<{ ok: true }> {
    return client.request(`/api/profile/tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" });
  
}

export async function uploadAvatar(client: ApiRequestContext, file: File): Promise<UserProfile> {
    const res = await fetch("/api/profile/avatar", {
      method: "POST",
      credentials: "same-origin",
      headers: interfaceLocaleHeaders({ "Content-Type": file.type }),
      body: file,
    });
    return parseResponse<UserProfile>(res);
  
}
