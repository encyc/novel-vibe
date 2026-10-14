import { describe, expect, it, vi } from "vitest";
import { canonicalChapterPathFor, createPromoteVariantTool } from "./variant-tools.js";
import type { ToolContext } from "./file-tools.js";

const variantDoc = [
  "---",
  "type: chapter-text",
  "chapter: 3",
  "volume: 1",
  "pov: lin-fan",
  "status: draft",
  "word_count: 620",
  "characters_present: [lin-fan]",
  "style_tags: [冷峻]",
  "---",
  "",
  "变体稿正文。",
].join("\n");

function makeCtx(overrides?: {
  readError?: Error;
  docType?: unknown;
  cleanupError?: Error;
}) {
  const storage = {
    read: overrides?.readError
      ? vi.fn(async () => { throw overrides.readError!; })
      : vi.fn(async () => variantDoc),
    delete: overrides?.cleanupError
      ? vi.fn(async () => { throw overrides.cleanupError!; })
      : vi.fn(async () => undefined),
  };
  const db = { deleteDocument: vi.fn(async () => undefined) };
  const documentWriter = {
    write: vi.fn(async (input: any) => ({
      changed: true,
      path: input.path,
      versionId: "version-9",
      versionNo: 9,
      indexed: true,
      addedLines: 3,
      deletedLines: 0,
      changedSections: [],
    })),
  };
  const ctx = {
    projectId: "proj-1",
    userId: "user-1",
    sessionId: "session-1",
    turnId: "turn-1",
    assertProjectWritable: vi.fn(async () => undefined),
    storage,
    db,
    documentWriter,
  } as unknown as ToolContext;
  return { ctx, storage, db, documentWriter };
}

describe("canonicalChapterPathFor", () => {
  it("maps variant paths onto their canonical file", () => {
    expect(canonicalChapterPathFor("text/ch-003.b.md")).toBe("text/ch-003.md");
    expect(canonicalChapterPathFor("text/ch-012.z.md")).toBe("text/ch-012.md");
    expect(canonicalChapterPathFor("text/ch-003.md")).toBeNull();
    expect(canonicalChapterPathFor("outline/ch-003.a.md")).toBeNull();
  });
});

describe("promote_variant", () => {
  it("writes the variant onto the canonical path via the versioned writer and archives the variant", async () => {
    const { ctx, storage, db, documentWriter } = makeCtx();
    const result = await createPromoteVariantTool(ctx).execute("call-1", { variant_path: "text/ch-003.b.md" });

    expect(documentWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      path: "text/ch-003.md",
      content: variantDoc,
      source: expect.objectContaining({ agentId: "chief_editor", toolCallId: "call-1" }),
    }));
    expect(storage.delete).toHaveBeenCalledWith("text/ch-003.b.md");
    expect(db.deleteDocument).toHaveBeenCalledWith("proj-1", "text/ch-003.b.md");
    expect(result.content[0].text).toContain("晋升为 text/ch-003.md（版本 9）");
    expect(result.details.versionNo).toBe(9);
  });

  it("rejects non-variant paths before touching storage", async () => {
    const { ctx, documentWriter } = makeCtx();
    const result = await createPromoteVariantTool(ctx).execute("call-2", { variant_path: "text/ch-003.md" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Not a valid variant path");
    expect(documentWriter.write).not.toHaveBeenCalled();
  });

  it("rejects non-chapter-text documents", async () => {
    const { ctx } = makeCtx();
    const wrongType = variantDoc.replace("type: chapter-text", "type: foreshadow");
    (ctx.storage as any).read = vi.fn(async () => wrongType);

    const result = await createPromoteVariantTool(ctx).execute("call-3", { variant_path: "text/ch-003.b.md" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("chapter-text document");
  });

  it("refuses promotion when the frontmatter chapter does not match the path", async () => {
    const { ctx, documentWriter } = makeCtx();
    const mislabeled = variantDoc.replace("chapter: 3", "chapter: 5");
    (ctx.storage as any).read = vi.fn(async () => mislabeled);

    const result = await createPromoteVariantTool(ctx).execute("call-6", { variant_path: "text/ch-003.b.md" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("chapter mismatch");
    expect(documentWriter.write).not.toHaveBeenCalled();
    expect((ctx.storage as any).delete).not.toHaveBeenCalled();
  });

  it("surfaces read failures as error results", async () => {
    const { ctx } = makeCtx({ readError: new Error("object not found") });
    const result = await createPromoteVariantTool(ctx).execute("call-4", { variant_path: "text/ch-003.b.md" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("object not found");
  });

  it("reports a successful promotion with a cleanup warning when archiving the variant fails", async () => {
    const { ctx, documentWriter } = makeCtx({ cleanupError: new Error("storage unavailable") });
    const result = await createPromoteVariantTool(ctx).execute("call-7", { variant_path: "text/ch-003.b.md" });

    expect(result.isError).toBeUndefined();
    expect(documentWriter.write).toHaveBeenCalled();
    expect(result.content[0].text).toContain("晋升为 text/ch-003.md（版本 9）");
    expect(result.content[0].text).toContain("变体清理失败");
    expect(result.content[0].text).toContain("storage unavailable");
    expect(result.details.cleanupError).toBe("storage unavailable");
  });

  it("refuses without provenance instead of falling back to system writes", async () => {
    const { ctx, documentWriter } = makeCtx();
    (ctx as any).userId = undefined;

    const result = await createPromoteVariantTool(ctx).execute("call-5", { variant_path: "text/ch-003.b.md" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("provenance");
    expect(documentWriter.write).not.toHaveBeenCalled();
  });
});
