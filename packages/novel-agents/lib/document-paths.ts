const CHAPTER_TEXT_PATH = /^text\/(?:ch|chapter)-(\d{3})\.md$/;

export function chapterTextPath(chapter: number): string {
  if (!Number.isInteger(chapter) || chapter <= 0) {
    throw new Error("Chapter number must be a positive integer");
  }
  if (chapter > 999) throw new Error("Chapter number must fit in three digits");
  return `text/ch-${String(chapter).padStart(3, "0")}.md`;
}

export function parseChapterTextPath(path: string): number | null {
  const match = path.match(CHAPTER_TEXT_PATH);
  if (!match) return null;
  const chapter = Number(match[1]);
  return chapter > 0 ? chapter : null;
}
