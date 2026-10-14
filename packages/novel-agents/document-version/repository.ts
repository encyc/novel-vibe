import type { DocumentDiffRecord, DocumentVersionRepairRow, DocumentVersionSummary, DocumentWriteSource } from "./types.js";

export interface ClaimDocumentWriteInput {
  projectId: string;
  path: string;
  beforeHash: string | null;
  afterHash: string;
  sourceType: DocumentWriteSource;
  agentId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  createdBy?: string;
  leaseId: string;
  leaseExpiresAt: string;
}

export interface CompleteDocumentWriteInput {
  versionId: string;
  leaseId: string;
  beforeSnapshotPath: string | null;
  afterSnapshotPath: string;
  diff: DocumentDiffRecord;
  errorCode?: string;
}

export interface DocumentVersionDataSource {
  claimDocumentWrite(input: ClaimDocumentWriteInput): Promise<Record<string, unknown>>;
  completeDocumentWrite(input: CompleteDocumentWriteInput): Promise<Record<string, unknown>>;
  failDocumentWrite(versionId: string, leaseId: string, failureCode: string): Promise<void>;
  listDocumentVersions(projectId: string, path: string, beforeVersionNo: number | null, limit: number): Promise<Record<string, unknown>[]>;
  getDocumentVersion(versionId: string, projectId?: string): Promise<Record<string, unknown> | null>;
  getDocumentVersionDiff(versionId: string): Promise<Record<string, unknown> | null>;
  claimDocumentVersionRepairs(now: string, limit: number): Promise<Record<string, unknown>[]>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nestedDiff(row: Record<string, unknown>): Record<string, unknown> {
  const value = row.document_version_diffs;
  if (Array.isArray(value)) return (value[0] as Record<string, unknown> | undefined) ?? {};
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function mapSummary(row: Record<string, unknown>): DocumentVersionSummary {
  const diff = nestedDiff(row);
  if (row.state !== "complete" || typeof row.version_no !== "number" || typeof row.completed_at !== "string") {
    throw new Error("Document version row is not complete");
  }
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    path: String(row.doc_path),
    versionNo: row.version_no,
    sourceType: row.source_type as DocumentWriteSource,
    agentId: optionalString(row.agent_id),
    sessionId: optionalString(row.session_id),
    turnId: optionalString(row.turn_id),
    toolCallId: optionalString(row.tool_call_id),
    createdBy: optionalString(row.created_by),
    beforeHash: row.before_hash === null ? null : String(row.before_hash),
    afterHash: String(row.after_hash),
    state: "complete",
    diffStatus: diff.status === "unavailable" ? "unavailable" : "ready",
    addedLines: Number(diff.added_lines ?? 0),
    deletedLines: Number(diff.deleted_lines ?? 0),
    changedSections: Array.isArray(diff.changed_sections) ? diff.changed_sections.map(String) : [],
    createdAt: String(row.created_at),
    completedAt: row.completed_at,
  };
}

function mapDiff(row: Record<string, unknown>): DocumentDiffRecord {
  return {
    algorithmVersion: "jsdiff-v1",
    status: row.status === "unavailable" ? "unavailable" : "ready",
    hunks: Array.isArray(row.body_hunks) ? row.body_hunks as DocumentDiffRecord["hunks"] : [],
    frontmatterChanges: Array.isArray(row.frontmatter_changes)
      ? row.frontmatter_changes as DocumentDiffRecord["frontmatterChanges"]
      : [],
    addedLines: Number(row.added_lines ?? 0),
    deletedLines: Number(row.deleted_lines ?? 0),
    changedSections: Array.isArray(row.changed_sections) ? row.changed_sections.map(String) : [],
    truncated: row.truncated === true,
  };
}

export class DocumentVersionRepository {
  constructor(private readonly dataSource: DocumentVersionDataSource) {}

  async claimWrite(input: ClaimDocumentWriteInput): Promise<{ outcome: "claimed"; versionId: string } | { outcome: "busy" }> {
    const row = await this.dataSource.claimDocumentWrite(input);
    if (row.outcome === "busy") return { outcome: "busy" };
    if (row.outcome !== "claimed" || typeof row.version_id !== "string") {
      throw new Error("Invalid claim_document_write response");
    }
    return { outcome: "claimed", versionId: row.version_id };
  }

  async completeWrite(input: CompleteDocumentWriteInput): Promise<{ versionNo: number }> {
    const row = await this.dataSource.completeDocumentWrite(input);
    if (typeof row.version_no !== "number") throw new Error("Invalid complete_document_write response");
    return { versionNo: row.version_no };
  }

  async failWrite(versionId: string, leaseId: string, failureCode: string): Promise<void> {
    await this.dataSource.failDocumentWrite(versionId, leaseId, failureCode);
  }

  async listVersions(projectId: string, path: string, cursor: string | null, limit: number): Promise<{ items: DocumentVersionSummary[]; nextCursor: string | null }> {
    const before = cursor === null ? null : Number.parseInt(cursor, 10);
    if (before !== null && (!Number.isInteger(before) || before <= 0)) throw new Error("Invalid version cursor");
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await this.dataSource.listDocumentVersions(projectId, path, before, boundedLimit + 1);
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit).map(mapSummary);
    return {
      items,
      nextCursor: hasMore && items.length ? String(items.at(-1)!.versionNo) : null,
    };
  }

  async getVersion(versionId: string, projectId?: string): Promise<DocumentVersionSummary | null> {
    const row = await this.dataSource.getDocumentVersion(versionId, projectId);
    return row ? mapSummary(row) : null;
  }

  async getDiff(versionId: string): Promise<DocumentDiffRecord | null> {
    const row = await this.dataSource.getDocumentVersionDiff(versionId);
    return row ? mapDiff(row) : null;
  }

  async claimRepairs(now: string, limit: number): Promise<DocumentVersionRepairRow[]> {
    const rows = await this.dataSource.claimDocumentVersionRepairs(now, Math.max(1, Math.min(100, Math.floor(limit))));
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      path: String(row.doc_path),
      beforeHash: row.before_hash === null ? null : String(row.before_hash),
      afterHash: String(row.after_hash),
      beforeSnapshotPath: row.before_snapshot_path === null ? null : String(row.before_snapshot_path),
      afterSnapshotPath: row.after_snapshot_path === null ? null : String(row.after_snapshot_path),
      leaseId: String(row.lease_id),
    }));
  }
}
