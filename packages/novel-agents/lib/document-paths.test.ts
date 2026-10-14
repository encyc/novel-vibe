import { describe, expect, it } from "vitest";
import { chapterTextPath, parseChapterTextPath } from "./document-paths.js";

describe("chapter document paths", () => {
  it("emits the compact canonical chapter path", () => {
    expect(chapterTextPath(7)).toBe("text/ch-007.md");
  });

  it("parses canonical and legacy chapter paths", () => {
    expect(parseChapterTextPath("text/ch-007.md")).toBe(7);
    expect(parseChapterTextPath("text/chapter-007.md")).toBe(7);
  });

  it("rejects malformed or out-of-scope paths", () => {
    expect(parseChapterTextPath("text/ch-07.md")).toBeNull();
    expect(parseChapterTextPath("outline/vol-1/ch-007.md")).toBeNull();
    expect(parseChapterTextPath("text/ch-000.md")).toBeNull();
  });

  it("rejects invalid chapter numbers when generating paths", () => {
    expect(() => chapterTextPath(0)).toThrow("positive integer");
    expect(() => chapterTextPath(1.5)).toThrow("positive integer");
    expect(() => chapterTextPath(1000)).toThrow("three digits");
  });
});
