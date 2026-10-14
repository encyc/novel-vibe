import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeContentStoreContract } from "./content-store.contract.js";
import { StorageObjectExistsError, documentSnapshotPath, sha256Content } from "./content-store.js";
import { FsContentStore } from "./fs-content-store.js";

// The shared suite proves the port contract; the FS-specific suite below proves
// the filesystem-only safety properties (traversal, symlink escape, atomicity).
describeContentStoreContract("FsContentStore", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-fs-store-contract-"));
  return {
    store: new FsContentStore(root),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
});

describe("FsContentStore filesystem safety", () => {
  /** Temp parent that holds both the store root and the "outside" directory. */
  let sandbox: string;
  let root: string;
  let store: FsContentStore;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "novel-fs-store-"));
    root = join(sandbox, "content");
    await mkdir(root, { recursive: true });
    store = new FsContentStore(root);
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  // ─── path traversal ───────────────────────────────────────────────────

  it("rejects traversal, absolute, backslash, empty-segment and reserved paths", async () => {
    const rejected = [
      "../escape.md",
      "a/../../escape.md",
      "/etc/passwd",
      "a\\b.md",
      "a//b.md",
      "./a.md",
      "",
      ".versions/doc.md",
      ".versions/nested/doc.md",
    ];

    for (const path of rejected) {
      await expect(store.write(path, "x")).rejects.toThrow();
      await expect(store.writeImmutable(path, "x")).rejects.toThrow();
      await expect(store.delete(path)).rejects.toThrow();
      await expect(store.read(path)).rejects.toThrow();
    }

    // Nothing leaked next to (or above) the root.
    expect(existsSync(join(sandbox, "escape.md"))).toBe(false);
    expect(existsSync(join(root, "escape.md"))).toBe(false);
    expect(existsSync(join(root, "a"))).toBe(false);
  });

  it("rejects invalid list and deletePrefix prefixes", async () => {
    await expect(store.list("../outside")).rejects.toThrow();
    await expect(store.list("/etc")).rejects.toThrow();
    await expect(store.list("a//b")).rejects.toThrow();
    await expect(store.deletePrefix("../outside")).rejects.toThrow();
    await expect(store.deletePrefix("a\\b")).rejects.toThrow();
  });

  // ─── symlink escape ───────────────────────────────────────────────────

  it("refuses reads and writes that escape through a symlinked directory", async () => {
    const outside = join(sandbox, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.md"), "secret");
    await symlink(outside, join(root, "link"), "dir");

    await expect(store.write("link/evil.md", "evil")).rejects.toThrow();
    await expect(store.writeImmutable("link/evil.md", "evil")).rejects.toThrow();
    await expect(store.read("link/secret.md")).rejects.toThrow();
    await expect(store.delete("link/secret.md")).rejects.toThrow();

    // The escape target was never created, and enumeration does not follow it.
    expect(existsSync(join(outside, "evil.md"))).toBe(false);
    expect(existsSync(join(outside, "secret.md"))).toBe(true);
    expect(await store.list("")).toEqual([]);
  });

  it("refuses reads through a symlinked file that points outside the root", async () => {
    const outside = join(sandbox, "outside-file.md");
    await writeFile(outside, "outside content");
    await symlink(outside, join(root, "alias.md"), "file");

    await expect(store.read("alias.md")).rejects.toThrow();
    expect(await store.list("")).toEqual([]);
  });

  // ─── atomicity and concurrency ────────────────────────────────────────

  it("keeps concurrent writes to the same path whole and leaves no temp files", async () => {
    const payloads = Array.from({ length: 20 }, (_, index) => `payload-${index}\n`);

    await Promise.all(payloads.map((payload) => store.write("race/doc.md", payload)));

    const final = await store.read("race/doc.md");
    expect(payloads).toContain(final);
    expect(await store.list("race")).toEqual(["race/doc.md"]);
  });

  it("lets exactly one concurrent immutable write win", async () => {
    const payloads = Array.from({ length: 10 }, (_, index) => `immutable-${index}`);

    const results = await Promise.allSettled(
      payloads.map((payload) => store.writeImmutable("resources/prompt.md", payload)),
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(payloads.length - 1);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(StorageObjectExistsError);
    }
    expect(payloads).toContain(await store.read("resources/prompt.md"));
  });

  // ─── listing and snapshots ────────────────────────────────────────────

  it("lists relative POSIX paths in stable sorted order", async () => {
    await store.write("b/z.md", "z");
    await store.write("a/y.md", "y");
    await store.write("a/x.md", "x");
    await store.write("top.md", "top");

    expect(await store.list("")).toEqual(["a/x.md", "a/y.md", "b/z.md", "top.md"]);
    expect(await store.list("a")).toEqual(["a/x.md", "a/y.md"]);
    expect(await store.list("a/")).toEqual(["a/x.md", "a/y.md"]);
    expect(await store.list("missing")).toEqual([]);
  });

  it("stores snapshots at the shared encoded path for non-ASCII document names", async () => {
    const docPath = "chapters/第一卷 第1章.md";
    const content = "# 第一章\n\n正文\n";
    const hash = sha256Content(content);

    const snapshotPath = await store.writeDocumentSnapshot(docPath, hash, content);

    expect(snapshotPath).toBe(documentSnapshotPath(docPath, hash));
    expect(snapshotPath.startsWith(".versions/chapters/")).toBe(true);
    expect(snapshotPath.endsWith(`/${hash}.md`)).toBe(true);
    await expect(store.read(snapshotPath)).resolves.toBe(content);
    expect(await store.list(".versions")).toEqual([snapshotPath]);
  });

  it("purges the reserved snapshot namespace through deletePrefix", async () => {
    const content = "# snapshot\n";
    const hash = sha256Content(content);
    const snapshotPath = await store.writeDocumentSnapshot("doc.md", hash, content);

    await store.deletePrefix(".versions");

    await expect(store.read(snapshotPath)).rejects.toThrow();
    await expect(store.deletePrefix(".versions")).resolves.toBeUndefined();
  });

  it("treats a prefix as a directory boundary, not a raw string prefix", async () => {
    await store.write("scope/a.md", "a");
    await store.write("scope-old.md", "sibling");
    await store.write("scoped/deep.md", "nested");

    await store.deletePrefix("scope");

    await expect(store.read("scope/a.md")).rejects.toThrow();
    // A raw string prefix would have swept these two as well.
    await expect(store.read("scope-old.md")).resolves.toBe("sibling");
    await expect(store.read("scoped/deep.md")).resolves.toBe("nested");
  });

  it("purges the whole project root for an empty prefix without removing the root", async () => {
    await store.write("a.md", "a");
    await store.write("nested/b.md", "b");
    const snapshotPath = await store.writeDocumentSnapshot("a.md", sha256Content("a"), "a");

    await store.deletePrefix("");

    expect(await store.list("")).toEqual([]);
    await expect(store.read(snapshotPath)).rejects.toThrow();
    expect(existsSync(root)).toBe(true);
  });

  it("returns a file URL for local objects and rejects invalid paths", async () => {
    await store.write("doc.md", "x");

    expect(store.publicUrl("doc.md")).toBe(pathToFileURL(join(root, "doc.md")).href);
    expect(store.publicUrl("doc.md").startsWith("file://")).toBe(true);
    expect(() => store.publicUrl("../escape.md")).toThrow();
  });

  it("deletes a nested document and prunes the empty directories it leaves", async () => {
    await store.write("deep/nested/doc.md", "content");
    await store.delete("deep/nested/doc.md");

    expect(existsSync(join(root, "deep"))).toBe(false);
    // Deleting the same missing path twice stays a no-op.
    await expect(store.delete("deep/nested/doc.md")).resolves.toBeUndefined();
  });

  it("keeps binary payloads readable after an atomic write", async () => {
    await store.writeBytes("assets/raw.bin", new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf");

    const bytes = await readFile(join(root, "assets/raw.bin"));
    expect(Array.from(bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
  });
});
