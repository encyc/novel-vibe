import { describe, expect, it, vi, beforeEach } from "vitest";
import { createStatusTools, createUpdateStatusTool, createGetProjectStatusTool } from "./status-tools.js";
import type { ToolContext } from "./file-tools.js";

function mockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    storage: { read: vi.fn(), write: vi.fn(), search: vi.fn(), list: vi.fn(), delete: vi.fn() } as any,
    skillsStorage: { read: vi.fn() } as any,
    db: {
      listDocuments: vi.fn(),
      getDocument: vi.fn(),
      updateDocumentStatus: vi.fn(),
    } as any,
    projectId: "test-project-id",
    userId: "user-1",
    sessionId: "session-1",
    turnId: "turn-1",
    documentWriter: {
      write: vi.fn().mockImplementation(async ({ path }: { path: string }) => ({
        changed: true,
        path,
        versionId: "version-1",
        versionNo: 1,
        beforeHash: "before",
        afterHash: "new-hash",
        indexed: true,
        addedLines: 1,
        deletedLines: 1,
        changedSections: [],
      })),
    },
    assertProjectWritable: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("status-tools", () => {
  describe("createUpdateStatusTool", () => {
    it("has correct metadata", () => {
      const tool = createUpdateStatusTool(mockContext());
      expect(tool.name).toBe("update_status");
      expect(tool.label).toBe("Update Document Status");
    });

    it("routes frontmatter status changes through the versioned writer", async () => {
      const ctx = mockContext();
      (ctx.db.getDocument as any).mockResolvedValue({ status: "draft" });
      (ctx.storage.read as any).mockResolvedValue(`---
type: character
status: draft
name: 林凡
---
# 林凡`);

      const tool = createUpdateStatusTool(ctx);
      const result = await tool.execute("call-1", { path: "chars/lin-fan.md", status: "confirmed" }, undefined as any, undefined);

      expect(result.content[0].text).toContain("confirmed");
      expect(ctx.documentWriter.write).toHaveBeenCalledWith({
        projectId: "test-project-id",
        path: "chars/lin-fan.md",
        content: expect.stringContaining("status: confirmed"),
        source: {
          type: "agent",
          userId: "user-1",
          agentId: "chief_editor",
          sessionId: "session-1",
          turnId: "turn-1",
          toolCallId: "call-1",
        },
      });
      expect(result.details).toMatchObject({ changed: true, versionId: "version-1", versionNo: 1 });
      expect(ctx.db.updateDocumentStatus).not.toHaveBeenCalled();
      expect(ctx.storage.write).not.toHaveBeenCalled();
    });

    it("emits a chapter-confirmed event for deterministic continuity processing", async () => {
      const onDocumentStatusChanged = vi.fn().mockResolvedValue(undefined);
      const ctx = mockContext({ onDocumentStatusChanged });
      (ctx.db.getDocument as any).mockResolvedValue({ status: "draft" });
      (ctx.storage.read as any).mockResolvedValue("---\ntype: chapter-text\nstatus: draft\nchapter: 3\n---\n# 第三章");

      await createUpdateStatusTool(ctx).execute("call-confirm", { path: "text/chapter-003.md", status: "confirmed" }, undefined as any, undefined);

      expect(onDocumentStatusChanged).toHaveBeenCalledWith({
        path: "text/chapter-003.md",
        status: "confirmed",
        previousStatus: "draft",
        chapterNumber: 3,
        confirmedHash: "new-hash",
      });
    });

    it("emits the same event for the canonical compact chapter path", async () => {
      const onDocumentStatusChanged = vi.fn().mockResolvedValue(undefined);
      const ctx = mockContext({ onDocumentStatusChanged });
      (ctx.db.getDocument as any).mockResolvedValue({ status: "draft" });
      (ctx.storage.read as any).mockResolvedValue("---\ntype: chapter-text\nstatus: draft\nchapter: 3\n---\n# 第三章");

      await createUpdateStatusTool(ctx).execute("call-confirm", { path: "text/ch-003.md", status: "confirmed" }, undefined as any, undefined);

      expect(onDocumentStatusChanged).toHaveBeenCalledWith({
        path: "text/ch-003.md",
        status: "confirmed",
        previousStatus: "draft",
        chapterNumber: 3,
        confirmedHash: "new-hash",
      });
    });

    it("does not emit continuity events for non-chapter documents", async () => {
      const onDocumentStatusChanged = vi.fn().mockResolvedValue(undefined);
      const ctx = mockContext({ onDocumentStatusChanged });
      (ctx.db.getDocument as any).mockResolvedValue({ status: "draft" });
      (ctx.storage.read as any).mockResolvedValue("---\ntype: character\nstatus: draft\n---\n# 角色");

      await createUpdateStatusTool(ctx).execute("call-character", { path: "characters/hero.md", status: "confirmed" }, undefined as any, undefined);

      expect(onDocumentStatusChanged).not.toHaveBeenCalled();
    });

    it("rejects status changes when the project is read-only", async () => {
      const ctx = mockContext({
        assertProjectWritable: vi.fn().mockRejectedValue(new Error("Project is archived and cannot be modified")),
      });
      const tool = createUpdateStatusTool(ctx);

      const result = await tool.execute(
        "call-read-only",
        { path: "chars/lin-fan.md", status: "confirmed" },
        undefined as any,
        undefined,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("archived");
      expect(ctx.db.getDocument).not.toHaveBeenCalled();
      expect(ctx.db.updateDocumentStatus).not.toHaveBeenCalled();
    });

    it("allows confirmed → locked transition", async () => {
      const ctx = mockContext();
      (ctx.db.getDocument as any).mockResolvedValue({ status: "confirmed" });
      (ctx.storage.read as any).mockResolvedValue(`---
type: character
status: confirmed
name: 林凡
---
# 林凡`);

      const tool = createUpdateStatusTool(ctx);
      const result = await tool.execute("call-2", { path: "chars/lin-fan.md", status: "locked" }, undefined as any, undefined);

      expect(result.content[0].text).toContain("locked");
      expect(ctx.documentWriter.write).toHaveBeenCalled();
    });

    it("allows confirmed → draft reject", async () => {
      const ctx = mockContext();
      (ctx.db.getDocument as any).mockResolvedValue({ status: "confirmed" });
      (ctx.storage.read as any).mockResolvedValue("---\nstatus: confirmed\n---\n# Content");

      const tool = createUpdateStatusTool(ctx);
      const result = await tool.execute("call-3", { path: "x.md", status: "draft" }, undefined as any, undefined);

      expect(result.content[0].text).toContain("draft");
    });

    it("rejects draft → locked (skipping confirmed)", async () => {
      const ctx = mockContext();
      (ctx.db.getDocument as any).mockResolvedValue({ status: "draft" });

      const tool = createUpdateStatusTool(ctx);
      const result = await tool.execute("call-4", { path: "x.md", status: "locked" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("rejected");
      expect(result.content[0].text).toContain('"draft"');
      expect(result.content[0].text).toContain('"confirmed"');
      expect(ctx.db.updateDocumentStatus).not.toHaveBeenCalled();
    });

    it("rejects locked → confirmed", async () => {
      const ctx = mockContext();
      (ctx.db.getDocument as any).mockResolvedValue({ status: "locked" });

      const tool = createUpdateStatusTool(ctx);
      const result = await tool.execute("call-5", { path: "x.md", status: "confirmed" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("rejected");
      expect(result.content[0].text).toContain('"locked"');
    });

    it("defaults to draft status when document not in index", async () => {
      const ctx = mockContext();
      (ctx.db.getDocument as any).mockResolvedValue(null); // not found → defaults to draft
      (ctx.storage.read as any).mockResolvedValue("---\nname: Test\n---\n# Content");

      const tool = createUpdateStatusTool(ctx);
      const result = await tool.execute("call-6", { path: "new.md", status: "confirmed" }, undefined as any, undefined);

      expect(result.content[0].text).toContain("confirmed");
      expect(ctx.documentWriter.write).toHaveBeenCalled();
    });

    it("does not rewrite file if status field is absent in frontmatter", async () => {
      const ctx = mockContext();
      (ctx.db.getDocument as any).mockResolvedValue({ status: "draft" });
      (ctx.storage.read as any).mockResolvedValue(`---
type: character
name: 林凡
---
# 林凡`);

      const tool = createUpdateStatusTool(ctx);
      await tool.execute("call-7", { path: "chars/lin-fan.md", status: "confirmed" }, undefined as any, undefined);

      expect(ctx.documentWriter.write).toHaveBeenCalledWith(expect.objectContaining({
        content: "---\ntype: character\nname: 林凡\n---\n# 林凡",
      }));
    });

    it("returns error on DB failure", async () => {
      const ctx = mockContext();
      (ctx.db.getDocument as any).mockResolvedValue({ status: "draft" });
      (ctx.db.updateDocumentStatus as any).mockRejectedValue(new Error("db fail"));

      const tool = createUpdateStatusTool(ctx);
      const result = await tool.execute("call-8", { path: "x.md", status: "confirmed" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
    });
  });

  describe("createGetProjectStatusTool", () => {
    it("has correct metadata", () => {
      const tool = createGetProjectStatusTool(mockContext());
      expect(tool.name).toBe("get_project_status");
      expect(tool.label).toBe("Get Project Status");
    });

    it("counts documents by type and status", async () => {
      const ctx = mockContext();
      (ctx.db.listDocuments as any).mockResolvedValue([
        { doc_type: "character", status: "draft" },
        { doc_type: "character", status: "confirmed" },
        { doc_type: "worldview", status: "draft" },
      ]);

      const tool = createGetProjectStatusTool(ctx);
      const result = await tool.execute("call-9", {}, undefined as any, undefined);

      expect(result.content[0].text).toContain("Total documents: 3");
      expect(result.content[0].text).toContain("character: 2");
      expect(result.content[0].text).toContain("worldview: 1");
      expect(result.details.byStatus).toEqual({ draft: 2, confirmed: 1 });
    });

    it("handles empty project", async () => {
      const ctx = mockContext();
      (ctx.db.listDocuments as any).mockResolvedValue([]);

      const tool = createGetProjectStatusTool(ctx);
      const result = await tool.execute("call-10", {}, undefined as any, undefined);

      expect(result.content[0].text).toContain("Total documents: 0");
    });

    it("returns error on DB failure", async () => {
      const ctx = mockContext();
      (ctx.db.listDocuments as any).mockRejectedValue(new Error("db error"));

      const tool = createGetProjectStatusTool(ctx);
      const result = await tool.execute("call-11", {}, undefined as any, undefined);

      expect(result.isError).toBe(true);
    });
  });

  describe("createStatusTools", () => {
    it("returns 2 status tools", () => {
      const tools = createStatusTools(mockContext());
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name).sort()).toEqual(["get_project_status", "update_status"]);
    });
  });
});
