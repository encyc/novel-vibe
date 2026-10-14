import { randomUUID } from "node:crypto";
import {
  documentWriteKey,
  documentWrites,
  type DocumentWriteCoordinator,
} from "../lib/document-write-coordinator.js";
import { createLogger } from "../lib/logger.js";
import { isReservedDocumentPath, sha256Content } from "../lib/storage.js";
import { computeDocumentDiff, DIFF_ALGORITHM_VERSION } from "./diff.js";
import type {
  ClaimDocumentWriteInput,
  CompleteDocumentWriteInput,
} from "./repository.js";
import type { DocumentDiffRecord } from "./types.js";

export type DocumentWriteSourceContext =
  | { type: "agent"; userId: string; agentId: string; sessionId: string; turnId: string; toolCallId: string }
  | { type: "user"; userId: string }
  | { type: "system"; jobId: string };

export interface VersionedDocumentWriteInput {
  projectId: string;
  path: string;
  content: string;
  baseHash?: string;
  source: DocumentWriteSourceContext;
}

export type DocumentWriteResult =
  | { changed: false; path: string; afterHash: string; indexed: false }
  | {
    changed: true;
    path: string;
    versionId: string;
    versionNo: number;
    beforeHash: string | null;
    afterHash: string;
    indexed: boolean;
    addedLines: number;
    deletedLines: number;
    changedSections: string[];
  };

interface VersionedStorage {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  writeDocumentSnapshot(path: string, sha256: string, content: string): Promise<string>;
}

interface VersionedRepository {
  claimWrite(input: ClaimDocumentWriteInput): Promise<{ outcome: "claimed"; versionId: string } | { outcome: "busy" }>;
  completeWrite(input: CompleteDocumentWriteInput): Promise<{ versionNo: number }>;
  failWrite(versionId: string, leaseId: string, failureCode: string): Promise<void>;
}

interface SafeLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface VersionedDocumentWriterOptions {
  storage: VersionedStorage;
  repository: VersionedRepository;
  coordinator?: DocumentWriteCoordinator;
  afterHeadWrite?: (input: VersionedDocumentWriteInput, afterHash: string) => Promise<boolean>;
  computeDiff?: (before: string, after: string) => DocumentDiffRecord;
  now?: () => Date;
  uuid?: () => string;
  logger?: SafeLogger;
}

export class DocumentConflictError extends Error {
  constructor(
    readonly content: string,
    readonly hash: string,
    readonly path: string,
  ) {
    super("Document conflict");
    this.name = "DocumentConflictError";
  }
}

export class DocumentWriteBusyError extends Error {
  constructor(readonly path: string) {
    super("Document write is already in progress");
    this.name = "DocumentWriteBusyError";
  }
}

function unavailableDiff(): DocumentDiffRecord {
  return {
    algorithmVersion: DIFF_ALGORITHM_VERSION,
    status: "unavailable",
    hunks: [],
    frontmatterChanges: [],
    addedLines: 0,
    deletedLines: 0,
    changedSections: [],
    truncated: false,
  };
}

function sourceClaim(input: VersionedDocumentWriteInput, beforeHash: string | null, afterHash: string, leaseId: string, leaseExpiresAt: string): ClaimDocumentWriteInput {
  const common = {
    projectId: input.projectId,
    path: input.path,
    beforeHash,
    afterHash,
    sourceType: input.source.type,
    leaseId,
    leaseExpiresAt,
  } as const;
  if (input.source.type === "agent") {
    return {
      ...common,
      agentId: input.source.agentId,
      sessionId: input.source.sessionId,
      turnId: input.source.turnId,
      toolCallId: input.source.toolCallId,
      createdBy: input.source.userId,
    };
  }
  if (input.source.type === "user") return { ...common, createdBy: input.source.userId };
  return common;
}

export class VersionedDocumentWriter {
  private readonly coordinator: DocumentWriteCoordinator;
  private readonly computeDiff: (before: string, after: string) => DocumentDiffRecord;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly logger: SafeLogger;

  constructor(private readonly options: VersionedDocumentWriterOptions) {
    this.coordinator = options.coordinator ?? documentWrites;
    this.computeDiff = options.computeDiff ?? computeDocumentDiff;
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.logger = options.logger ?? createLogger("document-version");
  }

  async write(input: VersionedDocumentWriteInput): Promise<DocumentWriteResult> {
    if (isReservedDocumentPath(input.path)) throw new Error("Invalid or reserved document path");
    return this.coordinator.run(documentWriteKey(input.projectId, input.path), () => this.writeLocked(input));
  }

  private async writeLocked(input: VersionedDocumentWriteInput): Promise<DocumentWriteResult> {
    const startedAt = this.now().getTime();
    let beforeContent: string | null;
    try {
      beforeContent = await this.options.storage.read(input.path);
    } catch (error) {
      if (error instanceof Error && error.message.includes("[404]")) beforeContent = null;
      else throw error;
    }
    const beforeHash = beforeContent === null ? null : sha256Content(beforeContent);
    const afterHash = sha256Content(input.content);
    // baseHash "" on an absent document means create-if-absent consent; any
    // other mismatch (including "" against an existing document) conflicts.
    const createConsent = input.baseHash === "" && beforeHash === null;
    if (input.baseHash !== undefined && input.baseHash !== beforeHash && !createConsent) {
      throw new DocumentConflictError(beforeContent ?? "", beforeHash ?? "", input.path);
    }
    if (beforeHash === afterHash) {
      this.log("write_noop", input, { beforeHash, afterHash, durationMs: this.now().getTime() - startedAt });
      return { changed: false, path: input.path, afterHash, indexed: false };
    }

    const leaseId = this.uuid();
    const leaseExpiresAt = new Date(this.now().getTime() + 5 * 60_000).toISOString();
    const claim = await this.options.repository.claimWrite(
      sourceClaim(input, beforeHash, afterHash, leaseId, leaseExpiresAt),
    );
    if (claim.outcome === "busy") throw new DocumentWriteBusyError(input.path);
    const versionId = claim.versionId;
    this.log("write_claimed", input, { versionId, beforeHash, afterHash });

    let beforeSnapshotPath: string | null = null;
    let afterSnapshotPath: string;
    try {
      if (beforeContent !== null && beforeHash !== null) {
        beforeSnapshotPath = await this.options.storage.writeDocumentSnapshot(input.path, beforeHash, beforeContent);
      }
      afterSnapshotPath = await this.options.storage.writeDocumentSnapshot(input.path, afterHash, input.content);
    } catch (error) {
      await this.failQuietly(versionId, leaseId, "snapshot_write_failed");
      this.log("snapshot_failed", input, { versionId, beforeHash, afterHash, errorCode: "snapshot_write_failed" }, true);
      throw error;
    }

    try {
      await this.options.storage.write(input.path, input.content);
    } catch (error) {
      await this.failQuietly(versionId, leaseId, "head_write_failed");
      throw error;
    }
    this.log("head_written", input, { versionId, beforeHash, afterHash });

    let indexed = false;
    if (this.options.afterHeadWrite) {
      try {
        indexed = await this.options.afterHeadWrite(input, afterHash);
      } catch {
        this.log("post_write_failed", input, { versionId, beforeHash, afterHash, errorCode: "post_write_failed" }, true);
      }
    }

    let diff: DocumentDiffRecord;
    let errorCode: string | undefined;
    try {
      diff = this.computeDiff(beforeContent ?? "", input.content);
    } catch {
      diff = unavailableDiff();
      errorCode = "diff_compute_failed";
      this.log("diff_unavailable", input, { versionId, beforeHash, afterHash, errorCode }, true);
    }
    const completion = await this.options.repository.completeWrite({
      versionId,
      leaseId,
      beforeSnapshotPath,
      afterSnapshotPath,
      diff,
      errorCode,
    });
    this.log("write_completed", input, {
      versionId,
      versionNo: completion.versionNo,
      beforeHash,
      afterHash,
      algorithmVersion: diff.algorithmVersion,
      durationMs: this.now().getTime() - startedAt,
    });
    return {
      changed: true,
      path: input.path,
      versionId,
      versionNo: completion.versionNo,
      beforeHash,
      afterHash,
      indexed,
      addedLines: diff.addedLines,
      deletedLines: diff.deletedLines,
      changedSections: diff.changedSections,
    };
  }

  private async failQuietly(versionId: string, leaseId: string, failureCode: string): Promise<void> {
    try {
      await this.options.repository.failWrite(versionId, leaseId, failureCode);
    } catch {
      // The repair worker will reclaim an expired intent if failure recording is unavailable.
    }
  }

  private log(event: string, input: VersionedDocumentWriteInput, fields: Record<string, unknown>, warning = false): void {
    const safe = {
      event,
      projectId: input.projectId,
      path: input.path,
      sourceType: input.source.type,
      ...fields,
    };
    (warning ? this.logger.warn : this.logger.info)(safe);
  }
}
