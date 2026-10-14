import { createLogger } from "../lib/logger.js";
import { sha256Content } from "../lib/storage.js";
import { computeDocumentDiff } from "./diff.js";
import type { CompleteDocumentWriteInput } from "./repository.js";
import type { DocumentVersionRepairRow } from "./types.js";

interface RepairRepository {
  claimRepairs(now: string, limit: number): Promise<DocumentVersionRepairRow[]>;
  completeWrite(input: CompleteDocumentWriteInput): Promise<{ versionNo: number }>;
  failWrite(versionId: string, leaseId: string, failureCode: string): Promise<void>;
}

interface RepairStorage {
  read(path: string): Promise<string>;
}

interface RepairLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface DocumentVersionRepairWorkerOptions {
  repository: RepairRepository;
  storageForProject(projectId: string): RepairStorage;
  batchSize: number;
  logger?: RepairLogger;
}

export class DocumentVersionRepairWorker {
  private readonly logger: RepairLogger;

  constructor(private readonly options: DocumentVersionRepairWorkerOptions) {
    this.logger = options.logger ?? createLogger("document-version.repair");
  }

  async runOnce(now = new Date()): Promise<void> {
    const rows = await this.options.repository.claimRepairs(now.toISOString(), this.options.batchSize);
    for (const row of rows) await this.repair(row);
  }

  private async repair(row: DocumentVersionRepairRow): Promise<void> {
    const storage = this.options.storageForProject(row.projectId);
    try {
      let headContent: string | null;
      try {
        headContent = await storage.read(row.path);
      } catch (error) {
        if (error instanceof Error && error.message.includes("[404]")) headContent = null;
        else throw error;
      }
      const headHash = headContent === null ? null : sha256Content(headContent);
      if (headHash === row.afterHash && headContent !== null) {
        if (!row.afterSnapshotPath) throw new Error("missing_after_snapshot");
        const afterSnapshot = await storage.read(row.afterSnapshotPath);
        if (sha256Content(afterSnapshot) !== row.afterHash) throw new Error("after_snapshot_hash_mismatch");
        let beforeSnapshot = "";
        if (row.beforeHash !== null) {
          if (!row.beforeSnapshotPath) throw new Error("missing_before_snapshot");
          beforeSnapshot = await storage.read(row.beforeSnapshotPath);
          if (sha256Content(beforeSnapshot) !== row.beforeHash) throw new Error("before_snapshot_hash_mismatch");
        }
        const diff = computeDocumentDiff(beforeSnapshot, afterSnapshot);
        const completed = await this.options.repository.completeWrite({
          versionId: row.id,
          leaseId: row.leaseId,
          beforeSnapshotPath: row.beforeSnapshotPath,
          afterSnapshotPath: row.afterSnapshotPath,
          diff,
        });
        this.logger.info({
          event: "repair_completed",
          projectId: row.projectId,
          path: row.path,
          versionId: row.id,
          versionNo: completed.versionNo,
          beforeHash: row.beforeHash,
          afterHash: row.afterHash,
          algorithmVersion: diff.algorithmVersion,
        });
        return;
      }
      const failureCode = headHash === row.beforeHash ? "head_not_written" : "newer_head_present";
      await this.options.repository.failWrite(row.id, row.leaseId, failureCode);
      this.logger.warn({
        event: "repair_failed",
        projectId: row.projectId,
        path: row.path,
        versionId: row.id,
        beforeHash: row.beforeHash,
        afterHash: row.afterHash,
        errorCode: failureCode,
      });
    } catch {
      try {
        await this.options.repository.failWrite(row.id, row.leaseId, "repair_metadata_failed");
      } catch {
        // Another worker or an expired lease may already have resolved the intent.
      }
      this.logger.warn({
        event: "repair_failed",
        projectId: row.projectId,
        path: row.path,
        versionId: row.id,
        beforeHash: row.beforeHash,
        afterHash: row.afterHash,
        errorCode: "repair_metadata_failed",
      });
    }
  }
}

export function startDocumentVersionRepairWorker(
  worker: DocumentVersionRepairWorker,
  intervalMs = 5_000,
): () => Promise<void> {
  let stopped = false;
  let inFlight = Promise.resolve();
  const trigger = () => {
    if (!stopped) inFlight = inFlight.then(() => worker.runOnce()).catch(() => undefined);
  };
  const initial = setTimeout(trigger, 0);
  const interval = setInterval(trigger, intervalMs);
  return async () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
    await inFlight;
  };
}
