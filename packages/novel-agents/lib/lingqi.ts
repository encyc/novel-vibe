/**
 * LINGQI.md — project-level creation guide (similar to CLAUDE.md / AGENTS.md).
 *
 * A single Markdown file at the root of each novel project
 * (`novels/{projectId}/LINGQI.md`) that carries style/voice/world/business
 * instructions for the agents. It is NOT indexed in `document_index` (it has
 * no `type` frontmatter, so write_doc / HTTP PUT skip the index step).
 *
 * Sections are dispatched to agents by role tags in the heading:
 *
 *   ## 全局禁忌                  → no tag = every agent sees it
 *   ## [all] 备注                → explicit "all" = every agent
 *   ## [writer, director] 文风   → only listed roles see it
 *
 * The file may carry a `---` frontmatter block (version/updated_at); it is
 * parsed away and never participates in dispatch.
 */
import type { AgentId } from "../session/types.js";

const ALL_AGENTS: AgentId[] = [
  "chief_editor",
  "worldbuilder",
  "character_designer",
  "outliner",
  "director",
  "writer",
  "script_supervisor",
];

export interface LingqiSection {
  /** Roles that should see this section. `null` = all agents. */
  roles: AgentId[] | null;
  /** Original heading line without the leading `##`/`###`. */
  heading: string;
  /** Body text under the heading (trailing whitespace trimmed). */
  body: string;
}

export interface ParsedLingqi {
  frontmatter: Record<string, unknown>;
  sections: LingqiSection[];
}

/** Strip a leading `---` frontmatter block. Mirrors lib/frontmatter.ts. */
function stripFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const yaml = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 4).replace(/^\s*\n/, "");
  return { frontmatter: parseFlatYaml(yaml), body };
}

/** Parse flat `key: value` YAML lines into a record. Good enough for version/updated_at. */
function parseFlatYaml(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value: unknown = line.slice(colon + 1).trim();
    if (typeof value === "string") {
      if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
      else if (value === "true") value = true;
      else if (value === "false") value = false;
      else value = value.replace(/^["']|["']$/g, "");
    }
    out[key] = value;
  }
  return out;
}

const HEADING_RE = /^(#{1,6})\s+\[(.*?)\]\s*(.*)$/;
const PLAIN_HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Parse a `[a, b]` role tag list into a normalized set of AgentIds, or `null` for "all". */
function parseRoles(tag: string): AgentId[] | null {
  const normalized = tag.split(",").map((s) => s.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean);
  if (normalized.length === 0 || normalized.includes("all")) return null;
  return normalized.filter((r): r is AgentId => (ALL_AGENTS as string[]).includes(r));
}

/**
 * Parse a LINGQI.md document into dispatchable sections.
 *
 * Headings WITHOUT a `[roles]` tag, or tagged `[all]`, are visible to every
 * agent. The frontmatter block is stripped and never returned in `sections`.
 *
 * Only level-2+ headings (`##`, `###`, …) open dispatchable sections. A
 * document-level `# Title` H1 is treated as a title and ignored — it would
 * otherwise become an empty all-agent section and shift every real section's
 * index.
 */
export function parseLingqi(content: string): ParsedLingqi {
  const { frontmatter, body } = stripFrontmatter(content);
  const sections: LingqiSection[] = [];

  const lines = body.split("\n");
  let current: LingqiSection | null = null;

  const flush = () => {
    if (current) {
      current.body = current.body.replace(/\s+$/, "");
      sections.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    // Skip H1 — it's the document title, not a dispatchable section.
    if (/^#\s/.test(line) && !/^##/.test(line)) {
      flush();
      continue;
    }
    const tagged = line.match(HEADING_RE);
    const plain = !tagged ? line.match(PLAIN_HEADING_RE) : null;
    if (tagged) {
      flush();
      current = { roles: parseRoles(tagged[2]), heading: `[${tagged[2]}] ${tagged[3]}`.trim(), body: "" };
    } else if (plain) {
      flush();
      current = { roles: null, heading: plain[2].trim(), body: "" };
    } else if (current) {
      current.body += (current.body ? "\n" : "") + line;
    }
    // Lines before the first dispatchable heading are dropped.
  }
  flush();

  return { frontmatter, sections };
}

/**
 * Return the LINGQI.md text visible to `agentId`: every section tagged for all,
 * plus every section whose role list contains `agentId`. Sections are joined
 * with their headings. Returns "" when nothing applies.
 */
export function filterForAgent(parsed: ParsedLingqi, agentId: AgentId): string {
  const visible = parsed.sections.filter(
    (s) => s.roles === null || s.roles.includes(agentId),
  );
  if (visible.length === 0) return "";
  return visible.map((s) => `## ${s.heading}\n${s.body}`.trim()).join("\n\n");
}
