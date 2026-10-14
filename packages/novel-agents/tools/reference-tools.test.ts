import { describe, expect, it, vi } from "vitest";
import { createReferenceTools } from "./reference-tools.js";
import type { ToolContext } from "./file-tools.js";

function indexRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    doc_path: overrides.doc_path,
    doc_type: overrides.doc_type,
    status: overrides.status ?? "draft",
    chapter_num: overrides.chapter_num ?? null,
    meta: overrides.meta ?? {},
  };
}

const docsFixture = (): unknown[] => [
  indexRow({ doc_path: "characters/lin-fan.md", doc_type: "character", status: "confirmed", meta: { slug: "lin-fan", arc_stage: "growth" } }),
  indexRow({ doc_path: "text/ch-001.md", doc_type: "chapter-text", status: "confirmed", chapter_num: 1, meta: { characters_present: ["lin-fan"], pov: "lin-fan" } }),
  indexRow({ doc_path: "text/ch-002.md", doc_type: "chapter-text", status: "draft", chapter_num: 2, meta: { characters_present: ["su-qing"], pov: "su-qing" } }),
  indexRow({ doc_path: "outline/vol-01/ch-003.md", doc_type: "chapter-card", status: "confirmed", chapter_num: 3, meta: { characters: ["lin-fan"], world_elements: [] } }),
  indexRow({ doc_path: "scripts/ch-004.md", doc_type: "director-script", status: "draft", chapter_num: 4, meta: { characters_ref: [], world_ref: ["cloud-city"] } }),
];

function mockCtx(dbOverrides: Partial<ToolContext["db"]>): ToolContext {
  return {
    projectId: "proj-1",
    db: dbOverrides,
  } as unknown as ToolContext;
}

describe("query_references", () => {
  const [tool] = createReferenceTools(mockCtx({
    listDocuments: vi.fn(async () => docsFixture()),
    listForeshadows: vi.fn(),
  }));

  it("groups structural references and flags POV appearances", async () => {
    const result = await (tool as any).execute("c1", { entity_slug: "Lin-Fan" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("角色档案：characters/lin-fan.md");
    expect(result.content[0].text).toContain("text/ch-001.md");
    expect(result.content[0].text).toContain("视角");
    expect(result.content[0].text).not.toContain("text/ch-002.md");
    expect(result.details).toMatchObject({
      entity: "Lin-Fan",
      total_refs: 2,
      has_profile: true,
      chapters: [1, 3],
    });
  });

  it("reports world-element hits across scripts and worldview links", async () => {
    const withWorldview = [...docsFixture(), indexRow({
      doc_path: "worldview/cloud-city.md",
      doc_type: "worldview",
      status: "confirmed",
      meta: { related: { characters: ["lin-fan"], world_elements: ["cloud-city"] } },
    })];
    const ctx = mockCtx({ listDocuments: vi.fn(async () => withWorldview), listForeshadows: vi.fn() });
    const [refTool] = createReferenceTools(ctx);

    const cloudCity = await refTool.execute("c2", { entity_slug: "cloud-city" });
    expect(cloudCity.details.total_refs).toBe(2); // director-script world_ref + worldview itself? no — worldview matches via its own field
    expect(cloudCity.content[0].text).toContain("scripts/ch-004.md");

    const linFan = await refTool.execute("c3", { entity_slug: "lin-fan" });
    expect(linFan.content[0].text).toContain("worldview/cloud-city.md");
  });

  it("handles an entity without profile or references", async () => {
    const result = await (tool as any).execute("c4", { entity_slug: "nobody" });
    expect(result.content[0].text).toContain("没有任何结构化引用记录");
    expect(result.details.has_profile).toBe(false);
  });

  it("surfaces db failures as error results", async () => {
    const ctx = mockCtx({ listDocuments: vi.fn(async () => { throw new Error("DB down"); }), listForeshadows: vi.fn() });
    const [refTool] = createReferenceTools(ctx);
    const result = await refTool.execute("c5", { entity_slug: "lin-fan" });
    expect(result.isError).toBe(true);
  });
});

describe("foreshadow_debt", () => {
  const foreshadows = [
    { foreshadow_id: "fs-001", status: "planted", plant_chapter: 1, planned_resolve: 4, importance: 8, description: "断剑的来历" },
    { foreshadow_id: "fs-002", status: "planted", plant_chapter: 2, planned_resolve: 8, importance: 6, description: "耳后的胎记" },
    { foreshadow_id: "fs-003", status: "resolved", plant_chapter: 1, planned_resolve: 2, actual_resolve: 2, description: "旧约" },
    { foreshadow_id: "fs-004", status: "abandoned", plant_chapter: 1, planned_resolve: 9, description: "弃案" },
    { foreshadow_id: "fs-005", status: "planned", plant_chapter: null, planned_resolve: null, description: "无计划" },
  ];

  function debtCtx(extra?: Partial<ToolContext["db"]>) {
    return mockCtx({
      listForeshadows: vi.fn(async () => foreshadows),
      listDocuments: vi.fn(async () => [
        indexRow({ doc_path: "text/ch-010.md", doc_type: "chapter-text", chapter_num: 10 }),
        indexRow({ doc_path: "text/ch-012.md", doc_type: "chapter-text", chapter_num: 12 }),
      ]),
      ...extra,
    });
  }

  it("classifies overdue, due-soon, later and unplanned items", async () => {
    const [, debtTool] = createReferenceTools(debtCtx());
    const result = await debtTool.execute("d1", { current_chapter: 6 });

    expect(result.content[0].text).toContain("已超期 1 笔");
    expect(result.content[0].text).toContain("fs-001");
    expect(result.content[0].text).toContain("章内到期 1 笔");
    expect(result.content[0].text).not.toContain("fs-003"); // resolved skipped
    expect(result.content[0].text).not.toContain("fs-004"); // abandoned skipped
    expect(result.content[0].text).toContain("未定回收章 1 笔");
    expect(result.details).toMatchObject({
      current_chapter: 6,
      overdue: 1,
      due_soon: 1,
      unplanned: 1,
    });
  });

  it("derives the current chapter frontier from the index when omitted", async () => {
    const db = debtCtx();
    const [, debtTool] = createReferenceTools(db);
    const result = await debtTool.execute("d2", {});

    expect(result.details.current_chapter).toBe(12);
  });

  it("reports a clean ledger when nothing is open", async () => {
    const [, debtTool] = createReferenceTools(debtCtx({
      listForeshadows: vi.fn(async () => [{ foreshadow_id: "fs-003", status: "resolved" }]),
    }));
    const result = await debtTool.execute("d3", {});
    expect(result.content[0].text).toContain("没有未回收伏笔");
  });

  it("surfaces db failures as error results", async () => {
    const [, debtTool] = createReferenceTools(debtCtx({
      listForeshadows: vi.fn(async () => { throw new Error("boom"); }),
    }));
    const result = await debtTool.execute("d4", {});
    expect(result.isError).toBe(true);
  });
});

describe("list_variants", () => {
  const variantRows = [
    indexRow({ doc_path: "text/ch-003.b.md", doc_type: "chapter-text", status: "draft", chapter_num: 3,
      meta: { style_tags: ["热血"], word_count: 640 } }),
    indexRow({ doc_path: "text/ch-004.a.md", doc_type: "chapter-text", status: "draft", chapter_num: 4,
      meta: { style_tags: ["悬疑"] } }),
    indexRow({ doc_path: "text/ch-003.md", doc_type: "chapter-text", status: "confirmed", chapter_num: 3 }),
  ];
  const ctx = () => mockCtx({ listDocuments: vi.fn(async () => variantRows), listForeshadows: vi.fn() });
  const [, , listTool] = createReferenceTools(ctx());

  it("lists variants with canonical counterpart status", async () => {
    const result = await (listTool as any).execute("v1", {});
    expect(result.details.count).toBe(2);
    expect(result.content[0].text).toContain("text/ch-003.b.md");
    expect(result.content[0].text).toContain("[confirmed] text/ch-003.md");
    expect(result.content[0].text).toContain("promote_variant");
  });

  it("filters by chapter and reports empty results", async () => {
    const empty = await (listTool as any).execute("v2", { chapter_num: 9 });
    expect(empty.content[0].text).toContain("第 9 章没有打开的变体草稿");

    const filtered = await (listTool as any).execute("v3", { chapter_num: 3 });
    expect(filtered.details.chapters).toEqual([3]);
  });
});
