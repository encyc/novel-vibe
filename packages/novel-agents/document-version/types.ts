export type DocumentWriteSource = "agent" | "user" | "system";
export type DocumentVersionState = "preparing" | "complete" | "failed";
export type DocumentDiffStatus = "ready" | "unavailable";

export interface InlineDiffSpan {
  kind: "same" | "insert" | "delete";
  text: string;
}

export interface DocumentDiffLine {
  kind: "context" | "insert" | "delete";
  oldLine: number | null;
  newLine: number | null;
  text: string;
  spans?: InlineDiffSpan[];
}

export interface DocumentDiffHunk {
  index: number;
  section: string | null;
  oldStart: number;
  newStart: number;
  lines: DocumentDiffLine[];
}

export interface FrontmatterChange {
  key: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export interface DocumentDiffRecord {
  algorithmVersion: "jsdiff-v1";
  status: DocumentDiffStatus;
  hunks: DocumentDiffHunk[];
  frontmatterChanges: FrontmatterChange[];
  addedLines: number;
  deletedLines: number;
  changedSections: string[];
  truncated: boolean;
}

export interface DocumentDiffPage extends Omit<DocumentDiffRecord, "hunks"> {
  items: DocumentDiffHunk[];
  nextCursor: string | null;
}

export interface DocumentVersionSummary {
  id: string;
  projectId: string;
  path: string;
  versionNo: number;
  sourceType: DocumentWriteSource;
  agentId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  createdBy?: string;
  beforeHash: string | null;
  afterHash: string;
  state: "complete";
  diffStatus: DocumentDiffStatus;
  addedLines: number;
  deletedLines: number;
  changedSections: string[];
  createdAt: string;
  completedAt: string;
}

export interface DocumentVersionRepairRow {
  id: string;
  projectId: string;
  path: string;
  beforeHash: string | null;
  afterHash: string;
  beforeSnapshotPath: string | null;
  afterSnapshotPath: string | null;
  leaseId: string;
}
