import { describe, expect, it } from "vitest";
import {
  contentTypeFor,
  exportDocument,
  exportFileName,
  EXPORT_FORMATS,
  isExportFormat,
} from "./export.js";

const sampleMd = `---
name: 第一章 初入江湖
type: chapter-text
status: draft
---

# 第一章 初入江湖

夜雨淅沥，**青石**板路上泛起一层薄薄的水光。

> 江湖传言，此人剑法通神。

他说："*既然来了*，就留下吧。"

## 第一节 客栈

- 第一件事
- 第二件事

### 更深露重

风声呼啸，~~掩盖了~~所有的脚步声。`;

describe("isExportFormat", () => {
  it("accepts md, txt, docx", () => {
    expect(isExportFormat("md")).toBe(true);
    expect(isExportFormat("txt")).toBe(true);
    expect(isExportFormat("docx")).toBe(true);
  });

  it("rejects unknown formats", () => {
    expect(isExportFormat("pdf")).toBe(false);
    expect(isExportFormat("epub")).toBe(false);
    expect(isExportFormat("")).toBe(false);
    expect(isExportFormat(123)).toBe(false);
  });
});

describe("EXPORT_FORMATS", () => {
  it("contains exactly md, txt, docx", () => {
    expect(EXPORT_FORMATS).toEqual(["md", "txt", "docx"]);
  });
});

describe("exportFileName", () => {
  it("replaces .md extension with the format extension", () => {
    expect(exportFileName("chapters/001.md", "md")).toBe("001.md");
    expect(exportFileName("chapters/001.md", "txt")).toBe("001.txt");
    expect(exportFileName("chapters/001.md", "docx")).toBe("001.docx");
  });

  it("handles paths without .md extension", () => {
    expect(exportFileName("chapters/001", "docx")).toBe("001.docx");
  });
});

describe("contentTypeFor", () => {
  it("returns correct MIME types", () => {
    expect(contentTypeFor("md")).toBe("text/markdown; charset=utf-8");
    expect(contentTypeFor("txt")).toBe("text/plain; charset=utf-8");
    expect(contentTypeFor("docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });
});

describe("exportDocument", () => {
  describe("md", () => {
    it("returns raw markdown content as buffer", async () => {
      const buf = await exportDocument(sampleMd, "第一章 初入江湖", "md");
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.toString("utf-8")).toBe(sampleMd);
    });
  });

  describe("txt", () => {
    it("strips YAML frontmatter", async () => {
      const buf = await exportDocument(sampleMd, "第一章 初入江湖", "txt");
      const text = buf.toString("utf-8");
      expect(text).not.toContain("---");
      expect(text).not.toContain("type:");
      expect(text).not.toContain("chapter-text");
    });

    it("strips heading markers but keeps heading text", async () => {
      const buf = await exportDocument("# 标题", "test", "txt");
      const text = buf.toString("utf-8").trim();
      expect(text).toBe("标题");
    });

    it("strips bold/italic markers", async () => {
      const buf = await exportDocument("这是**粗体**和*斜体*文本", "test", "txt");
      const text = buf.toString("utf-8").trim();
      expect(text).toBe("这是粗体和斜体文本");
    });

    it("strips link syntax keeping text", async () => {
      const buf = await exportDocument("查看[链接](https://example.com)", "test", "txt");
      const text = buf.toString("utf-8").trim();
      expect(text).toBe("查看链接");
    });

    it("strips strikethrough", async () => {
      const buf = await exportDocument("这是~~删除~~文本", "test", "txt");
      const text = buf.toString("utf-8").trim();
      expect(text).toBe("这是删除文本");
    });

    it("returns non-empty output", async () => {
      const buf = await exportDocument(sampleMd, "第一章 初入江湖", "txt");
      const text = buf.toString("utf-8");
      expect(text.length).toBeGreaterThan(0);
      // 夜雨淅沥 should be present (from body content, not frontmatter)
      expect(text).toContain("夜雨淅沥");
    });
  });

  describe("docx", () => {
    it("returns a non-empty buffer", async () => {
      const buf = await exportDocument(sampleMd, "第一章 初入江湖", "docx");
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.byteLength).toBeGreaterThan(0);
    });

    it("returns valid ZIP (DOCX is ZIP-based)", async () => {
      const buf = await exportDocument(sampleMd, "第一章 初入江湖", "docx");
      // ZIP magic bytes: PK\x03\x04
      expect(buf[0]).toBe(0x50); // P
      expect(buf[1]).toBe(0x4b); // K
    });

    it("handles minimal markdown", async () => {
      const buf = await exportDocument("Hello world", "test", "docx");
      expect(buf.byteLength).toBeGreaterThan(0);
      expect(buf[0]).toBe(0x50);
      expect(buf[1]).toBe(0x4b);
    });
  });
});
