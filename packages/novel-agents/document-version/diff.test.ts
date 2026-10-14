import { describe, expect, it } from "vitest";
import {
  computeDocumentDiff,
  MAX_DIFF_LINE_CHARS,
  sliceDiffPage,
} from "./diff.js";

describe("computeDocumentDiff", () => {
  it("separates frontmatter and diffs Chinese prose", () => {
    const before = "---\ntype: chapter-text\nstatus: draft\n---\n\n# 雨夜\n\n他停下脚步，回头看了一眼。\n";
    const after = "---\ntype: chapter-text\nstatus: confirmed\n---\n\n# 雨夜\n\n身后的雨声忽然断了一拍。\n他停住，却没有回头。\n";

    const result = computeDocumentDiff(before, after);

    expect(result.algorithmVersion).toBe("jsdiff-v1");
    expect(result.frontmatterChanges).toEqual([{
      key: "status",
      before: "draft",
      after: "confirmed",
      kind: "changed",
    }]);
    expect(result.changedSections).toEqual(["雨夜"]);
    expect(result).toMatchObject({ addedLines: 2, deletedLines: 1 });
    expect(result.hunks[0]?.lines.some((line) => line.kind === "delete")).toBe(true);
    expect(result.hunks[0]?.lines.some((line) => line.kind === "insert")).toBe(true);
  });

  it("normalizes CRLF and paginates hunks", () => {
    const before = Array.from({ length: 20 }, (_, index) => [
      ...Array.from({ length: 8 }, (__, common) => `共同行 ${index}-${common}`),
      `旧 ${index}`,
    ]).flat().join("\r\n");
    const after = Array.from({ length: 20 }, (_, index) => [
      ...Array.from({ length: 8 }, (__, common) => `共同行 ${index}-${common}`),
      `新 ${index}`,
    ]).flat().join("\n");

    const first = sliceDiffPage(computeDocumentDiff(before, after), null, 2);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe("2");
    const second = sliceDiffPage(computeDocumentDiff(before, after), first.nextCursor, 2);
    expect(second.items[0]?.index).toBe(2);
  });

  it("represents a frontmatter-only change without body hunks", () => {
    const result = computeDocumentDiff(
      "---\nstatus: draft\n---\n正文",
      "---\nstatus: locked\n---\n正文",
    );

    expect(result.hunks).toEqual([]);
    expect(result.frontmatterChanges[0]).toMatchObject({ key: "status", kind: "changed" });
  });

  it("redacts secret-like frontmatter values", () => {
    const result = computeDocumentDiff(
      "---\napi_key: old-secret\n---\n正文",
      "---\napi_key: new-secret\n---\n正文",
    );

    expect(result.frontmatterChanges).toEqual([{
      key: "api_key",
      before: "[redacted]",
      after: "[redacted]",
      kind: "changed",
    }]);
  });

  it("bounds long changed lines and reports truncation", () => {
    const result = computeDocumentDiff(`旧${"字".repeat(MAX_DIFF_LINE_CHARS + 50)}`, "新内容");

    expect(result.truncated).toBe(true);
    expect(Math.max(...result.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text.length))))
      .toBeLessThanOrEqual(MAX_DIFF_LINE_CHARS);
  });
});
