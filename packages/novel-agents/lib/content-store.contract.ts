/**
 * Reusable conformance suite for the {@link ContentStore} port.
 *
 * Any implementation (S3-backed `StorageClient`, filesystem-backed
 * `FsContentStore`, future object stores) can run the exact same assertions by
 * calling {@link describeContentStoreContract} from its own test file. Keeping
 * the suite here — rather than duplicating it per implementation — is what makes
 * the storage seam replaceable: a regression in one transport cannot be hidden
 * by a weaker copy of the tests.
 *
 * Two tiers:
 * - Tier 1 runs for every implementation and only asserts behaviour the port
 *   itself guarantees.
 * - Tier 2 asserts listing/search, which are capability-dependent. It is
 *   skipped (not failed) when `store.supportsListing === false`, because the
 *   S3 implementation deliberately reports no listing surface.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  StorageObjectExistsError,
  documentSnapshotPath,
  sha256Content,
  type ContentStore,
} from "./content-store.js";

export interface ContentStoreHarness {
  store: ContentStore;
  cleanup(): Promise<void>;
}

const DOC_PATH = "documents/chapter-1.md";

/**
 * Register the ContentStore conformance suite under `name`.
 *
 * `createStore` is invoked before every test and must return a store backed by
 * an empty, isolated namespace plus a `cleanup()` that releases it. Isolation
 * per test is required: several assertions delete prefixes or write the same
 * immutable key twice.
 */
export function describeContentStoreContract(
  name: string,
  createStore: () => Promise<ContentStoreHarness>,
): void {
  describe(`ContentStore contract (${name})`, () => {
    let harness!: ContentStoreHarness;

    beforeEach(async () => {
      harness = await createStore();
    });

    afterEach(async () => {
      if (harness) await harness.cleanup();
    });

    // ─── Tier 1: transport-independent guarantees ─────────────────────────

    it("round-trips written content through read", async () => {
      const content = "# Chapter 1\n\nHello world.\n";
      await harness.store.write(DOC_PATH, content);

      await expect(harness.store.read(DOC_PATH)).resolves.toBe(content);
    });

    it("rejects reading a path that was never written", async () => {
      await expect(harness.store.read("documents/missing.md")).rejects.toThrow();
    });

    it("replaces the previous content on overwrite", async () => {
      await harness.store.write(DOC_PATH, "first revision");
      await harness.store.write(DOC_PATH, "second revision");

      await expect(harness.store.read(DOC_PATH)).resolves.toBe("second revision");
    });

    it("round-trips byte writes through read", async () => {
      const text = "binary payload ✓\n";
      await harness.store.writeBytes("assets/cover.txt", new TextEncoder().encode(text), "text/plain");

      await expect(harness.store.read("assets/cover.txt")).resolves.toBe(text);
    });

    it("deletes a written path and tolerates deleting a missing path", async () => {
      await harness.store.write(DOC_PATH, "content");
      await harness.store.delete(DOC_PATH);

      await expect(harness.store.read(DOC_PATH)).rejects.toThrow();
      await expect(harness.store.delete("documents/never-existed.md")).resolves.toBeUndefined();
    });

    it("deletes every object under a prefix and is idempotent", async () => {
      await harness.store.write("scope/a.md", "a");
      await harness.store.write("scope/nested/b.md", "b");
      await harness.store.write("outside.md", "outside");

      await harness.store.deletePrefix("scope");

      await expect(harness.store.read("scope/a.md")).rejects.toThrow();
      await expect(harness.store.read("scope/nested/b.md")).rejects.toThrow();
      await expect(harness.store.read("outside.md")).resolves.toBe("outside");
      // Idempotent: purging an already-empty prefix must not throw.
      await expect(harness.store.deletePrefix("scope")).resolves.toBeUndefined();
    });

    it("creates an immutable object once and refuses to replace it", async () => {
      await harness.store.writeImmutable("resources/prompt.md", "version one");
      await expect(harness.store.read("resources/prompt.md")).resolves.toBe("version one");

      await expect(harness.store.writeImmutable("resources/prompt.md", "version two"))
        .rejects.toBeInstanceOf(StorageObjectExistsError);
      await expect(harness.store.read("resources/prompt.md")).resolves.toBe("version one");
    });

    it("stores a content-addressed snapshot at the shared path and is idempotent", async () => {
      const content = "# Versioned\n\nbody\n";
      const hash = sha256Content(content);

      const snapshotPath = await harness.store.writeDocumentSnapshot(DOC_PATH, hash, content);

      expect(snapshotPath).toBe(`.versions/${DOC_PATH}/${hash}.md`);
      expect(snapshotPath).toBe(documentSnapshotPath(DOC_PATH, hash));
      await expect(harness.store.read(snapshotPath)).resolves.toBe(content);
      // Re-storing identical content is success and returns the same path.
      await expect(harness.store.writeDocumentSnapshot(DOC_PATH, hash, content)).resolves.toBe(snapshotPath);
    });

    it("refuses a snapshot whose declared hash disagrees with the payload", async () => {
      const content = "actual content";
      const wrongHash = sha256Content("different content");

      await expect(harness.store.writeDocumentSnapshot(DOC_PATH, wrongHash, content))
        .rejects.toThrow(/hash mismatch/i);
      // The rejected snapshot must not have been written.
      await expect(harness.store.read(documentSnapshotPath(DOC_PATH, wrongHash))).rejects.toThrow();
    });

    it("exposes a non-empty public URL for a stored path", () => {
      const url = harness.store.publicUrl(DOC_PATH);

      expect(typeof url).toBe("string");
      expect(url.length).toBeGreaterThan(0);
    });

    // ─── Tier 2: listing-dependent capability ─────────────────────────────

    it("lists the real objects under a prefix when listing is supported", async (ctx) => {
      const store = harness.store;
      if (!store.supportsListing) ctx.skip("store does not support listing");

      await store.write("scope/b.md", "b");
      await store.write("scope/a.md", "a");
      await store.write("other.md", "other");

      await expect(store.list("scope")).resolves.toEqual(["scope/a.md", "scope/b.md"]);
    });

    it("finds a keyword with a snippet when listing is supported", async (ctx) => {
      const store = harness.store;
      if (!store.supportsListing) ctx.skip("store does not support listing");

      await store.write("scope/a.md", "Intro line\nA needle sits here.\nOutro\n");
      await store.write("scope/b.md", "nothing to see\n");

      const hits = await store.search("needle", "scope");

      expect(hits).toHaveLength(1);
      expect(hits[0].path).toBe("scope/a.md");
      expect(hits[0].snippet).toContain("needle");
    });
  });
}
