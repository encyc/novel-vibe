/**
 * InsForge Storage implementation of the {@link ContentStore} port.
 *
 * Uses the InsForge REST API to interact with S3-backed storage. The port
 * contract and the transport-free path/hash helpers live in `./content-store.ts`
 * so a filesystem-backed implementation shares them instead of forking the
 * snapshot and search semantics.
 *
 * The pure helpers stay re-exported here to preserve the historical
 * `lib/storage.js` import surface for existing callers.
 */

import {
  StorageObjectExistsError,
  searchByScanning,
  writeContentAddressedSnapshot,
  type ContentStore,
} from "./content-store.js";

export {
  StorageObjectExistsError,
  documentSnapshotPath,
  isReservedDocumentPath,
  sha256Content,
} from "./content-store.js";
export type { ContentStore } from "./content-store.js";

const INSFORGE_URL = process.env.INSFORGE_URL ?? "http://localhost:7130";

export class StorageClient implements ContentStore {
  /**
   * InsForge exposes no object-listing surface the application relies on:
   * document enumeration goes through the `document_index` table. Declared
   * explicitly so callers never mistake an empty `list()` for "no documents".
   */
  readonly supportsListing = false;

  private baseUrl: string;
  private bucket: string;
  private token: string;
  private prefix: string;
  private readonly mode: "user" | "system";

  private constructor(
    _token: string,
    mode: "user" | "system",
    bucket = "novels",
    baseUrl?: string,
    projectId?: string,
  ) {
    this.baseUrl = baseUrl ?? INSFORGE_URL;
    this.bucket = bucket;
    this.token = _token;
    this.prefix = projectId ? `${projectId}/` : "";
    this.mode = mode;
  }

  static forUser(token: string, bucket = "novels", baseUrl?: string, projectId?: string): StorageClient {
    if (!token) throw new Error("User access token is required");
    return new StorageClient(token, "user", bucket, baseUrl, projectId);
  }

  static forSystem(token: string, bucket = "novels", baseUrl?: string, projectId?: string): StorageClient {
    if (!token) throw new Error("System access token is required");
    return new StorageClient(token, "system", bucket, baseUrl, projectId);
  }

  private fullPath(relativePath: string): string {
    return this.prefix + relativePath;
  }

  /** Read a file from storage. Returns raw string content. */
  async read(path: string): Promise<string> {
    const fullPath = this.fullPath(path);
    const encodedPath = encodeURIComponent(fullPath);
    const res = await fetch(
      `${this.baseUrl}/api/storage/buckets/${this.bucket}/objects/${encodedPath}`,
      {
        headers: { Authorization: `Bearer ${this.token}` },
      },
    );
    if (!res.ok) {
      throw new Error(`Storage read failed [${res.status}]: ${await res.text()}`);
    }
    return res.text();
  }

  /** Write a file to storage. */
  async write(path: string, content: string): Promise<void> {
    const fullPath = this.fullPath(path);
    const encodedPath = encodeURIComponent(fullPath);
    const blob = new Blob([content], { type: "text/markdown" });
    const formData = new FormData();
    formData.append("file", blob, path.split("/").pop() ?? "document.md");

    const res = await fetch(
      `${this.baseUrl}/api/storage/buckets/${this.bucket}/objects/${encodedPath}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${this.token}` },
        body: formData,
      },
    );
    if (!res.ok) {
      throw new Error(`Storage write failed [${res.status}]: ${await res.text()}`);
    }
  }

  /** Write a system-owned immutable object, refusing an existing key. */
  async writeImmutable(path: string, content: string): Promise<void> {
    try {
      await this.read(path);
      throw new StorageObjectExistsError(path);
    } catch (error) {
      if (error instanceof StorageObjectExistsError) throw error;
      if (!(error instanceof Error) || !error.message.includes("[404]")) throw error;
    }
    await this.write(path, content);
  }

  /** Store a content-addressed document snapshot without replacing valid data. */
  async writeDocumentSnapshot(docPath: string, sha256: string, content: string): Promise<string> {
    return writeContentAddressedSnapshot(this, docPath, sha256, content);
  }

  /** Write binary content with an explicit validated media type. */
  async writeBytes(path: string, content: Uint8Array, contentType: string): Promise<void> {
    const fullPath = this.fullPath(path);
    const encodedPath = encodeURIComponent(fullPath);
    const bytes = new Uint8Array(content.byteLength);
    bytes.set(content);
    const blob = new Blob([bytes.buffer], { type: contentType });
    const formData = new FormData();
    formData.append("file", blob, path.split("/").pop() ?? "upload");
    const res = await fetch(`${this.baseUrl}/api/storage/buckets/${this.bucket}/objects/${encodedPath}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.token}` },
      body: formData,
    });
    if (!res.ok) throw new Error(`Storage write failed [${res.status}]: ${await res.text()}`);
  }

  publicUrl(path: string): string {
    return `${this.baseUrl}/api/storage/buckets/${this.bucket}/objects/${encodeURIComponent(this.fullPath(path))}`;
  }

  /** Delete a file from storage. */
  async delete(path: string): Promise<void> {
    await this.deleteFullPath(this.fullPath(path));
  }

  private async deleteFullPath(fullPath: string): Promise<void> {
    const encodedPath = encodeURIComponent(fullPath);
    const res = await fetch(
      `${this.baseUrl}/api/storage/buckets/${this.bucket}/objects/${encodedPath}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.token}` },
      },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Storage delete failed [${res.status}]: ${await res.text()}`);
    }
  }

  /**
   * Delete every object under a prefix. Intended for system-owned purge workers.
   *
   * Directory-boundary semantics, shared with the filesystem store: the prefix
   * itself, plus everything under `prefix/`. The listing request is normalised
   * to `prefix/` so a raw-prefix match cannot reach a sibling such as
   * `scope-old.md`. Every production caller already passes a trailing slash
   * (`project/deletion-worker.ts` passes `${project_id}/`), so this is
   * byte-identical for them while keeping the two backends conformant.
   */
  async deletePrefix(prefix: string): Promise<void> {
    if (this.mode !== "system") throw new Error("Prefix deletion requires system storage credentials");
    const base = this.fullPath(prefix);
    const listPrefix = base === "" || base.endsWith("/") ? base : `${base}/`;
    while (true) {
      const params = new URLSearchParams({ prefix: listPrefix, limit: "1000", offset: "0" });
      const res = await fetch(`${this.baseUrl}/api/storage/buckets/${this.bucket}/objects?${params}`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) throw new Error(`Storage list failed [${res.status}]: ${await res.text()}`);
      const payload = await res.json() as { data?: Array<{ key: string }> };
      const objects = payload.data ?? [];
      if (objects.length === 0) break;
      for (const object of objects) {
        await this.deleteFullPath(object.key);
      }
    }
    // Directory-boundary semantics also cover the prefix naming a single object.
    if (base !== "" && !base.endsWith("/")) await this.deleteFullPath(base);
  }

  /** Search for a keyword in files under a given scope directory. */
  async search(query: string, scope: string): Promise<Array<{ path: string; snippet: string }>> {
    return searchByScanning(this, query, scope);
  }

  /** List files under a path prefix. Always empty for the S3-backed store. */
  async list(_prefix: string): Promise<string[]> {
    // InsForge exposes no object listing the application relies on, so
    // enumeration goes through the DB index (`document_index`). Kept as a
    // documented empty result rather than throwing, because `deletePrefix`
    // needs its own system-scoped listing path and callers must key off
    // `supportsListing` instead of treating `[]` as "nothing exists".
    return [];
  }
}
