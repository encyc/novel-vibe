import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createFileTools,
  createReadDocTool,
  createWriteDocTool,
  createDeleteDocTool,
  createSearchDocsTool,
  createListDocsTool,
  createChapterContextTool,
  createLoadSkillTool,
  createToolContext,
  lastNoteSection,
  tailNoteSections,
  type ToolContext,
} from "./file-tools.js";
import { documentWrites } from "../lib/document-write-coordinator.js";
import { createHash } from "node:crypto";

vi.mock("../lib/agent-resources/runtime.js", () => ({
  getAgentResourceService: () => ({
    load: vi.fn(async (input: { fallback?: () => string | null }) => ({
      content: input.fallback?.() ?? "",
      source: "fallback",
    })),
  }),
}));

function mockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    storage: {
      read: vi.fn(),
      write: vi.fn(),
      search: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
    } as any,
    skillsStorage: {
      read: vi.fn(),
    } as any,
    db: {
      listDocuments: vi.fn(),
      getDocument: vi.fn(),
      getSkillForUser: vi.fn(),
      listWorkspaceSkills: vi.fn().mockResolvedValue([{ skill_slug: "my-style", enabled: true }]),
      listSkillRoles: vi.fn().mockResolvedValue(["writer"]),
    } as any,
    projectId: "test-project-id",
    userId: "user-1",
    sessionId: "session-1",
    turnId: "turn-1",
    documentWriter: {
      write: vi.fn().mockResolvedValue({
        changed: true,
        path: "characters/new.md",
        versionId: "version-1",
        versionNo: 1,
        beforeHash: null,
        afterHash: "new-hash",
        indexed: true,
        addedLines: 2,
        deletedLines: 0,
        changedSections: ["第一章"],
      }),
    },
    assertProjectWritable: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("file-tools", () => {
  it("uses the caller JWT for RLS-protected storage", () => {
    process.env.JWT_SECRET = "test-secret-32-chars-minimum!!";

    const ctx = createToolContext("user-jwt", "project-1");

    expect((ctx.storage as any).token).toBe("user-jwt");
    expect((ctx.skillsStorage as any).token).toBe("user-jwt");
    expect((ctx.db as any).token).toBe("user-jwt");
    expect((ctx.db as any).mode).toBe("user");
  });

  describe("createReadDocTool", () => {
    it("has correct metadata", () => {
      const tool = createReadDocTool(mockContext());
      expect(tool.name).toBe("read_doc");
      expect(tool.label).toBe("Read Document");
      expect(tool.description).toBeTruthy();
    });

    it("reads file content via storage", async () => {
      const ctx = mockContext();
      (ctx.storage.read as any).mockResolvedValue("# Hello\n\nWorld");
      const tool = createReadDocTool(ctx);

      const result = await tool.execute("call-1", { path: "characters/test.md" }, undefined as any, undefined);

      expect(result.content[0].text).toContain("# Hello");
      expect(result.details.path).toBe("characters/test.md");
      expect(result.isError).toBeUndefined();
    });

    it("returns error when storage.read throws", async () => {
      const ctx = mockContext();
      (ctx.storage.read as any).mockRejectedValue(new Error("not found"));
      const tool = createReadDocTool(ctx);

      const result = await tool.execute("call-1", { path: "missing.md" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error reading");
    });

    it("returns numbered lines for an offset/limit window", async () => {
      const ctx = mockContext();
      const body = Array.from({ length: 30 }, (_, i) => `第${i + 1}行`).join("\n");
      (ctx.storage.read as any).mockResolvedValue(body);
      const tool = createReadDocTool(ctx);

      const result = await tool.execute("call-1a", { path: "characters/lin-fan.md", offset: 28, limit: 5 }, undefined as any, undefined);

      expect(result.content[0].text).toContain("28: 第28行");
      expect(result.content[0].text).toContain("30: 第30行");
      expect(result.content[0].text).not.toContain("27: ");
      expect(result.details).toMatchObject({ totalLines: 30, returnedLines: 3, offset: 28, truncated: false });
    });

    it("reports a mid-file window as truncated when more lines follow", async () => {
      const ctx = mockContext();
      const body = Array.from({ length: 30 }, (_, i) => `第${i + 1}行`).join("\n");
      (ctx.storage.read as any).mockResolvedValue(body);
      const tool = createReadDocTool(ctx);

      const result = await tool.execute("call-1b", { path: "text/ch-001.md", offset: 5, limit: 10 }, undefined as any, undefined);

      expect(result.details).toMatchObject({ totalLines: 30, returnedLines: 10, offset: 5, truncated: true });
    });

    it("reports an offset past the end of file without error", async () => {
      const ctx = mockContext();
      (ctx.storage.read as any).mockResolvedValue("只有一行");
      const tool = createReadDocTool(ctx);

      const result = await tool.execute("call-1c", { path: "text/ch-001.md", offset: 50 }, undefined as any, undefined);

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("beyond end of file");
      expect(result.details.totalLines).toBe(1);
    });
  });

  describe("createWriteDocTool", () => {
    it("has correct metadata", () => {
      const tool = createWriteDocTool(mockContext());
      expect(tool.name).toBe("write_doc");
      expect(tool.label).toBe("Write Document");
    });

    it("writes content through the versioned writer with provenance", async () => {
      const ctx = mockContext();
      (ctx.storage.write as any).mockResolvedValue(undefined);
      const tool = createWriteDocTool(ctx);

      const result = await tool.execute(
        "call-2",
        { path: "characters/new.md", content: "# New Doc" },
        undefined as any,
        undefined,
      );

      expect(result.content[0].text).toContain("Document written");
      expect(result.details.path).toBe("characters/new.md");
      expect(ctx.documentWriter.write).toHaveBeenCalledWith({
        projectId: "test-project-id",
        path: "characters/new.md",
        content: "# New Doc",
        source: {
          type: "agent",
          userId: "user-1",
          agentId: "chief_editor",
          sessionId: "session-1",
          turnId: "turn-1",
          toolCallId: "call-2",
        },
      });
      expect(result.details).toMatchObject({ changed: true, versionId: "version-1", versionNo: 1 });
    });

    it("uses system-job provenance for a background continuity write", async () => {
      const ctx = mockContext({
        userId: undefined,
        sessionId: undefined,
        turnId: undefined,
        systemJobId: "continuity-job-1",
      });
      const tool = createWriteDocTool(ctx);

      await tool.execute(
        "call-background",
        { path: "summary/story-so-far.md", content: "# Updated summary" },
        undefined as any,
        undefined,
      );

      expect(ctx.documentWriter.write).toHaveBeenCalledWith({
        projectId: "test-project-id",
        path: "summary/story-so-far.md",
        content: "# Updated summary",
        source: { type: "system", jobId: "continuity-job-1" },
      });
    });

    it("rejects malformed registered frontmatter before calling the writer", async () => {
      const ctx = mockContext();
      const tool = createWriteDocTool(ctx, "writer");

      const result = await tool.execute("call-invalid", {
        path: "text/ch-001.md",
        content: "---\ntype: chapter-text\nchapter: 1\nstatus: draft\n---\n正文",
      }, undefined as any, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid chapter-text frontmatter");
      expect(ctx.documentWriter.write).not.toHaveBeenCalled();
    });

    it("accepts a long append-only summary from script_supervisor", async () => {
      const ctx = mockContext();
      (ctx.db.getDocument as any).mockResolvedValue(null);
      const tool = createWriteDocTool(ctx, "script_supervisor");
      const content = `---\ntype: story-summary\nstatus: draft\nlatest_chapter: 3\nupdated_at: 2026-07-10T00:00:00.000Z\nword_count: 3001\n---\n## Ch.1 起\n\n事件一\n\n## Ch.2 承\n\n事件二\n\n## Ch.3 转\n\n${"word ".repeat(3001)}`;

      const result = await tool.execute("call-summary-limit", { path: "summary/story-so-far.md", content }, undefined as any, undefined);

      expect(result.isError).toBeUndefined();
      expect(ctx.documentWriter.write).toHaveBeenCalled();
    });

    it("rejects non-canonical supervisor output paths", async () => {
      const ctx = mockContext();
      const tool = createWriteDocTool(ctx, "script_supervisor");

      const result = await tool.execute("call-summary-path", {
        path: "summary/chapter-003-summary.md",
        content: "---\ntype: story-summary\nstatus: draft\nlatest_chapter: 3\nupdated_at: now\nword_count: 1\n---\n# Summary",
      }, undefined as any, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("canonical");
      expect(ctx.storage.write).not.toHaveBeenCalled();
    });

    it("rejects writes when the project is read-only", async () => {
      const ctx = mockContext({
        assertProjectWritable: vi.fn().mockRejectedValue(new Error("Project is archived and cannot be modified")),
      });
      const tool = createWriteDocTool(ctx);

      const result = await tool.execute(
        "call-read-only",
        { path: "characters/new.md", content: "# New Doc" },
        undefined as any,
        undefined,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("archived");
      expect(ctx.storage.write).not.toHaveBeenCalled();
    });

    it("returns error when storage.write throws", async () => {
      const ctx = mockContext();
      (ctx.documentWriter.write as any).mockRejectedValue(new Error("write failed"));
      const tool = createWriteDocTool(ctx);

      const result = await tool.execute("call-3", { path: "x.md", content: "x" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
    });

    it("delegates write serialization to the versioned writer", async () => {
      const ctx = mockContext();
      const tool = createWriteDocTool(ctx);

      await tool.execute(
        "call-coordinated-write",
        { path: "text/chapter-001.md", content: "# Chapter" },
        undefined as any,
        undefined,
      );

      expect(ctx.documentWriter.write).toHaveBeenCalledOnce();
    });

    it("returns a safe successful no-op result", async () => {
      const ctx = mockContext();
      (ctx.documentWriter.write as any).mockResolvedValue({
        changed: false, path: "text/chapter-001.md", afterHash: "hash", indexed: false,
      });
      const result = await createWriteDocTool(ctx, "writer").execute(
        "call-noop", { path: "text/chapter-001.md", content: "same" }, undefined as any, undefined,
      );
      expect(result.details).toEqual({ changed: false, path: "text/chapter-001.md" });
      expect(result.isError).toBeUndefined();
    });

    it("rejects reserved version paths before calling the writer", async () => {
      const ctx = mockContext();
      const result = await createWriteDocTool(ctx).execute(
        "call-reserved", { path: ".versions/foo.md", content: "x" }, undefined as any, undefined,
      );
      expect(result.isError).toBe(true);
      expect(ctx.documentWriter.write).not.toHaveBeenCalled();
    });
  });

  describe("createDeleteDocTool", () => {
    it("rejects deletes when the project is read-only", async () => {
      const ctx = mockContext({
        assertProjectWritable: vi.fn().mockRejectedValue(new Error("Project is trash and cannot be modified")),
      });
      const tool = createDeleteDocTool(ctx);

      const result = await tool.execute(
        "call-read-only-delete",
        { path: "text/chapter-001.md" },
        undefined as any,
        undefined,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("trash");
      expect(ctx.storage.delete).not.toHaveBeenCalled();
    });

    it("coordinates the complete delete by project and path", async () => {
      const ctx = mockContext({
        db: {
          deleteDocument: vi.fn(),
          deleteForeshadow: vi.fn(),
        } as any,
      });
      const run = vi.spyOn(documentWrites, "run");
      const tool = createDeleteDocTool(ctx);

      await tool.execute(
        "call-coordinated-delete",
        { path: "text/chapter-001.md" },
        undefined as any,
        undefined,
      );

      expect(run).toHaveBeenCalledWith(
        "test-project-id:text/chapter-001.md",
        expect.any(Function),
      );
      expect(ctx.storage.delete).toHaveBeenCalledWith("text/chapter-001.md");
      expect(ctx.db.deleteDocument).toHaveBeenCalledWith(
        "test-project-id",
        "text/chapter-001.md",
      );
    });
  });

  describe("createSearchDocsTool", () => {
    function searchFixtures(ctx: ReturnType<typeof mockContext>) {
      const allDocs = [
        { doc_path: "characters/lin-fan.md", doc_type: "character", status: "confirmed" },
        { doc_path: "characters/xiao-yan.md", doc_type: "character", status: "confirmed" },
        { doc_path: "text/ch-001.md", doc_type: "chapter-text", status: "confirmed", chapter_num: 1 },
        { doc_path: "text/ch-002.md", doc_type: "chapter-text", status: "confirmed", chapter_num: 2 },
      ];
      (ctx.db.listDocuments as any).mockImplementation(async (_pid: string, docType?: string) =>
        docType ? allDocs.filter((d) => d.doc_type === docType) : allDocs);
      (ctx.storage.read as any).mockImplementation(async (path: string) => {
        if (path === "characters/lin-fan.md") return "---\ntype: character\nname: 林凡\n---\n# 林凡\n火属性灵根，脾气急躁";
        if (path === "characters/xiao-yan.md") return "---\ntype: character\nname: 萧炎\n---\n# 萧炎\n冰属性灵根";
        if (path === "text/ch-001.md") return "---\ntype: chapter-text\nchapter: 1\n---\n# 第一章\n林凡展现出火属性灵根。\n风雪初歇。";
        return "---\ntype: chapter-text\nchapter: 2\n---\n# 第二章\n再无火属性传说。";
      });
    }

    it("matches a regular expression across lines with line numbers", async () => {
      const ctx = mockContext();
      searchFixtures(ctx);
      const tool = createSearchDocsTool(ctx);

      const result = await tool.execute("call-4", { query: "火属性灵" }, undefined as any, undefined);

      expect(result.content[0].text).toContain("characters/lin-fan.md:6:");
      expect(result.content[0].text).toContain("text/ch-001.md:6:");
      expect(result.details.totalMatches).toBe(2);
      expect(ctx.db.listDocuments).toHaveBeenCalledWith("test-project-id", undefined);
    });

    it("scope filters by doc_type through the index", async () => {
      const ctx = mockContext();
      searchFixtures(ctx);
      const tool = createSearchDocsTool(ctx);

      const result = await tool.execute("call-4a", { query: "火属性", scope: "characters" }, undefined as any, undefined);

      expect(result.content[0].text).toContain("characters/lin-fan.md:6:");
      expect(result.content[0].text).not.toContain("text/ch-001.md");
      expect(ctx.db.listDocuments).toHaveBeenCalledWith("test-project-id", "character");
    });

    it("chapter_range filters by index chapter_num before reading files", async () => {
      const ctx = mockContext();
      searchFixtures(ctx);
      const tool = createSearchDocsTool(ctx);

      const result = await tool.execute("call-4b", { query: "火属性", chapter_range: [2, 99] }, undefined as any, undefined);

      expect(result.content[0].text).toContain("text/ch-002.md");
      expect(result.content[0].text).not.toContain("text/ch-001.md");
      expect(result.content[0].text).not.toContain("characters/lin-fan.md");
    });

    it("supports files and count output modes", async () => {
      const ctx = mockContext();
      searchFixtures(ctx);
      const tool = createSearchDocsTool(ctx);

      const files = await tool.execute("call-4c", { query: "火属性", mode: "files" }, undefined as any, undefined);
      expect(files.content[0].text).toContain("characters/lin-fan.md (1 match)");
      expect(files.content[0].text).toContain("text/ch-002.md (1 match)");

      const count = await tool.execute("call-4d", { query: "火属性", mode: "count" }, undefined as any, undefined);
      expect(count.content[0].text).toContain("characters/lin-fan.md: 1");
      expect(count.details.totalMatches).toBe(3);
    });

    it("shows context lines around matches", async () => {
      const ctx = mockContext();
      searchFixtures(ctx);
      const tool = createSearchDocsTool(ctx);

      const result = await tool.execute("call-4e", { query: "火属性灵根", context_lines: 1 }, undefined as any, undefined);

      expect(result.content[0].text).toContain("text/ch-001.md:5- ");
      expect(result.content[0].text).toContain("text/ch-001.md:6: ");
      expect(result.content[0].text).toContain("text/ch-001.md:7- ");
    });

    it("paginates content matches and reports the remainder honestly", async () => {
      const ctx = mockContext();
      (ctx.db.listDocuments as any).mockResolvedValue([
        { doc_path: "text/ch-001.md", doc_type: "chapter-text", status: "confirmed", chapter_num: 1 },
      ]);
      const body = Array.from({ length: 120 }, (_, i) => `第${i + 1}次提到灵石。`).join("\n");
      (ctx.storage.read as any).mockResolvedValue(`---\ntype: chapter-text\nchapter: 1\n---\n${body}`);
      const tool = createSearchDocsTool(ctx);

      const page1 = await tool.execute("call-4f", { query: "灵石" }, undefined as any, undefined);
      expect(page1.details.totalMatches).toBe(120);
      expect(page1.details.nextCursor).toBeTruthy();
      expect(page1.content[0].text).toContain("matches 1-50 of 120");
      expect(page1.content[0].text).toContain("第50次提到灵石");
      expect(page1.content[0].text).not.toContain("第51次提到灵石");

      const cursor = page1.details.nextCursor as string;
      const page2 = await tool.execute("call-4g", { query: "灵石", cursor }, undefined as any, undefined);
      expect(page2.content[0].text).toContain("matches 51-100 of 120");
      expect(page2.content[0].text).toContain("第51次提到灵石");

      const page3 = await tool.execute("call-4h", { query: "灵石", cursor: page2.details.nextCursor as string }, undefined as any, undefined);
      expect(page3.content[0].text).toContain("matches 101-120 of 120");
      expect(page3.details.nextCursor).toBeUndefined();
    });

    it("returns no-results message when no matches found", async () => {
      const ctx = mockContext();
      searchFixtures(ctx);
      const tool = createSearchDocsTool(ctx);

      const result = await tool.execute("call-5", { query: "pyroblast" }, undefined as any, undefined);

      expect(result.content[0].text).toContain("No results found");
      expect(result.details.count).toBe(0);
    });

    it("returns error on invalid regex", async () => {
      const ctx = mockContext();
      searchFixtures(ctx);
      const tool = createSearchDocsTool(ctx);

      const result = await tool.execute("call-6", { query: "([bad" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid regex");
    });

    it("returns error on DB failure", async () => {
      const ctx = mockContext();
      (ctx.db.listDocuments as any).mockRejectedValue(new Error("db error"));
      const tool = createSearchDocsTool(ctx);

      const result = await tool.execute("call-6a", { query: "x" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Search error");
    });

    it("skips unreadable files gracefully", async () => {
      const ctx = mockContext();
      (ctx.db.listDocuments as any).mockResolvedValue([
        { doc_path: "characters/broken.md" },
        { doc_path: "characters/ok.md" },
      ]);
      (ctx.storage.read as any)
        .mockRejectedValueOnce(new Error("not found"))
        .mockResolvedValueOnce("---\ntype: character\n---\n# OK\nwater attribute");

      const tool = createSearchDocsTool(ctx);
      const result = await tool.execute("call-6b", { query: "water" }, undefined as any, undefined);

      expect(result.content[0].text).toContain("characters/ok.md:5:");
      expect(result.details.count).toBe(1);
    });  });

  describe("createListDocsTool", () => {
    it("formats document list with status", async () => {
      const ctx = mockContext();
      (ctx.db.listDocuments as any).mockResolvedValue([
        { doc_path: "chars/lin-fan.md", status: "draft", name: "林凡" },
      ]);
      const tool = createListDocsTool(ctx);

      const result = await tool.execute("call-7", { doc_type: "character" }, undefined as any, undefined);

      expect(result.content[0].text).toContain("[draft]");
      expect(result.content[0].text).toContain("林凡");
      expect(result.details.count).toBe(1);
    });

    it("returns no-documents message when empty", async () => {
      const ctx = mockContext();
      (ctx.db.listDocuments as any).mockResolvedValue([]);
      const tool = createListDocsTool(ctx);

      const result = await tool.execute("call-8", { doc_type: "worldview" }, undefined as any, undefined);

      expect(result.content[0].text).toContain("No documents found");
    });

    it("returns error on failure", async () => {
      const ctx = mockContext();
      (ctx.db.listDocuments as any).mockRejectedValue(new Error("db error"));
      const tool = createListDocsTool(ctx);

      const result = await tool.execute("call-9", { doc_type: "x" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
    });
  });

  describe("append-note section slicing", () => {
    const notes = [
      "---",
      "type: story-summary",
      "status: draft",
      "latest_chapter: 12",
      "---",
      "",
      "## Ch.1 开端",
      "少年离家。",
      "",
      "## Ch.2 遇袭",
      "山道遇马匪。",
      "",
      "## Ch.3 反杀",
      "林凡初次出手。",
    ].join("\n");

    it("keeps frontmatter/preamble plus only the requested tail sections", () => {
      const sliced = tailNoteSections(notes, 2);
      expect(sliced).toContain("latest_chapter: 12");
      expect(sliced).toContain("## Ch.2 遇袭");
      expect(sliced).toContain("## Ch.3 反杀");
      expect(sliced).not.toContain("## Ch.1 开端");
    });

    it("keeps only the last section for current-state reads", () => {
      const sliced = lastNoteSection(notes);
      expect(sliced).toContain("latest_chapter: 12");
      expect(sliced).toContain("## Ch.3 反杀");
      expect(sliced).not.toContain("## Ch.2 遇袭");
    });

    it("returns legacy section-less content unchanged", () => {
      const legacy = "---\ntype: story-summary\n---\n旧式滚动摘要正文";
      expect(tailNoteSections(legacy, 10)).toBe(legacy);
      expect(lastNoteSection(legacy)).toBe(legacy);
    });

    it("accepts Ch.N headings with or without the dot", () => {
      const alt = "---\n---\n## Ch 1 一\n\na\n\n## Ch.2 二\n\nb";
      const sliced = tailNoteSections(alt, 1);
      expect(sliced).toContain("## Ch.2 二");
      expect(sliced).not.toContain("## Ch 1 一");
    });
  });

  describe("createChapterContextTool", () => {
    it("returns error when no chapter card exists", async () => {
      const ctx = mockContext();
      (ctx.db.listDocuments as any).mockResolvedValue([]);
      const tool = createChapterContextTool(ctx);

      const result = await tool.execute("call-10", { chapter_num: 1 }, undefined as any, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No chapter card found");
    });

    it("assembles context from chapter card and referenced files", async () => {
      const ctx = mockContext();
      const chapterCard = {
        doc_path: "outline/cards/chapter-001.md",
        chapter_num: 1,
        status: "confirmed",
        meta: { characters: ["lin-fan"], world_elements: ["qi-system"] },
      };
      // listDocuments is called with different doc_type filters
      (ctx.db.listDocuments as any).mockImplementation(async (_pid: string, docType?: string) => {
        if (docType === "chapter-card") return [chapterCard];
        return [];
      });

      (ctx.storage.read as any).mockResolvedValue("# Chapter Card\n\n内容");
      const tool = createChapterContextTool(ctx);

      const result = await tool.execute("call-11", { chapter_num: 1 }, undefined as any, undefined);

      expect(result.content[0].text).toContain("CHAPTER CARD");
      expect(result.content[0].text).toContain("内容");
      expect(result.details.chapter_num).toBe(1);
    });

    it("includes previous chapter ending (truncated)", async () => {
      const ctx = mockContext();
      const chapterCard = {
        doc_path: "cards/ch-002.md",
        chapter_num: 2,
        status: "confirmed",
        meta: { characters: [], world_elements: [] },
      };
      const prevChapter = { doc_path: "text/chapter-001.md", chapter_num: 1, status: "locked" };
      const longContent = "A".repeat(3000);

      (ctx.db.listDocuments as any).mockImplementation(async (_pid: string, docType?: string) => {
        if (docType === "chapter-card") return [chapterCard];
        if (docType === "chapter-text") return [prevChapter];
        return [];
      });

      (ctx.storage.read as any)
        .mockResolvedValueOnce("# Chapter Card\n\ncard")
        .mockResolvedValueOnce(longContent);

      const tool = createChapterContextTool(ctx);

      const result = await tool.execute("call-12", { chapter_num: 2 }, undefined as any, undefined);

      expect(result.content[0].text).toContain("PREVIOUS CHAPTER ENDING");
      expect(result.content[0].text).toContain("(truncated)");
    });

    it("slices append-only notes: story-so-far tail sections and last character-state section", async () => {
      const ctx = mockContext();
      const chapterCard = {
        doc_path: "cards/ch-012.md",
        chapter_num: 12,
        status: "confirmed",
        meta: { characters: ["lin-fan"], world_elements: [] },
      };
      (ctx.db.listDocuments as any).mockImplementation(async (_pid: string, docType?: string) => {
        if (docType === "chapter-card") return [chapterCard];
        return [];
      });

      const summarySections = Array.from({ length: 12 }, (_, i) =>
        `## Ch.${i + 1} 第${i + 1}章\n\n第${i + 1}章的事件。`).join("\n\n");
      const storySoFar = `---\ntype: story-summary\nstatus: draft\nlatest_chapter: 12\n---\n\n${summarySections}`;
      const stateFile = "---\ntype: character-state\ncharacter: lin-fan\nstatus: draft\nlatest_chapter: 12\n---\n\n"
        + "## Ch.11 旧状态\n\n在北门。\n\n## Ch.12 当前\n\n已入城，知晓密道。";

      (ctx.storage.read as any).mockImplementation(async (path: string) => {
        if (path === "cards/ch-012.md") return "# Card\n\ncard";
        if (path === "summary/story-so-far.md") return storySoFar;
        if (path === "characters/lin-fan-state.md") return stateFile;
        if (path === "characters/lin-fan.md") return "---\ntype: character\n---\n# 林凡";
        throw new Error(`unexpected read: ${path}`);
      });

      const tool = createChapterContextTool(ctx);
      const result = await tool.execute("call-14", { chapter_num: 12 }, undefined as any, undefined);
      const text = result.content[0].text as string;

      expect(text).toContain("## Ch.12 第12章");
      expect(text).toContain("## Ch.3 第3章"); // tail of 10 from 12 sections keeps Ch.3..Ch.12
      expect(text).not.toContain("## Ch.2 第2章");
      expect(text).toContain("已入城，知晓密道。");
      expect(text).not.toContain("在北门。");
      expect(result.details.chapter_num).toBe(12);
    });

    it("includes director script when available", async () => {      const ctx = mockContext();
      const chapterCard = {
        doc_path: "cards/ch-001.md",
        chapter_num: 1,
        status: "confirmed",
        meta: { characters: [], world_elements: [] },
      };
      const script = { doc_path: "scripts/director-001.md", chapter_num: 1, status: "confirmed" };

      (ctx.db.listDocuments as any).mockImplementation(async (_pid: string, docType?: string) => {
        if (docType === "chapter-card") return [chapterCard];
        if (docType === "director-script") return [script];
        return [];
      });

      (ctx.storage.read as any)
        .mockResolvedValueOnce("# Card\n\ncard")
        .mockResolvedValueOnce("# Director Script\n\n镜头 1...");

      const tool = createChapterContextTool(ctx);

      const result = await tool.execute("call-13", { chapter_num: 1 }, undefined as any, undefined);

      expect(result.content[0].text).toContain("DIRECTOR SCRIPT");
    });

    it("handles missing character files gracefully", async () => {
      const ctx = mockContext();
      const chapterCard = {
        doc_path: "cards/ch-001.md",
        chapter_num: 1,
        status: "confirmed",
        meta: { characters: ["missing-char"], world_elements: [] },
      };

      (ctx.db.listDocuments as any).mockImplementation(async (_pid: string, docType?: string) => {
        if (docType === "chapter-card") return [chapterCard];
        return [];
      });

      (ctx.storage.read as any)
        .mockResolvedValueOnce("# Card\n\ncard")
        .mockRejectedValueOnce(new Error("not found"));

      const tool = createChapterContextTool(ctx);

      const result = await tool.execute("call-14", { chapter_num: 1 }, undefined as any, undefined);

      expect(result.content[0].text).toContain("CHARACTER: missing-char");
      expect(result.content[0].text).toContain("file not found");
      expect(result.isError).toBeUndefined();
    });

    it("excludes draft alternatives and uses the confirmed chapter card", async () => {
      const ctx = mockContext();
      (ctx.db.listDocuments as any).mockImplementation(async (_pid: string, docType?: string) => {
        if (docType === "chapter-card") return [
          { doc_path: "cards/draft.md", chapter_num: 1, status: "draft", meta: {} },
          { doc_path: "cards/confirmed.md", chapter_num: 1, status: "confirmed", meta: {} },
        ];
        return [];
      });
      (ctx.storage.read as any).mockImplementation(async (path: string) => path);

      const result = await createChapterContextTool(ctx).execute(
        "call-status-safe", { chapter_num: 1 }, undefined as any, undefined,
      );

      expect(result.content[0].text).toContain("cards/confirmed.md");
      expect(result.content[0].text).not.toContain("cards/draft.md");
    });

    it("includes explicitly referenced foreshadow files and warns when one is missing", async () => {
      const ctx = mockContext();
      const chapterCard = {
        doc_path: "cards/ch-001.md", chapter_num: 1, status: "confirmed",
        meta: { characters: [], world_elements: [], foreshadow_plant: ["fs-001", "fs-002"], foreshadow_resolve: [] },
      };
      (ctx.db.listDocuments as any).mockImplementation(async (_pid: string, docType?: string) =>
        docType === "chapter-card" ? [chapterCard] : []);
      (ctx.storage.read as any).mockImplementation(async (path: string) => {
        if (path === chapterCard.doc_path) return "# Card";
        if (path === "foreshadowing/fs-001.md") return "# Secret clue";
        throw new Error("not found");
      });

      const result = await createChapterContextTool(ctx).execute(
        "call-foreshadow", { chapter_num: 1 }, undefined as any, undefined,
      );

      expect(result.content[0].text).toContain("FORESHADOW: fs-001");
      expect(result.content[0].text).toContain("Missing referenced foreshadow: fs-002");
    });
  });

  describe("createFileTools", () => {
    it("returns all 8 file tools", () => {
      const tools = createFileTools(mockContext());
      expect(tools).toHaveLength(8);

      const names = tools.map((t) => t.name);
      expect(names).toContain("read_doc");
      expect(names).toContain("load_skill");
      expect(names).toContain("write_doc");
      expect(names).toContain("delete_doc");
      expect(names).toContain("search_docs");
      expect(names).toContain("list_docs");
      expect(names).toContain("chapter_context");
      expect(names).toContain("list_skills");
    });

    it("all tools have unique names", () => {
      const tools = createFileTools(mockContext());
      const names = new Set(tools.map((t) => t.name));
      expect(names.size).toBe(tools.length);
    });
  });

  describe("createLoadSkillTool", () => {
    it("reads a user skill from user-token storage at the namespaced path", async () => {
      const ctx = mockContext();
      const content = "# user skill body";
      (ctx.db.getSkillForUser as any).mockResolvedValue({
        id: "s1", slug: "my-style", source: "user", user_id: "u-1",
        review_status: "approved", review_policy_version: "1",
        approved_content_hash: createHash("sha256").update(content).digest("hex"),
        metadata: { requiredCapabilities: [] },
      });
      (ctx.skillsStorage.read as any).mockResolvedValue(content);

      const tool = createLoadSkillTool(ctx, "writer");
      const result = await tool.execute("c", { slug: "my-style" }, undefined as any, undefined);

      expect(ctx.db.getSkillForUser).toHaveBeenCalledWith("my-style", "user-1");
      expect(ctx.skillsStorage.read).toHaveBeenCalledWith("users/u-1/my-style/SKILL.md");
      expect(result.content[0].text).toBe("# user skill body");
    });

    it("loads a built-in skill through the platform resource service", async () => {
      const ctx = mockContext();
      (ctx.db.listWorkspaceSkills as any).mockResolvedValue([{ skill_slug: "skill-creator", enabled: true }]);
      (ctx.db.getSkillForUser as any).mockResolvedValue({
        slug: "skill-creator", source: "built-in", user_id: null,
      });

      const tool = createLoadSkillTool(ctx);
      const result = await tool.execute("c", { slug: "skill-creator" }, undefined as any, undefined);

      // Built-ins never use per-user storage.
      expect(ctx.skillsStorage.read).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("# Novel Vibe Skill Creator");
    });

    it("accepts a built-in skill location from the available_skills prompt", async () => {
      const ctx = mockContext();
      (ctx.db.listWorkspaceSkills as any).mockResolvedValue([{ skill_slug: "mystery-atmosphere", enabled: true }]);
      (ctx.db.getSkillForUser as any).mockResolvedValue({
        slug: "mystery-atmosphere", source: "built-in", user_id: null,
      });

      const tool = createLoadSkillTool(ctx, "writer");
      const result = await tool.execute(
        "c",
        { slug: "builtin/mystery-atmosphere/SKILL.md" },
        undefined as any,
        undefined,
      );

      expect(ctx.db.getSkillForUser).toHaveBeenCalledWith("mystery-atmosphere", "user-1");
      expect(result.content[0].text).toContain("# 悬疑氛围营造");
    });

    it("returns an error when the skill is not found", async () => {
      const ctx = mockContext();
      (ctx.db.getSkillForUser as any).mockResolvedValue(null);

      const tool = createLoadSkillTool(ctx);
      const result = await tool.execute("c", { slug: "nope" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });

    it("blocks direct loading of quarantined or wrong-role user Skills", async () => {
      const ctx = mockContext();
      (ctx.db.listWorkspaceSkills as any).mockResolvedValue([{ skill_slug: "my-style", enabled: true }]);
      (ctx.db.getSkillForUser as any).mockResolvedValue({
        id: "s1", slug: "my-style", source: "user", user_id: "u-1",
        review_status: "quarantined", review_policy_version: "1", metadata: { requiredCapabilities: [] },
      });
      const tool = createLoadSkillTool(ctx, "writer");
      const quarantined = await tool.execute("c", { slug: "my-style" }, undefined as any, undefined);
      expect(quarantined.isError).toBe(true);
      expect(ctx.skillsStorage.read).not.toHaveBeenCalled();

      (ctx.db.getSkillForUser as any).mockResolvedValue({
        id: "s1", slug: "my-style", source: "user", user_id: "u-1",
        review_status: "approved", review_policy_version: "1", metadata: { requiredCapabilities: [] },
      });
      (ctx.db.listSkillRoles as any).mockResolvedValue(["director"]);
      const wrongRole = await tool.execute("c", { slug: "my-style" }, undefined as any, undefined);
      expect(wrongRole.isError).toBe(true);
      expect(ctx.skillsStorage.read).not.toHaveBeenCalled();
    });
  });

  describe("list_skills tool", () => {
    it("returns only enabled skills loadable by the current Agent role", async () => {
      const ctx = mockContext();
      (ctx.db.listWorkspaceSkills as any).mockResolvedValue([
        { skill_slug: "mystery-atmosphere", enabled: true },
        { skill_slug: "disabled-skill", enabled: false },
        { skill_slug: "writer-style", enabled: true },
        { skill_slug: "director-only", enabled: true },
      ]);
      (ctx.db.getSkillForUser as any).mockImplementation(async (slug: string) => {
        if (slug === "mystery-atmosphere") {
          return {
            id: "builtin-1",
            slug,
            name: "悬疑氛围营造",
            description: "营造悬疑氛围",
            source: "built-in",
            user_id: null,
          };
        }
        if (slug === "writer-style") {
          return {
            id: "user-1",
            slug,
            name: "Writer Style",
            description: "A writer style",
            source: "user",
            user_id: "u-1",
            review_status: "approved",
            review_policy_version: "1",
            metadata: { requiredCapabilities: [] },
          };
        }
        if (slug === "director-only") {
          return {
            id: "user-2",
            slug,
            name: "Director Only",
            description: "Director only",
            source: "user",
            user_id: "u-1",
            review_status: "approved",
            review_policy_version: "1",
            metadata: { requiredCapabilities: [] },
          };
        }
        return null;
      });
      (ctx.db.listSkillRoles as any).mockImplementation(async (skillId: string) => {
        if (skillId === "user-1") return ["writer"];
        if (skillId === "user-2") return ["director"];
        return [];
      });

      const tool = createFileTools(ctx, "writer").find((item) => item.name === "list_skills");
      expect(tool).toBeDefined();

      const result = await tool!.execute("c", {}, undefined as any, undefined);
      const details = result.details as any;

      expect(details.skills).toEqual([
        {
          slug: "mystery-atmosphere",
          name: "悬疑氛围营造",
          description: "营造悬疑氛围",
          source: "built-in",
          location: "builtin/mystery-atmosphere/SKILL.md",
        },
        {
          slug: "writer-style",
          name: "Writer Style",
          description: "A writer style",
          source: "user",
          location: "users/u-1/writer-style/SKILL.md",
        },
      ]);
      expect(result.content[0].text).toContain("mystery-atmosphere");
      expect(result.content[0].text).toContain("builtin/mystery-atmosphere/SKILL.md");
      expect(result.content[0].text).not.toContain("disabled-skill");
      expect(result.content[0].text).not.toContain("director-only");
    });
  });
});
