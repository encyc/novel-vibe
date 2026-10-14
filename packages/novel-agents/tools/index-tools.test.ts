import { describe, expect, it, vi, beforeEach } from "vitest";
import { createIndexTools, createSyncIndexTool, createSyncAllIndexesTool } from "./index-tools.js";
import type { ToolContext } from "./file-tools.js";

function mockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    storage: { read: vi.fn(), write: vi.fn(), search: vi.fn(), list: vi.fn(), delete: vi.fn() } as any,
    db: {
      listDocuments: vi.fn(),
      upsertDocumentIndex: vi.fn(),
      upsertForeshadow: vi.fn(),
    } as any,
    projectId: "test-project-id",
    ...overrides,
  };
}

describe("index-tools", () => {
  describe("createSyncIndexTool", () => {
    it("has correct metadata", () => {
      const tool = createSyncIndexTool(mockContext());
      expect(tool.name).toBe("sync_index");
      expect(tool.label).toBe("Sync Document Index");
    });

    it("reads file, parses frontmatter, and upserts to DB", async () => {
      const ctx = mockContext();
      (ctx.storage.read as any).mockResolvedValue(`---
type: character
name: 林凡
slug: lin-fan
role: protagonist
status: draft
tags: [主角]
abilities: []
arc_stage: origin
appears_in: [1]
---
# 林凡

主角介绍。`);

      const tool = createSyncIndexTool(ctx);
      const result = await tool.execute("call-1", { path: "characters/lin-fan.md" }, undefined as any, undefined);

      expect(result.content[0].text).toContain("Index synced");
      expect(result.details.docType).toBe("character");
      expect(ctx.db.upsertDocumentIndex).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "test-project-id",
          docPath: "characters/lin-fan.md",
          docType: "character",
          name: "林凡",
          status: "draft",
          wordCount: expect.any(Number),
          checksum: expect.any(String),
        }),
      );
    });

    it("returns error when frontmatter has no type field", async () => {
      const ctx = mockContext();
      (ctx.storage.read as any).mockResolvedValue(`---
name: 林凡
---
# 林凡`);

      const tool = createSyncIndexTool(ctx);
      const result = await tool.execute("call-2", { path: "chars/no-type.md" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("no 'type' field");
      expect(ctx.db.upsertDocumentIndex).not.toHaveBeenCalled();
    });

    it("accepts doc_type as alias for type", async () => {
      const ctx = mockContext();
      (ctx.storage.read as any).mockResolvedValue(`---
doc_type: worldview
category: rule
name: 灵气体系
status: draft
importance: 8
related:
  characters: []
  chapters: []
  world_elements: []
---
body`);

      const tool = createSyncIndexTool(ctx);
      const result = await tool.execute("call-3", { path: "worldview/test.md" }, undefined as any, undefined);

      expect(result.isError).toBeUndefined();
      expect(ctx.db.upsertDocumentIndex).toHaveBeenCalledWith(
        expect.objectContaining({ docType: "worldview" }),
      );
    });

    it("syncs foreshadow index when doc type is foreshadow", async () => {
      const ctx = mockContext();
      (ctx.storage.read as any).mockResolvedValue(`---
type: foreshadow
id: fs-001
description: test
importance: 8
plant_chapter: 1
planned_resolve: 5
actual_resolve: null
status: planned
---
# fs-001`);

      const tool = createSyncIndexTool(ctx);
      await tool.execute("call-4", { path: "foreshadowing/fs-001.md" }, undefined as any, undefined);

      expect(ctx.db.upsertForeshadow).toHaveBeenCalledWith(
        expect.objectContaining({
          foreshadowId: "fs-001",
          importance: 8,
          plantChapter: 1,
        }),
      );
    });

    it("returns error when storage.read throws", async () => {
      const ctx = mockContext();
      (ctx.storage.read as any).mockRejectedValue(new Error("read failed"));
      const tool = createSyncIndexTool(ctx);

      const result = await tool.execute("call-5", { path: "missing.md" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Sync error");
    });
  });

  describe("createSyncAllIndexesTool", () => {
    it("iterates all documents and syncs each", async () => {
      const ctx = mockContext();
      (ctx.db.listDocuments as any).mockResolvedValue([
        { doc_path: "chars/a.md" },
        { doc_path: "chars/b.md" },
      ]);
      (ctx.storage.read as any)
        .mockResolvedValueOnce(`---
type: character
name: A
slug: a
role: supporting
status: draft
tags: []
abilities: []
arc_stage: origin
appears_in: []
---
# A`)
        .mockResolvedValueOnce(`---
type: character
name: B
slug: b
role: supporting
status: draft
tags: []
abilities: []
arc_stage: origin
appears_in: []
---
# B`);

      const tool = createSyncAllIndexesTool(ctx);
      const result = await tool.execute("call-6", {}, undefined as any, undefined);

      expect(result.content[0].text).toContain("2 synced");
      expect(result.details.synced).toBe(2);
      expect(result.details.errors).toBe(0);
    });

    it("handles per-doc failures gracefully", async () => {
      const ctx = mockContext();
      (ctx.db.listDocuments as any).mockResolvedValue([
        { doc_path: "chars/a.md" },
        { doc_path: "chars/b.md" },
      ]);
      (ctx.storage.read as any)
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce(`---
type: character
name: B
slug: b
role: supporting
status: draft
tags: []
abilities: []
arc_stage: origin
appears_in: []
---
# B`);

      const tool = createSyncAllIndexesTool(ctx);
      const result = await tool.execute("call-7", {}, undefined as any, undefined);

      expect(result.details.synced).toBe(1);
      expect(result.details.errors).toBe(1);
    });

    it("returns error on db failure", async () => {
      const ctx = mockContext();
      (ctx.db.listDocuments as any).mockRejectedValue(new Error("db error"));
      const tool = createSyncAllIndexesTool(ctx);

      const result = await tool.execute("call-8", {}, undefined as any, undefined);

      expect(result.isError).toBe(true);
    });
  });

  describe("createIndexTools", () => {
    it("returns 2 index tools", () => {
      const tools = createIndexTools(mockContext());
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name).sort()).toEqual(["sync_all_indexes", "sync_index"]);
    });
  });
});
