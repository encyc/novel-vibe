import { describe, expect, it, vi } from "vitest";
import { prepareIndexedDocument, syncPreparedDocument } from "./document-indexing.js";

const validForeshadow = `---
type: foreshadow
id: fs-007
description: 玉佩来源
importance: 8
plant_chapter: 2
planned_resolve: 18
actual_resolve: null
status: planted
---
玉佩上有被磨去的宗门徽记。`;

describe("document indexing", () => {
  it("rejects invalid frontmatter for a registered document type", () => {
    expect(() => prepareIndexedDocument("text/ch-001.md", `---
type: chapter-text
chapter: 1
status: draft
---
正文`)).toThrow(/Invalid chapter-text frontmatter/);
  });

  it("accepts legacy chapter cards without ending_hook", () => {
    const prepared = prepareIndexedDocument("outline/vol-01/ch-001.md", `---
type: chapter-card
chapter: 1
volume: 1
arc: 1
title: 初入宗门
pov: lin-feng
status: draft
characters: [lin-feng]
world_elements: [sect]
foreshadow_plant: []
foreshadow_resolve: []
emotion_curve: "紧张 → 好奇"
---
## 核心事件
入门试炼`);
    expect(prepared?.docType).toBe("chapter-card");
    expect(prepared?.meta.ending_hook).toBeUndefined();
  });

  it("indexes ending_hook on chapter cards when present", () => {
    const prepared = prepareIndexedDocument("outline/vol-01/ch-002.md", `---
type: chapter-card
chapter: 2
volume: 1
arc: 1
title: 夜探藏经阁
pov: lin-feng
status: draft
characters: [lin-feng]
world_elements: []
foreshadow_plant: [fs-001]
foreshadow_resolve: []
emotion_curve: "压抑 → 震惊"
ending_hook: "真相揭开一角：藏经阁深处有人先他一步"
---
## 核心事件
夜探`);
    expect(prepared?.meta.ending_hook).toBe("真相揭开一角：藏经阁深处有人先他一步");
  });

  it("rejects a non-string ending_hook on chapter cards", () => {
    expect(() => prepareIndexedDocument("outline/vol-01/ch-003.md", `---
type: chapter-card
chapter: 3
volume: 1
arc: 1
title: 试炼
pov: lin-feng
status: draft
characters: [lin-feng]
world_elements: []
foreshadow_plant: []
foreshadow_resolve: []
emotion_curve: "平静 → 决然"
ending_hook: 7
---
正文`)).toThrow(/Invalid chapter-card frontmatter/);
  });

  it("rejects unsupported document types", () => {
    expect(() => prepareIndexedDocument("misc/note.md", "---\ntype: arbitrary\n---\nNote"))
      .toThrow('Unsupported document type "arbitrary"');
  });

  it("prepares normalized index fields from valid content", () => {
    const prepared = prepareIndexedDocument("foreshadowing/fs-007.md", validForeshadow);
    expect(prepared).toMatchObject({
      path: "foreshadowing/fs-007.md",
      docType: "foreshadow",
      status: "planted",
      wordCount: 13,
    });
  });

  it("synchronizes foreshadows to both indexes", async () => {
    const db = {
      upsertDocumentIndex: vi.fn().mockResolvedValue(undefined),
      upsertForeshadow: vi.fn().mockResolvedValue(undefined),
    };
    const prepared = prepareIndexedDocument("foreshadowing/fs-007.md", validForeshadow);

    await syncPreparedDocument(db, "project-1", prepared, "checksum-1");

    expect(db.upsertDocumentIndex).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      docPath: "foreshadowing/fs-007.md",
      docType: "foreshadow",
      checksum: "checksum-1",
    }));
    expect(db.upsertForeshadow).toHaveBeenCalledWith({
      projectId: "project-1",
      foreshadowId: "fs-007",
      docPath: "foreshadowing/fs-007.md",
      description: "玉佩来源",
      importance: 8,
      plantChapter: 2,
      plannedResolve: 18,
      actualResolve: null,
      status: "planted",
    });
  });
});
