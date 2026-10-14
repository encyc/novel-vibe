export interface FrontmatterSplit {
  /** Raw YAML lines between the opening and closing `---` markers. */
  yaml: string;
  /** Document body with the frontmatter block removed. */
  body: string;
}

const OPEN_RE = /^---\s*$/;
const CLOSE_RE = /^(?:---|\.\.\.)\s*$/;

/**
 * Split YAML frontmatter off a Markdown string, mirroring the agent-side
 * parser's file shape: `---` on the first line, closed by the next `---` or
 * `...` line. Returns null when the content has no frontmatter block.
 */
export function splitFrontmatter(content: string): FrontmatterSplit | null {
  const lines = content.split("\n");
  if (!OPEN_RE.test(lines[0]?.trim() ?? "")) return null;
  const close = lines.findIndex((line, index) => index > 0 && CLOSE_RE.test(line.trim()));
  if (close < 1) return null;
  return {
    yaml: lines.slice(1, close).join("\n").trim(),
    body: lines.slice(close + 1).join("\n").replace(/^\s*\n+/, ""),
  };
}
