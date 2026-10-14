/**
 * Document export module — converts Markdown content to downloadable formats.
 *
 * Supported formats: md (raw Markdown), txt (plain text), docx (Word document).
 */

import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

// ─── Types ────────────────────────────────────────────────────────────────

export type ExportFormat = "md" | "txt" | "docx";

export const EXPORT_FORMATS: ExportFormat[] = ["md", "txt", "docx"];

export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === "string" && (EXPORT_FORMATS as string[]).includes(v);
}

// ─── Filename & content-type helpers ──────────────────────────────────────

export function exportFileName(docPath: string, format: ExportFormat): string {
  const base = docPath.split("/").pop()?.replace(/\.md$/, "") ?? "document";
  const ext: Record<ExportFormat, string> = { md: ".md", txt: ".txt", docx: ".docx" };
  return `${base}${ext[format]}`;
}

export function contentTypeFor(format: ExportFormat): string {
  const types: Record<ExportFormat, string> = {
    md: "text/markdown; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return types[format];
}

// ─── Main entry ───────────────────────────────────────────────────────────

export async function exportDocument(
  content: string,
  docName: string,
  format: ExportFormat,
): Promise<Buffer> {
  switch (format) {
    case "md":
      return buildMdExport(content);
    case "txt":
      return buildTxtExport(content);
    case "docx":
      return buildDocxExport(content, docName);
  }
}

// ─── Markdown (pass-through) ──────────────────────────────────────────────

function buildMdExport(content: string): Buffer {
  return Buffer.from(content, "utf-8");
}

// ─── Plain text (strip Markdown syntax) ───────────────────────────────────

function buildTxtExport(content: string): Buffer {
  let text = content;

  // Remove YAML frontmatter (between --- delimiters at the start)
  text = text.replace(/^---[\s\S]*?---\n*/, "");

  // Remove fenced code blocks (preserve content inside)
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    const lines = match.split("\n");
    // Remove the opening and closing ``` lines
    return lines.slice(1, -1).join("\n") + "\n";
  });

  // Remove inline code backticks (preserve content)
  text = text.replace(/`([^`]+)`/g, "$1");

  // Remove heading markers (keep text)
  text = text.replace(/^#{1,6}\s+/gm, "");

  // Remove bold/italic markers
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
  text = text.replace(/_{1,3}([^_]+)_{1,3}/g, "$1");

  // Remove link syntax [text](url) → keep text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Remove image syntax ![alt](url) → keep alt
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");

  // Remove strikethrough
  text = text.replace(/~~([^~]+)~~/g, "$1");

  // Remove blockquote markers
  text = text.replace(/^>\s?/gm, "");

  // Remove horizontal rules
  text = text.replace(/^[-*_]{3,}\s*$/gm, "");

  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  // Trim leading/trailing whitespace
  text = text.trim() + "\n";

  return Buffer.from(text, "utf-8");
}

// ─── DOCX (Word document) ─────────────────────────────────────────────────

interface MdBlock {
  type: "heading" | "paragraph" | "empty";
  level?: number; // 1–6 for headings
  text: string;
}

/**
 * Minimal Markdown-to-blocks parser.
 *
 * Splits on double-newlines to get blocks, then classifies each block
 * as heading, paragraph, or empty line.  Handles inline **bold**, *italic*,
 * `code`, and [links](url) with simple regex replacements inside each block.
 */
function parseMarkdownBlocks(content: string): MdBlock[] {
  // Strip YAML frontmatter
  const body = content.replace(/^---[\s\S]*?---\n*/, "").trim();

  // Split into blocks separated by blank lines
  const rawBlocks = body.split(/\n\n+/);
  const blocks: MdBlock[] = [];

  for (const raw of rawBlocks) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Heading detection
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/m);
    if (headingMatch) {
      const level = headingMatch[1].length;
      // Get all lines after heading marker, join them
      const headingText = trimmed
        .split("\n")
        .map((line) => line.replace(/^#{1,6}\s+/, ""))
        .join(" ");
      blocks.push({ type: "heading", level, text: headingText });
      continue;
    }

    // Regular paragraph (may contain multiple lines)
    blocks.push({ type: "paragraph", text: trimmed });
  }

  return blocks;
}

/**
 * Parse inline Markdown formatting and return an array of TextRun objects.
 */
function parseInlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  // Process inline formatting: **bold**, *italic*, `code`, [link](url), ~~strikethrough~~
  // We use a simple tokenizer approach.

  let remaining = text;
  let lastIndex = 0;

  // Combined regex for all inline patterns
  const pattern = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))|(~~(.+?)~~)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // Add plain text before this match
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index) }));
    }

    if (match[1]) {
      // **bold**
      runs.push(new TextRun({ text: match[2], bold: true }));
    } else if (match[3]) {
      // *italic*
      runs.push(new TextRun({ text: match[4], italics: true }));
    } else if (match[5]) {
      // `code`
      runs.push(new TextRun({ text: match[6], font: "Courier New" }));
    } else if (match[7]) {
      // [text](url) — render as plain text with URL in parentheses
      runs.push(new TextRun({ text: `${match[9]} (${match[10]})` }));
    } else if (match[11]) {
      // ~~strikethrough~~
      runs.push(new TextRun({ text: match[12], strike: true }));
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex) }));
  }

  return runs;
}

function headingLevelFor(level: number) {
  switch (level) {
    case 1: return HeadingLevel.HEADING_1;
    case 2: return HeadingLevel.HEADING_2;
    case 3: return HeadingLevel.HEADING_3;
    case 4: return HeadingLevel.HEADING_4;
    case 5: return HeadingLevel.HEADING_5;
    case 6: return HeadingLevel.HEADING_6;
    default: return HeadingLevel.HEADING_1;
  }
}

function buildDocxExport(content: string, docName: string): Promise<Buffer> {
  const blocks = parseMarkdownBlocks(content);

  const children: Paragraph[] = [];

  // Title page heading
  children.push(
    new Paragraph({
      text: docName,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    }),
  );

  for (const block of blocks) {
    if (block.type === "heading" && block.level !== undefined) {
      const level = headingLevelFor(block.level);
      children.push(
        new Paragraph({
          text: block.text,
          heading: level,
          spacing: { before: 240, after: 120 },
        }),
      );
    } else {
      // Paragraph: split into lines, each line becomes a Paragraph with inline runs
      const lines = block.text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          children.push(new Paragraph({ spacing: { after: 120 } }));
          continue;
        }

        const runs = parseInlineRuns(trimmed);
        children.push(
          new Paragraph({
            children: runs.length > 0 ? runs : [new TextRun({ text: trimmed })],
            spacing: { after: 120 },
          }),
        );
      }
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: "Noto Serif SC",
            size: 24, // 12pt in half-points
          },
        },
      },
    },
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
