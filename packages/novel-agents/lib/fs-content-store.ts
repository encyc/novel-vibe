/**
 * Filesystem implementation of the {@link ContentStore} port.
 *
 * Local-first mode keeps the user's novel on their own disk instead of InsForge
 * Storage (S3). The port contract and the transport-free snapshot/search
 * helpers live in `./content-store.ts`, so this class only owns path safety,
 * atomic file writes and enumeration — never a forked copy of the shared
 * semantics.
 *
 * Path semantics: every path is relative to the configured root, forward-slash
 * separated, and validated before it touches the disk (see
 * {@link FsContentStore.segments}). The reserved `.versions/` namespace is
 * readable and purgeable, but only the shared snapshot writer may create
 * objects in it.
 */

import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rmdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import {
  StorageObjectExistsError,
  isReservedDocumentPath,
  searchByScanning,
  writeContentAddressedSnapshot,
  type ContentStore,
} from "./content-store.js";

/** Reserved namespace holding content-addressed document snapshots. */
const VERSIONS_NAMESPACE = ".versions";

/** One file discovered under the root. */
interface WalkedFile {
  absolute: string;
  relative: string;
}

export class FsContentStore implements ContentStore {
  /** The filesystem can enumerate objects, unlike the S3 transport. */
  readonly supportsListing = true;

  private readonly root: string;
  private rootReal: string | undefined;

  constructor(rootDir: string) {
    if (!rootDir) throw new Error("FsContentStore requires a root directory");
    this.root = resolve(rootDir);
  }

  async read(path: string): Promise<string> {
    const absolute = await this.resolveInside(path, true);
    // ENOENT propagates unwrapped: `isMissingObjectError` keys off the OS
    // message, and the shared snapshot helper relies on it.
    return readFile(absolute, "utf8");
  }

  async write(path: string, content: string): Promise<void> {
    await this.writeObject(path, content, false);
  }

  /**
   * Write an immutable object, refusing an existing key.
   *
   * `flag: "wx"` maps to `O_CREAT | O_EXCL`, so the check-and-create is a single
   * atomic syscall: concurrent writers cannot both win.
   */
  async writeImmutable(path: string, content: string): Promise<void> {
    const absolute = await this.resolveInside(path, false);
    await mkdir(dirname(absolute), { recursive: true });
    // Re-check once the parent exists: a symlinked parent would otherwise let
    // the create land outside the root.
    await this.assertInsideRoot(absolute);
    try {
      await writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new StorageObjectExistsError(path);
      // A failed create must not leave a partial immutable object behind.
      await rm(absolute, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Store a content-addressed snapshot using the shared implementation.
   *
   * Snapshots live in the reserved `.versions/` namespace that public `write()`
   * rejects, so the delegation supplies a privileged writer limited to that
   * namespace. Hash verification, idempotency and the "existing bytes disagree"
   * refusal all come from {@link writeContentAddressedSnapshot}.
   */
  async writeDocumentSnapshot(docPath: string, sha256: string, content: string): Promise<string> {
    return writeContentAddressedSnapshot(
      {
        read: (snapshotPath) => this.read(snapshotPath),
        write: (snapshotPath, snapshotContent) => this.writeSnapshotObject(snapshotPath, snapshotContent),
      },
      docPath,
      sha256,
      content,
    );
  }

  /**
   * Write binary content.
   *
   * `contentType` is accepted for port parity and intentionally ignored: a local
   * file carries no media-type metadata, and the S3 transport is the only place
   * where the type is attached to the object. Callers that need a browser-usable
   * type keep it in the document metadata.
   */
  async writeBytes(path: string, content: Uint8Array, _contentType: string): Promise<void> {
    await this.writeObject(path, content, false);
  }

  async delete(path: string): Promise<void> {
    const absolute = await this.resolveInside(path, false);
    // `force` makes deleting a missing path a no-op, as the port requires.
    await rm(absolute, { force: true, recursive: true });
    await this.pruneEmptyParents(dirname(absolute));
  }

  /**
   * Delete every object whose relative path is inside `prefix`.
   *
   * Matching is directory-prefix matching (`prefix` itself, or anything under
   * `prefix/`), so a sibling such as `scope-old.md` is untouched. The reserved
   * `.versions/` tree stays purgeable here so system purge workers can drop a
   * project's history.
   */
  async deletePrefix(prefix: string): Promise<void> {
    const normalized = FsContentStore.normalizePrefix(prefix);
    const files: WalkedFile[] = [];
    await this.walk(this.root, "", files);

    for (const file of files) {
      if (!FsContentStore.matchesPrefix(file.relative, normalized)) continue;
      await rm(file.absolute, { force: true });
    }
    // Second call finds nothing here; pruning stays idempotent too.
    await this.pruneEmptyDirectories(this.root);
  }

  /** List file paths under a prefix as sorted, forward-slash relative paths. */
  async list(prefix: string): Promise<string[]> {
    const normalized = FsContentStore.normalizePrefix(prefix);
    const files: WalkedFile[] = [];
    await this.walk(this.root, "", files);

    return files
      .map((file) => file.relative)
      .filter((relative) => FsContentStore.matchesPrefix(relative, normalized))
      // Plain lexicographic sort: locale-independent and therefore stable
      // across machines.
      .sort();
  }

  /** Case-insensitive keyword scan delegated to the shared helper. */
  async search(query: string, scope: string): Promise<Array<{ path: string; snippet: string }>> {
    return searchByScanning(this, query, scope);
  }

  /**
   * Local-mode URL for an object.
   *
   * Local-first mode has no HTTP transport, so this returns a `file://` URL for
   * the resolved path on this machine. It is a stable, informational handle for
   * logs and debugging — not a browser-fetchable URL, and not an authorization
   * check: it performs path-shape validation but deliberately does not touch the
   * disk or resolve symlinks.
   */
  publicUrl(path: string): string {
    const segments = FsContentStore.segments(path);
    return pathToFileURL(join(this.root, ...segments)).href;
  }

  // ─── internals ────────────────────────────────────────────────────────

  /**
   * Split a caller-supplied relative path into segments.
   *
   * Rejects absolute paths, backslashes, NUL bytes and empty, `.` or `..`
   * segments — the traversal surface that makes a filesystem store dangerous.
   * Namespace policy (the reserved `.versions/` prefix) is applied separately by
   * {@link FsContentStore.resolveInside}.
   */
  private static segments(path: string): string[] {
    if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
      throw new Error(`Invalid content-store path: ${path}`);
    }
    const segments = path.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error(`Invalid content-store path: ${path}`);
    }
    return segments;
  }

  /**
   * Validate `path`, reject reserved writes when `allowReserved` is false, then
   * resolve it against the root and prove it cannot escape through a symlink.
   */
  private async resolveInside(path: string, allowReserved: boolean): Promise<string> {
    const segments = FsContentStore.segments(path);
    if (!allowReserved && isReservedDocumentPath(path)) {
      throw new Error(`Invalid or reserved document path: ${path}`);
    }
    const absolute = join(this.root, ...segments);
    await this.assertInsideRoot(absolute);
    return absolute;
  }

  /** Atomic write: stage a sibling temp file, then rename it into place. */
  private async writeObject(path: string, content: string | Uint8Array, allowReserved: boolean): Promise<void> {
    const absolute = await this.resolveInside(path, allowReserved);
    await mkdir(dirname(absolute), { recursive: true });
    await this.assertInsideRoot(absolute);

    const temporary = `${absolute}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, content);
      await rename(temporary, absolute);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Privileged writer for the reserved snapshot namespace only. */
  private async writeSnapshotObject(path: string, content: string): Promise<void> {
    if (!path.startsWith(`${VERSIONS_NAMESPACE}/`)) {
      throw new Error(`Privileged content-store writes are limited to ${VERSIONS_NAMESPACE}/: ${path}`);
    }
    await this.writeObject(path, content, true);
  }

  /** Create the root on first use and cache its symlink-free path. */
  private async ensureRoot(): Promise<string> {
    if (this.rootReal === undefined) {
      await mkdir(this.root, { recursive: true });
      this.rootReal = await realpath(this.root);
    }
    return this.rootReal;
  }

  /**
   * Prove `absolute` stays inside the resolved root.
   *
   * Walks up to the deepest existing ancestor and checks that ancestor's
   * realpath. That catches a symlinked directory anywhere on the path (the
   * target itself, when it exists, is resolved too), while still allowing the
   * final component to not exist yet for a create.
   */
  private async assertInsideRoot(absolute: string): Promise<void> {
    const rootReal = await this.ensureRoot();
    let probe = absolute;
    for (;;) {
      try {
        const probeReal = await realpath(probe);
        if (!FsContentStore.isInside(rootReal, probeReal)) {
          throw new Error(`Path escapes the content store root: ${absolute}`);
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
      }
    }
  }

  private static isInside(rootReal: string, candidate: string): boolean {
    if (candidate === rootReal) return true;
    const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
    return candidate.startsWith(prefix);
  }

  /**
   * Recursively collect regular files under `directory`.
   *
   * Symbolic links are never followed or reported: a link may point outside the
   * root, and enumeration must not become an escape hatch. Atomic-write temp
   * files are filtered so a concurrent write cannot surface a half-written
   * object to `list`/`search`.
   */
  private async walk(directory: string, relativeBase: string, out: WalkedFile[]): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relative = relativeBase ? posix.join(relativeBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await this.walk(absolute, relative, out);
      } else if (entry.isFile() && !FsContentStore.isTemporaryFile(entry.name)) {
        out.push({ absolute, relative });
      }
    }
  }

  private static isTemporaryFile(name: string): boolean {
    return /\.tmp-[0-9a-f-]{36}$/.test(name);
  }

  /** Normalise a prefix to a POSIX relative path, or `""` for the whole root. */
  private static normalizePrefix(prefix: string): string {
    if (prefix.startsWith("/") || prefix.includes("\\") || prefix.includes("\0")) {
      throw new Error(`Invalid content-store prefix: ${prefix}`);
    }
    const trimmed = prefix.replace(/^\.\//, "").replace(/\/+$/, "");
    if (trimmed === "") return "";
    const segments = trimmed.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error(`Invalid content-store prefix: ${prefix}`);
    }
    return segments.join("/");
  }

  private static matchesPrefix(relative: string, prefix: string): boolean {
    if (prefix === "") return true;
    return relative === prefix || relative.startsWith(`${prefix}/`);
  }

  /** Remove now-empty ancestor directories above a deleted file. */
  private async pruneEmptyParents(directory: string): Promise<void> {
    let current = directory;
    while (current !== this.root && FsContentStore.isInside(this.root, current)) {
      try {
        await rmdir(current);
      } catch {
        // Not empty, already gone, or not removable: stop pruning.
        return;
      }
      current = dirname(current);
    }
  }

  /** Remove every empty directory under `directory`, never the root itself. */
  private async pruneEmptyDirectories(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) await this.pruneEmptyDirectories(join(directory, entry.name));
    }
    if (directory !== this.root) {
      try {
        await rmdir(directory);
      } catch {
        // Not empty or already removed: leave it.
      }
    }
  }
}
