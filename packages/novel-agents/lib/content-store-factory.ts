/**
 * Content-store factory: the single place that decides which backend backs the
 * {@link ContentStore} port.
 *
 * The agent domain (tools, document writing, continuity, skills, profiles)
 * receives a `ContentStore` built here and never constructs a transport itself,
 * so swapping the backend never touches domain code.
 *
 * Today the only backend is InsForge Storage (S3), selected for both the
 * user-token and system-token scopes.
 *
 * Phase 3 (local-first) extension point: {@link ContentStoreScope.storageBackend}
 * selects the implementation. Local mode adds a `"fs"` backend and returns an
 * `FsContentStore` rooted at the user's project directory — no call site below
 * changes. No environment variable is consulted for this decision yet, and no
 * backend other than `"s3"` may be constructed in this phase.
 */

import type { ContentStore } from "./content-store.js";
import { StorageClient } from "./storage.js";

/** Storage buckets the application uses. */
export type ContentBucket = "novels" | "skills" | "avatars" | "agent-resources";

/**
 * Backend selector for {@link createContentStore}.
 * `"s3"` is InsForge Storage; Phase 3 adds `"fs"` for the local filesystem.
 */
export type ContentBackend = "s3";

export interface ContentStoreScope {
  /** `user` uses the caller's InsForge JWT (RLS-scoped); `system` uses the trusted Postgres-derived token. */
  mode: "user" | "system";
  /** Required for `mode: "user"`; system callers pass `db.storageToken`. */
  token?: string;
  /** Defaults to `"novels"`. */
  bucket?: ContentBucket;
  /** Defaults to `INSFORGE_URL` inside the S3 client. */
  baseUrl?: string;
  /** When set, the store prefixes every path with `{projectId}/`. */
  projectId?: string;
  /** Reserved for Phase 3 local-first mode. Defaults to `"s3"`. */
  storageBackend?: ContentBackend;
}

/** Build the content store for the given scope. */
export function createContentStore(scope: ContentStoreScope): ContentStore {
  switch (scope.storageBackend ?? "s3") {
    case "s3":
      // Phase 3 adds `case "fs": return createFsContentStore(scope);` here.
      return scope.mode === "user" ? createUserStore(scope) : createSystemStore(scope);
  }
}

function createUserStore(scope: ContentStoreScope): ContentStore {
  const token = requireToken(scope.token, "User");
  return StorageClient.forUser(token, scope.bucket ?? "novels", scope.baseUrl, scope.projectId);
}

function createSystemStore(scope: ContentStoreScope): ContentStore {
  const token = requireToken(scope.token, "System");
  return StorageClient.forSystem(token, scope.bucket ?? "novels", scope.baseUrl, scope.projectId);
}

function requireToken(token: string | undefined, kind: "User" | "System"): string {
  if (!token) throw new Error(`${kind} access token is required`);
  return token;
}
