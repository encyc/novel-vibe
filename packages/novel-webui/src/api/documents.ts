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
import { ApiError, notifyUnauthorized, interfaceLocaleHeaders } from "./http.js";

import type { ApiRequestContext } from "./context.js";

export async function listDocuments(client: ApiRequestContext, projectId: string, type?: string): Promise<DocumentIndex[]> {
    const query = type ? `?type=${encodeURIComponent(type)}` : "";
    const result = await client.request<{ documents: DocumentIndex[] }>(`/api/documents/${encodeURIComponent(projectId)}${query}`);
    return result.documents;
  
}

export async function readDocument(client: ApiRequestContext, projectId: string, path: string): Promise<DocumentSource> {
    return await client.request<DocumentSource>(
      `/api/documents/${encodeURIComponent(projectId)}/${path}`,
    );
  
}

export async function saveDocument(client: ApiRequestContext, projectId: string, path: string, content: string, baseHash: string): Promise<DocumentSaveResult> {
    return await client.request<DocumentSaveResult>(`/api/documents/${encodeURIComponent(projectId)}/${path}`, {
      method: "PUT",
      body: JSON.stringify({ content, base_hash: baseHash }),
    });
  
}

export async function listDocumentVersions(client: ApiRequestContext, projectId: string, path: string, cursor: string | null = null, limit = 20): Promise<CursorPage<DocumentVersionSummary>> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor !== null) params.set("cursor", cursor);
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    return await client.request<CursorPage<DocumentVersionSummary>>(
      `/api/documents/${encodeURIComponent(projectId)}/${encodedPath}/versions?${params}`,
    );
  
}

export async function getDocumentVersion(client: ApiRequestContext, versionId: string): Promise<DocumentVersionSummary> {
    return await client.request<DocumentVersionSummary>(
      `/api/document-versions/${encodeURIComponent(versionId)}`,
    );
  
}

export async function getDocumentVersionDiff(client: ApiRequestContext, versionId: string, cursor: string | null = null, limit = 20): Promise<DocumentDiffPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor !== null) params.set("cursor", cursor);
    return await client.request<DocumentDiffPage>(
      `/api/document-versions/${encodeURIComponent(versionId)}/diff?${params}`,
    );
  
}

export async function deleteDocument(client: ApiRequestContext, projectId: string, path: string): Promise<void> {
    await client.request(`/api/documents/${encodeURIComponent(projectId)}/${path}`, {
      method: "DELETE",
      body: JSON.stringify({}),
    });
  
}

export async function exportDocument(client: ApiRequestContext, projectId: string, path: string, format: string): Promise<void> {
    const url = `/api/documents/${encodeURIComponent(projectId)}/${path}/export/${encodeURIComponent(format)}`;
    const res = await fetch(url, {
      credentials: "same-origin",
      headers: interfaceLocaleHeaders(),
    });
    if (!res.ok) {
      if (res.status === 401) notifyUnauthorized();
      const text = await res.text();
      let data: unknown = text;
      try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
      throw new ApiError(res.status, data ?? { error: "Export failed" });
    }
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition");
    const match = disposition?.match(/filename\*=(?:UTF-8'')?(.+)/) ?? disposition?.match(/filename="?([^"]+)"?/);
    const filename = match ? decodeURIComponent(match[1]) : "document";
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(objectUrl);
  
}
