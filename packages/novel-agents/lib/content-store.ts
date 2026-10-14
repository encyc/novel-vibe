/**
 * Content-store port.
 *
 * The agent domain (tools, document writing, continuity, skills) needs to read
 * and write Markdown documents, but it must not care where they physically
 * live. Today that is InsForge Storage (S3); in local-first mode it is the
 * user's own filesystem. This module holds the transport-free contract plus the
 * pure path/hash helpers that both implementations share.
 *
 * Path semantics: project-relative, forward-slash separated, never absolute,
 * never containing "." or ".." segments, and never inside the reserved
 * `.versions/` namespace (see {@link isReservedDocumentPath}).
 */

import { createHash } from "node:crypto";

export function sha256Content(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function isReservedDocumentPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return true;
  const segments = path.split("/");
  return segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments[0] === ".versions";
}

export function documentSnapshotPath(docPath: string, sha256: string): string {
  if (isReservedDocumentPath(docPath)) throw new Error("Invalid or reserved document path");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid snapshot hash");
  const encodedPath = docPath.split("/").map(encodeURIComponent).join("/");
  return `.versions/${encodedPath}/${sha256}.md`;
}

export class StorageObjectExistsError extends Error {
  constructor(readonly path: string) {
    super(`Storage object already exists: ${path}`);
    this.name = "StorageObjectExistsError";
  }
}

/**
 * The storage seam. Every implementation must satisfy
 * `packages/novel-agents/lib/content-store.contract.ts`.
 */
export interface ContentStore {
  /**
   * Whether {@link ContentStore.list} returns real results.
   *
   * The S3-backed implementation deliberately returns `[]` because InsForge has
   * no listing surface the application relies on; document enumeration goes
   * through the `document_index` table instead. A filesystem-backed store can
   * list for real, so the capability is declared rather than assumed — callers
   * that need enumeration must check this flag rather than treat `[]` as
   * "nothing exists".
   */
  readonly supportsListing: boolean;

  /** Read a document. Rejects when the path does not exist. */
  read(path: string): Promise<string>;

  /** Create or replace a document. */
  write(path: string, content: string): Promise<void>;

  /** Write a system-owned immutable object, refusing an existing key. */
  writeImmutable(path: string, content: string): Promise<void>;

  /**
   * Store a content-addressed snapshot of a document and return its path.
   * Idempotent: re-storing identical content returns the same path.
   */
  writeDocumentSnapshot(docPath: string, sha256: string, content: string): Promise<string>;

  /** Write binary content with an explicit validated media type. */
  writeBytes(path: string, content: Uint8Array, contentType: string): Promise<void>;

  /** Delete a document. Deleting a missing path is a no-op. */
  delete(path: string): Promise<void>;

  /** Delete every object under a prefix. System-owned purge workers only. */
  deletePrefix(prefix: string): Promise<void>;

  /** List paths under a prefix. See {@link ContentStore.supportsListing}. */
  list(prefix: string): Promise<string[]>;

  /** Case-insensitive keyword scan. Returns at most 20 hits. */
  search(query: string, scope: string): Promise<Array<{ path: string; snippet: string }>>;

  /** Absolute URL for the object, where the transport has one. */
  publicUrl(path: string): string;
}

/** The narrow slice {@link writeContentAddressedSnapshot} needs. */
export interface ReadWriteContentStore {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

/**
 * Shared content-addressed snapshot write.
 *
 * Verifies the caller's hash against the payload, refuses to overwrite a
 * snapshot whose bytes disagree, and treats an identical existing snapshot as
 * success. Extracted so every store gets the same semantics.
 */
export async function writeContentAddressedSnapshot(
  store: ReadWriteContentStore,
  docPath: string,
  sha256: string,
  content: string,
): Promise<string> {
  if (sha256Content(content) !== sha256) throw new Error("Snapshot content hash mismatch");
  const snapshotPath = documentSnapshotPath(docPath, sha256);
  try {
    const existing = await store.read(snapshotPath);
    if (sha256Content(existing) !== sha256) {
      throw new Error("Existing document snapshot hash mismatch");
    }
    return snapshotPath;
  } catch (error) {
    // A missing snapshot is the expected first-write path. Anything else —
    // including the hash disagreement raised just above — must propagate.
    if (!(error instanceof Error) || !isMissingObjectError(error)) throw error;
  }
  await store.write(snapshotPath, content);
  return snapshotPath;
}

/**
 * Shared keyword scan backing {@link ContentStore.search}.
 *
 * Kept here rather than in either transport so the 20-hit cap and the
 * 200-character snippet rule cannot drift between implementations.
 */
export async function searchByScanning(
  store: { list(prefix: string): Promise<string[]>; read(path: string): Promise<string> },
  query: string,
  scope: string,
): Promise<Array<{ path: string; snippet: string }>> {
  const files = await store.list(scope);
  const results: Array<{ path: string; snippet: string }> = [];
  const lowerQuery = query.toLowerCase();

  for (const file of files) {
    try {
      const content = await store.read(file);
      const lines = content.split("\n");
      for (const line of lines) {
        if (line.toLowerCase().includes(lowerQuery)) {
          results.push({ path: file, snippet: line.trim().slice(0, 200) });
          if (results.length >= 20) return results;
        }
      }
    } catch {
      // Skip unreadable files
    }
  }
  return results;
}

/**
 * Transport-specific "object does not exist" detection.
 *
 * The S3 client surfaces status codes inside its error message; a filesystem
 * client surfaces ENOENT. Centralised so the shared snapshot helper stays
 * transport-free.
 */
export function isMissingObjectError(error: Error): boolean {
  return error.message.includes("[404]") || error.message.includes("ENOENT");
}
