import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  documentSnapshotPath,
  isReservedDocumentPath,
  sha256Content,
  StorageClient,
} from "./storage.js";

const fetchMock = vi.fn();
global.fetch = fetchMock as any;

describe("StorageClient", () => {
  beforeEach(() => {
    process.env.INSFORGE_URL = "http://localhost:7130";
    process.env.INSFORGE_ACCESS_KEY = "";
    fetchMock.mockReset();
  });

  function mockOkText(text = "file content") {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(text),
    });
  }

  function mockError(status = 500, body = "storage error") {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status,
      text: () => Promise.resolve(body),
    });
  }

  // ─── constructor ──────────────────────────────────────────────

  describe("constructor", () => {
    it("creates explicit user and system credential clients", async () => {
      const userStorage = StorageClient.forUser("user-jwt", "novels");
      const systemStorage = StorageClient.forSystem("system-jwt", "skills");
      mockOkText();
      mockOkText();

      await userStorage.read("user.md");
      await systemStorage.read("system.md");

      expect(fetchMock.mock.calls[0][1]?.headers.Authorization).toBe("Bearer user-jwt");
      expect(fetchMock.mock.calls[1][1]?.headers.Authorization).toBe("Bearer system-jwt");
    });

    it("uses passed token when INSFORGE_ACCESS_KEY env is empty", async () => {
      const storage = StorageClient.forUser("my-token", "novels");
      mockOkText();
      await storage.read("test.md");

      const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers?.Authorization).toBe("Bearer my-token");
    });

    it("sets prefix from projectId", async () => {
      const storage = StorageClient.forUser("token", "novels", undefined, "proj-1");
      mockOkText();
      await storage.read("test.md");

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("proj-1%2Ftest.md");
    });

    it("uses custom baseUrl when provided", async () => {
      const storage = StorageClient.forUser("token", "novels", "http://custom:9999");
      mockOkText();
      await storage.read("test.md");

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("http://custom:9999");
    });
  });

  // ─── read ─────────────────────────────────────────────────────

  describe("read", () => {
    it("constructs correct URL with bucket and encoded path", async () => {
      const storage = StorageClient.forUser("token", "novels");
      mockOkText("hello world");
      const content = await storage.read("characters/test.md");

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("/api/storage/buckets/novels/objects/");
      expect(content).toBe("hello world");
    });

    it("URL-encodes special characters in path", async () => {
      const storage = StorageClient.forUser("token", "novels");
      mockOkText("ok");
      await storage.read("characters/林 凡.md");

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("%E6%9E%97"); // URL-encoded Chinese
    });

    it("throws on non-ok response", async () => {
      const storage = StorageClient.forUser("token", "novels");
      mockError(404, "not found");
      await expect(storage.read("missing.md")).rejects.toThrow("Storage read failed");
    });
  });

  // ─── write ────────────────────────────────────────────────────

  describe("write", () => {
    it("sends PUT with FormData containing Blob", async () => {
      const storage = StorageClient.forUser("token", "novels");
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

      await storage.write("characters/test.md", "# Hello\n\ncontent");

      const [url, opts] = fetchMock.mock.calls[0];
      expect(opts.method).toBe("PUT");
      expect(url).toContain("/api/storage/buckets/novels/objects/");

      const body = opts.body as FormData;
      expect(body).toBeDefined();
    });

    it("uses the filename portion for FormData", async () => {
      const storage = StorageClient.forUser("token", "novels");
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

      await storage.write("deep/nested/path/chapter-001.md", "content");

      const body = fetchMock.mock.calls[0][1]?.body as FormData;
      const file = body.get("file") as Blob;
      expect(file).toBeDefined();
      expect(file.type).toBe("text/markdown");
    });

    it("throws on failed write", async () => {
      const storage = StorageClient.forUser("token", "novels");
      mockError(500, "write failed");
      await expect(storage.write("test.md", "content")).rejects.toThrow(
        "Storage write failed",
      );
    });
  });

  describe("writeImmutable", () => {
    const path = `prompts/writer/v1-${"a".repeat(64)}.md`;

    it("refuses to replace an existing object", async () => {
      const storage = StorageClient.forSystem("system-jwt", "agent-resources", "http://storage");
      mockOkText("existing");

      await expect(storage.writeImmutable(path, "new"))
        .rejects.toMatchObject({ name: "StorageObjectExistsError", path });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("writes when the object is absent", async () => {
      const storage = StorageClient.forSystem("system-jwt", "agent-resources", "http://storage");
      mockError(404, "missing");
      mockOkText("created");

      await storage.writeImmutable(path, "body");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain(encodeURIComponent(path));
      expect(fetchMock.mock.calls[1][1]?.method).toBe("PUT");
    });
  });

  describe("document snapshots", () => {
    it("builds a reserved encoded path from a full SHA-256 hash", () => {
      const hash = "a".repeat(64);
      expect(documentSnapshotPath("text/第一 章.md", hash))
        .toBe(`.versions/text/%E7%AC%AC%E4%B8%80%20%E7%AB%A0.md/${hash}.md`);
      expect(isReservedDocumentPath(".versions/text/a.md")).toBe(true);
    });

    it.each(["", "/a.md", "a\\b.md", "a//b.md", "a/../b.md", ".versions", "a\0b.md"])(
      "rejects unsafe document path %j",
      (path) => expect(() => documentSnapshotPath(path, "a".repeat(64))).toThrow(),
    );

    it("verifies the supplied content hash before writing", async () => {
      const storage = StorageClient.forUser("token", "novels", "http://storage", "p1");
      await expect(storage.writeDocumentSnapshot("text/a.md", "a".repeat(64), "body"))
        .rejects.toThrow("Snapshot content hash mismatch");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reuses an existing valid immutable snapshot", async () => {
      const storage = StorageClient.forUser("token", "novels", "http://storage", "p1");
      const content = "正文";
      const hash = sha256Content(content);
      mockOkText(content);

      await expect(storage.writeDocumentSnapshot("text/a.md", hash, content))
        .resolves.toBe(documentSnapshotPath("text/a.md", hash));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("writes an absent immutable snapshot", async () => {
      const storage = StorageClient.forUser("token", "novels", "http://storage", "p1");
      const content = "正文";
      const hash = sha256Content(content);
      mockError(404, "missing");
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

      const path = await storage.writeDocumentSnapshot("text/a.md", hash, content);

      expect(path).toBe(documentSnapshotPath("text/a.md", hash));
      expect(fetchMock.mock.calls[1][1]?.method).toBe("PUT");
    });
  });

  // ─── delete ───────────────────────────────────────────────────

  describe("delete", () => {
    it("sends DELETE request", async () => {
      const storage = StorageClient.forUser("token", "novels");
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

      await storage.delete("old-file.md");

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.method).toBe("DELETE");
    });

    it("does not throw on 404", async () => {
      const storage = StorageClient.forUser("token", "novels");
      mockError(404, "not found");
      await expect(storage.delete("missing.md")).resolves.toBeUndefined();
    });

    it("throws on non-404 errors", async () => {
      const storage = StorageClient.forUser("token", "novels");
      mockError(500, "server error");
      await expect(storage.delete("test.md")).rejects.toThrow(
        "Storage delete failed",
      );
    });
  });

  describe("deletePrefix", () => {
    it("lists and deletes every matching object until the prefix is empty", async () => {
      const storage = StorageClient.forSystem("system-jwt", "novels", "http://storage");
      fetchMock
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ key: "project-1/a.md" }, { key: "project-1/b.md" }] }) })
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });

      await storage.deletePrefix("project-1/");

      expect(fetchMock.mock.calls[0][0]).toContain("prefix=project-1%2F");
      expect(fetchMock.mock.calls.slice(1, 3).map(([url]) => url)).toEqual([
        "http://storage/api/storage/buckets/novels/objects/project-1%2Fa.md",
        "http://storage/api/storage/buckets/novels/objects/project-1%2Fb.md",
      ]);
    });

    it("uses directory-boundary semantics for a prefix without a trailing slash", async () => {
      const storage = StorageClient.forSystem("system-jwt", "novels", "http://storage");
      fetchMock
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ key: "scope/a.md" }] }) })
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 404 });

      await storage.deletePrefix("scope");

      // Normalised to `scope/` so a sibling such as `scope-old.md` can never
      // match, and the prefix itself is deleted as an exact object.
      expect(fetchMock.mock.calls[0][0]).toContain("prefix=scope%2F");
      expect(fetchMock.mock.calls.map(([url]) => url)).toContain(
        "http://storage/api/storage/buckets/novels/objects/scope",
      );
    });

    it("rejects user-scoped bulk deletion", async () => {
      await expect(StorageClient.forUser("user-jwt").deletePrefix("project-1/"))
        .rejects.toThrow("system storage credentials");
    });
  });

  // ─── search ───────────────────────────────────────────────────

  describe("search", () => {
    it("returns empty when scope has no files", async () => {
      const storage = StorageClient.forUser("token", "novels");
      // list() returns [] by default → search has nothing to scan
      const results = await storage.search("keyword", "characters");
      expect(results).toEqual([]);
    });

    it("returns matches with path and snippet from file content", async () => {
      const storage = StorageClient.forUser("token", "novels");

      // Spy on list to return a file, and on read to return searchable content
      const listSpy = vi.spyOn(storage, "list").mockResolvedValue(["chars/lin-fan.md"]);
      const readSpy = vi.spyOn(storage, "read").mockResolvedValue(
        "name: 林凡\nrole: protagonist\narc_stage: growth\n",
      );

      const results = await storage.search("protagonist", "characters");

      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("chars/lin-fan.md");
      expect(results[0].snippet).toBe("role: protagonist");

      listSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("returns multiple matches from same file", async () => {
      const storage = StorageClient.forUser("token", "novels");
      const listSpy = vi.spyOn(storage, "list").mockResolvedValue(["worldview/qi.md"]);
      const readSpy = vi.spyOn(storage, "read").mockResolvedValue(
        "灵气是基础力量\n灵气修炼需要灵根\n灵气浓度决定修炼速度",
      );

      const results = await storage.search("灵气", "worldview");

      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((r) => r.path === "worldview/qi.md")).toBe(true);

      listSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("truncates snippets at 200 characters", async () => {
      const storage = StorageClient.forUser("token", "novels");
      const longLine = "A".repeat(250) + " MATCH " + "B".repeat(100);
      const listSpy = vi.spyOn(storage, "list").mockResolvedValue(["test.md"]);
      const readSpy = vi.spyOn(storage, "read").mockResolvedValue(longLine);

      const results = await storage.search("match", "scope");

      expect(results).toHaveLength(1);
      expect(results[0].snippet.length).toBeLessThanOrEqual(200);

      listSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("caps results at 20", async () => {
      const storage = StorageClient.forUser("token", "novels");
      // Create 1 file with 30 matching lines
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i}: match`);
      const listSpy = vi.spyOn(storage, "list").mockResolvedValue(["test.md"]);
      const readSpy = vi.spyOn(storage, "read").mockResolvedValue(lines.join("\n"));

      const results = await storage.search("match", "scope");

      expect(results.length).toBe(20);

      listSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("matches case-insensitively", async () => {
      const storage = StorageClient.forUser("token", "novels");
      const listSpy = vi.spyOn(storage, "list").mockResolvedValue(["test.md"]);
      const readSpy = vi.spyOn(storage, "read").mockResolvedValue("UPPERCASE LINE");

      const results = await storage.search("uppercase", "scope");

      expect(results).toHaveLength(1);
      expect(results[0].snippet).toContain("UPPERCASE LINE");

      listSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("skips files that fail to read", async () => {
      const storage = StorageClient.forUser("token", "novels");
      const listSpy = vi.spyOn(storage, "list").mockResolvedValue([
        "broken.md",
        "good.md",
      ]);
      const readSpy = vi.spyOn(storage, "read");
      readSpy.mockRejectedValueOnce(new Error("read failed")); // broken.md
      readSpy.mockResolvedValueOnce("line with needle");       // good.md

      const results = await storage.search("needle", "scope");

      // Only good.md should be in results
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("good.md");

      listSpy.mockRestore();
      readSpy.mockRestore();
    });

    it("returns empty when no lines match", async () => {
      const storage = StorageClient.forUser("token", "novels");
      const listSpy = vi.spyOn(storage, "list").mockResolvedValue(["test.md"]);
      const readSpy = vi.spyOn(storage, "read").mockResolvedValue("nothing relevant here");

      const results = await storage.search("keyword", "scope");

      expect(results).toEqual([]);

      listSpy.mockRestore();
      readSpy.mockRestore();
    });
  });

  // ─── list ─────────────────────────────────────────────────────

  describe("list", () => {
    it("returns empty array (DB-driven fallback)", async () => {
      const storage = StorageClient.forUser("token", "novels");
      const files = await storage.list("characters");
      expect(files).toEqual([]);
    });
  });
});
