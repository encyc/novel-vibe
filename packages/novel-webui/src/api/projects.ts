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

export async function listProjects(client: ApiRequestContext, status?: "active" | "archived" | "trash"): Promise<Project[]> {
    const query = status ? `?status=${status}` : "";
    const result = await client.request<{ projects: Project[] }>(`/api/projects${query}`);
    return result.projects;
  
}

export async function getProject(client: ApiRequestContext, projectId: string): Promise<Project> {
    const result = await client.request<{ project: Project }>(
      `/api/projects/${encodeURIComponent(projectId)}`,
    );
    return result.project;
  
}

export async function updateProject(client: ApiRequestContext, projectId: string, patch: {
    title?: string;
    genre?: string | null;
    synopsis?: string | null;
    writing_stage?: Project["writing_stage"];
    creative_language?: Project["creative_language"];
  }): Promise<Project> {
    const result = await client.request<{ project: Project }>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return result.project;
  
}

export async function permanentlyDeleteProject(client: ApiRequestContext, projectId: string): Promise<{ jobId: string; status: "pending" }> {
    return client.request(`/api/projects/${encodeURIComponent(projectId)}/permanent`, {
      method: "DELETE",
      body: JSON.stringify({}),
    });
  
}

export async function runProjectCommand(client: ApiRequestContext, projectId: string, command: "archive" | "trash" | "restore"): Promise<Project> {
    const result = await client.request<{ project: Project }>(
      `/api/projects/${encodeURIComponent(projectId)}/${command}`,
      { method: "POST", body: JSON.stringify({}) },
    );
    return result.project;
  
}

export function archiveProject(client: ApiRequestContext, projectId: string): Promise<Project> {
    return runProjectCommand(client, projectId, "archive");
  
}

export function trashProject(client: ApiRequestContext, projectId: string): Promise<Project> {
    return runProjectCommand(client, projectId, "trash");
  
}

export function restoreProject(client: ApiRequestContext, projectId: string): Promise<Project> {
    return runProjectCommand(client, projectId, "restore");
  
}

export async function createProject(client: ApiRequestContext, input: {
    title: string;
    genre?: string;
    synopsis?: string;
    creative_language: Project["creative_language"];
  }): Promise<Project> {
    const result = await client.request<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return result.project;
  
}
