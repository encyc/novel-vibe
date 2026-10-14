import { diffChars, diffLines, diffWordsWithSpace } from "diff";
import { parseFrontmatter } from "../lib/frontmatter.js";
import type {
  DocumentDiffHunk,
  DocumentDiffLine,
  DocumentDiffPage,
  DocumentDiffRecord,
  FrontmatterChange,
  InlineDiffSpan,
} from "./types.js";

export const DIFF_ALGORITHM_VERSION = "jsdiff-v1" as const;
export const DIFF_CONTEXT_LINES = 3;
export const MAX_DIFF_HUNKS = 2_000;
export const MAX_DIFF_LINES = 20_000;
export const MAX_DIFF_LINE_CHARS = 8_000;
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

const SECRET_KEY = /token|secret|password|credential|api[_-]?key/i;
const CJK = /[\u3400-\u9fff]/u;

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function splitChunkLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function boundedText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_DIFF_LINE_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_DIFF_LINE_CHARS - 1) + "…", truncated: true };
}

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safePropertyValue(key: string, value: unknown): unknown {
  return SECRET_KEY.test(key) && value !== undefined ? "[redacted]" : value;
}

function compareFrontmatter(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FrontmatterChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: FrontmatterChange[] = [];
  for (const key of keys) {
    const hadBefore = Object.hasOwn(before, key);
    const hasAfter = Object.hasOwn(after, key);
    if (hadBefore && hasAfter && equalValue(before[key], after[key])) continue;
    if (!hadBefore) {
      changes.push({ key, kind: "added", after: safePropertyValue(key, after[key]) });
    } else if (!hasAfter) {
      changes.push({ key, kind: "removed", before: safePropertyValue(key, before[key]) });
    } else {
      changes.push({
        key,
        kind: "changed",
        before: safePropertyValue(key, before[key]),
        after: safePropertyValue(key, after[key]),
      });
    }
  }
  return changes;
}

function inlineChanges(before: string, after: string): {
  before: InlineDiffSpan[];
  after: InlineDiffSpan[];
} {
  const cjkCount = [...before + after].filter((character) => CJK.test(character)).length;
  const preferChars = cjkCount >= Math.max(2, Math.floor((before.length + after.length) / 4));
  const changes = preferChars ? diffChars(before, after) : diffWordsWithSpace(before, after);
  const deleted: InlineDiffSpan[] = [];
  const inserted: InlineDiffSpan[] = [];
  for (const change of changes) {
    if (change.added) inserted.push({ kind: "insert", text: change.value });
    else if (change.removed) deleted.push({ kind: "delete", text: change.value });
    else {
      deleted.push({ kind: "same", text: change.value });
      inserted.push({ kind: "same", text: change.value });
    }
  }
  return { before: deleted, after: inserted };
}

function applyInlineSpans(lines: DocumentDiffLine[]): void {
  let cursor = 0;
  while (cursor < lines.length) {
    if (lines[cursor]?.kind === "context") {
      cursor++;
      continue;
    }
    const start = cursor;
    while (cursor < lines.length && lines[cursor]?.kind !== "context") cursor++;
    const block = lines.slice(start, cursor);
    const deleted = block.filter((line) => line.kind === "delete");
    const inserted = block.filter((line) => line.kind === "insert");
    for (let index = 0; index < Math.min(deleted.length, inserted.length); index++) {
      const spans = inlineChanges(deleted[index]!.text, inserted[index]!.text);
      deleted[index]!.spans = spans.before;
      inserted[index]!.spans = spans.after;
    }
  }
}

function nearestHeading(lines: DocumentDiffLine[], start: number): string | null {
  for (let index = start; index >= 0; index--) {
    const match = /^#{1,6}\s+(.+?)\s*#*$/u.exec(lines[index]?.text ?? "");
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function buildLines(beforeBody: string, afterBody: string): {
  lines: DocumentDiffLine[];
  addedLines: number;
  deletedLines: number;
  truncated: boolean;
} {
  const lines: DocumentDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let addedLines = 0;
  let deletedLines = 0;
  let truncated = false;
  for (const change of diffLines(beforeBody, afterBody, { newlineIsToken: false })) {
    for (const rawLine of splitChunkLines(change.value)) {
      const bounded = boundedText(rawLine);
      truncated ||= bounded.truncated;
      if (change.added) {
        lines.push({ kind: "insert", oldLine: null, newLine: newLine++, text: bounded.text });
        addedLines++;
      } else if (change.removed) {
        lines.push({ kind: "delete", oldLine: oldLine++, newLine: null, text: bounded.text });
        deletedLines++;
      } else {
        lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: bounded.text });
      }
    }
  }
  return { lines, addedLines, deletedLines, truncated };
}

function buildHunks(lines: DocumentDiffLine[]): { hunks: DocumentDiffHunk[]; truncated: boolean } {
  const changes = lines.flatMap((line, index) => line.kind === "context" ? [] : [index]);
  if (!changes.length) return { hunks: [], truncated: false };
  const ranges: Array<{ start: number; end: number }> = [];
  for (const changedIndex of changes) {
    const start = Math.max(0, changedIndex - DIFF_CONTEXT_LINES);
    const end = Math.min(lines.length, changedIndex + DIFF_CONTEXT_LINES + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }

  let totalLines = 0;
  let truncated = false;
  const hunks: DocumentDiffHunk[] = [];
  for (const range of ranges) {
    if (hunks.length >= MAX_DIFF_HUNKS || totalLines >= MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    const selected = lines.slice(range.start, Math.min(range.end, range.start + (MAX_DIFF_LINES - totalLines)))
      .map((line) => ({ ...line }));
    if (selected.length < range.end - range.start) truncated = true;
    applyInlineSpans(selected);
    totalLines += selected.length;
    hunks.push({
      index: hunks.length,
      section: nearestHeading(lines, range.start),
      oldStart: selected.find((line) => line.oldLine !== null)?.oldLine ?? 0,
      newStart: selected.find((line) => line.newLine !== null)?.newLine ?? 0,
      lines: selected,
    });
  }
  return { hunks, truncated };
}

function enforceByteLimit(record: DocumentDiffRecord): DocumentDiffRecord {
  const copy = structuredClone(record);
  const size = () => new TextEncoder().encode(JSON.stringify(copy)).byteLength;
  while (copy.hunks.length && size() > MAX_DIFF_BYTES) {
    copy.hunks.pop();
    copy.truncated = true;
  }
  if (size() > MAX_DIFF_BYTES) {
    copy.frontmatterChanges = [];
    copy.changedSections = [];
    copy.truncated = true;
  }
  return copy;
}

export function computeDocumentDiff(
  beforeContent: string,
  afterContent: string,
): DocumentDiffRecord {
  const before = parseFrontmatter(normalizeLineEndings(beforeContent));
  const after = parseFrontmatter(normalizeLineEndings(afterContent));
  const built = buildLines(before.body, after.body);
  const grouped = buildHunks(built.lines);
  const changedSections = [...new Set(grouped.hunks.flatMap((hunk) => hunk.section ? [hunk.section] : []))];
  return enforceByteLimit({
    algorithmVersion: DIFF_ALGORITHM_VERSION,
    status: "ready",
    hunks: grouped.hunks,
    frontmatterChanges: compareFrontmatter(before.frontmatter, after.frontmatter),
    addedLines: built.addedLines,
    deletedLines: built.deletedLines,
    changedSections,
    truncated: built.truncated || grouped.truncated,
  });
}

export function sliceDiffPage(
  record: DocumentDiffRecord,
  cursor: string | null,
  limit: number,
): DocumentDiffPage {
  const start = cursor === null ? 0 : Number.parseInt(cursor, 10);
  if (!Number.isInteger(start) || start < 0) throw new Error("Invalid diff cursor");
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const items = record.hunks.slice(start, start + boundedLimit);
  const next = start + items.length;
  const { hunks: _hunks, ...metadata } = record;
  return {
    ...metadata,
    items,
    nextCursor: next < record.hunks.length ? String(next) : null,
  };
}
