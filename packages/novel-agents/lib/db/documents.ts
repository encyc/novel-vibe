import type {
  ClaimDocumentWriteInput,
  CompleteDocumentWriteInput,
  DocumentVersionDataSource,
} from "../../document-version/repository.js";

import type { DbRequestContext } from "./context.js";

export async function upsertDocumentIndex(ctx: DbRequestContext, params: {
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
    const conflictColumns = encodeURIComponent("project_id,doc_path");
    const res = await fetch(`${ctx.pgUrl}/document_index?on_conflict=${conflictColumns}`, {
      method: "POST",
      headers: ctx.headers({
        Prefer: "resolution=merge-duplicates",
      }),
      body: JSON.stringify({
        project_id: params.projectId,
        doc_path: params.docPath,
        doc_type: params.docType,
        name: params.name ?? null,
        status: params.status ?? "draft",
        chapter_num: params.chapterNum ?? null,
        volume_num: params.volumeNum ?? null,
        meta: params.meta,
        word_count: params.wordCount ?? null,
        checksum: params.checksum ?? null,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DB upsert failed [${res.status}]: ${text}`);
    }
  }

export async function listDocuments(ctx: DbRequestContext, projectId: string, docType?: string): Promise<any[]> {
    let url = `${ctx.pgUrl}/document_index?project_id=eq.${projectId}&order=updated_at.desc`;
    if (docType) url += `&doc_type=eq.${docType}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`DB query failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function getDocument(ctx: DbRequestContext, projectId: string, docPath: string): Promise<any | null> {
    const url = `${ctx.pgUrl}/document_index?project_id=eq.${projectId}&doc_path=eq.${encodeURIComponent(docPath)}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`DB query failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function updateDocumentStatus(ctx: DbRequestContext, projectId: string, docPath: string, status: string): Promise<void> {
    const url = `${ctx.pgUrl}/document_index?project_id=eq.${projectId}&doc_path=eq.${encodeURIComponent(docPath)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: ctx.headers(),
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error(`DB update failed [${res.status}]: ${await res.text()}`);
  }

export async function deleteDocument(ctx: DbRequestContext, projectId: string, docPath: string): Promise<void> {
    const url = `${ctx.pgUrl}/document_index?project_id=eq.${projectId}&doc_path=eq.${encodeURIComponent(docPath)}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: ctx.headers(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`DB delete failed [${res.status}]: ${await res.text()}`);
    }
  }

export async function deleteForeshadow(ctx: DbRequestContext, projectId: string, foreshadowId: string): Promise<void> {
    const url = `${ctx.pgUrl}/foreshadow_index?project_id=eq.${projectId}&foreshadow_id=eq.${encodeURIComponent(foreshadowId)}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: ctx.headers(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Foreshadow delete failed [${res.status}]: ${await res.text()}`);
    }
  }

export async function claimDocumentWrite(ctx: DbRequestContext, input: ClaimDocumentWriteInput): Promise<Record<string, unknown>> {
    const res = await fetch(`${ctx.pgUrl}/rpc/claim_document_write`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({
        p_project_id: input.projectId,
        p_doc_path: input.path,
        p_before_hash: input.beforeHash,
        p_after_hash: input.afterHash,
        p_source_type: input.sourceType,
        p_agent_id: input.agentId ?? null,
        p_session_id: input.sessionId ?? null,
        p_turn_id: input.turnId ?? null,
        p_tool_call_id: input.toolCallId ?? null,
        p_created_by: input.createdBy ?? null,
        p_lease_id: input.leaseId,
        p_lease_expires_at: input.leaseExpiresAt,
      }),
    });
    if (!res.ok) throw new Error(`Claim document write failed [${res.status}]: ${await res.text()}`);
    const value = await res.json() as Record<string, unknown> | Record<string, unknown>[];
    return Array.isArray(value) ? value[0] ?? {} : value;
  }

export async function completeDocumentWrite(ctx: DbRequestContext, input: CompleteDocumentWriteInput): Promise<Record<string, unknown>> {
    const { diff } = input;
    const res = await fetch(`${ctx.pgUrl}/rpc/complete_document_write`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({
        p_version_id: input.versionId,
        p_lease_id: input.leaseId,
        p_before_snapshot_path: input.beforeSnapshotPath,
        p_after_snapshot_path: input.afterSnapshotPath,
        p_diff_status: diff.status,
        p_algorithm_version: diff.algorithmVersion,
        p_body_hunks: diff.hunks,
        p_frontmatter_changes: diff.frontmatterChanges,
        p_added_lines: diff.addedLines,
        p_deleted_lines: diff.deletedLines,
        p_changed_sections: diff.changedSections,
        p_truncated: diff.truncated,
        p_error_code: input.errorCode ?? null,
      }),
    });
    if (!res.ok) throw new Error(`Complete document write failed [${res.status}]: ${await res.text()}`);
    const value = await res.json() as Record<string, unknown> | Record<string, unknown>[];
    return Array.isArray(value) ? value[0] ?? {} : value;
  }

export async function failDocumentWrite(ctx: DbRequestContext, versionId: string, leaseId: string, failureCode: string): Promise<void> {
    const res = await fetch(`${ctx.pgUrl}/rpc/fail_document_write`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({
        p_version_id: versionId,
        p_lease_id: leaseId,
        p_failure_code: failureCode,
      }),
    });
    if (!res.ok) throw new Error(`Fail document write failed [${res.status}]: ${await res.text()}`);
  }

export async function listDocumentVersions(ctx: DbRequestContext, projectId: string, path: string, beforeVersionNo: number | null, limit: number): Promise<Record<string, unknown>[]> {
    const select = "id,project_id,doc_path,version_no,source_type,agent_id,session_id,turn_id,tool_call_id,created_by,before_hash,after_hash,state,created_at,completed_at,document_version_diffs(status,added_lines,deleted_lines,changed_sections)";
    let url = `${ctx.pgUrl}/document_versions?project_id=eq.${encodeURIComponent(projectId)}`
      + `&doc_path=eq.${encodeURIComponent(path)}&state=eq.complete&select=${select}`
      + `&order=version_no.desc&limit=${Math.max(1, Math.floor(limit))}`;
    if (beforeVersionNo !== null) url += `&version_no=lt.${beforeVersionNo}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List document versions failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function getDocumentVersion(ctx: DbRequestContext, versionId: string, projectId?: string): Promise<Record<string, unknown> | null> {
    const select = "id,project_id,doc_path,version_no,source_type,agent_id,session_id,turn_id,tool_call_id,created_by,before_hash,after_hash,state,created_at,completed_at,document_version_diffs(status,added_lines,deleted_lines,changed_sections)";
    let url = `${ctx.pgUrl}/document_versions?id=eq.${encodeURIComponent(versionId)}&state=eq.complete&select=${select}&limit=1`;
    if (projectId) url += `&project_id=eq.${encodeURIComponent(projectId)}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Get document version failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json() as Record<string, unknown>[];
    return rows[0] ?? null;
  }

export async function getDocumentVersionDiff(ctx: DbRequestContext, versionId: string): Promise<Record<string, unknown> | null> {
    const url = `${ctx.pgUrl}/document_version_diffs?version_id=eq.${encodeURIComponent(versionId)}&limit=1`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Get document diff failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json() as Record<string, unknown>[];
    return rows[0] ?? null;
  }

export async function claimDocumentVersionRepairs(ctx: DbRequestContext, now: string, limit: number): Promise<Record<string, unknown>[]> {
    const res = await fetch(`${ctx.pgUrl}/rpc/claim_document_version_repairs`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({ p_now: now, p_limit: Math.max(1, Math.min(100, Math.floor(limit))) }),
    });
    if (!res.ok) throw new Error(`Claim document version repairs failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function upsertForeshadow(ctx: DbRequestContext, params: {
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
    const res = await fetch(`${ctx.pgUrl}/foreshadow_index`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "resolution=merge-duplicates" }),
      body: JSON.stringify({
        project_id: params.projectId,
        foreshadow_id: params.foreshadowId,
        doc_path: params.docPath,
        description: params.description ?? null,
        importance: params.importance ?? 5,
        plant_chapter: params.plantChapter ?? null,
        planned_resolve: params.plannedResolve ?? null,
        actual_resolve: params.actualResolve ?? null,
        status: params.status ?? "planned",
      }),
    });
    if (!res.ok) throw new Error(`Foreshadow upsert failed [${res.status}]: ${await res.text()}`);
  }

export async function listForeshadows(ctx: DbRequestContext, projectId: string): Promise<any[]> {
    const url = `${ctx.pgUrl}/foreshadow_index?project_id=eq.${projectId}&order=plant_chapter.asc`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`DB query failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }
