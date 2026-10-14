/**
 * File operation tools for Novel Vibe agents.
 * Read, write, search, and list Markdown documents in InsForge Storage.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { isReservedDocumentPath } from "../lib/storage.js";
import type { ContentStore } from "../lib/content-store.js";
import { createContentStore } from "../lib/content-store-factory.js";
import { DbClient } from "../lib/db.js";
import { parseFrontmatter } from "../lib/frontmatter.js";
import { skillFilePath, loadBuiltInSkillContent } from "../lib/skills.js";
import { documentWrites, documentWriteKey } from "../lib/document-write-coordinator.js";
import { ProjectRepository } from "../project/repository.js";
import { ProjectService } from "../project/service.js";
import { createHash } from "node:crypto";
import { checkCapabilityCompatibility } from "../skills/capabilities.js";
import { SKILL_POLICY_VERSION, type SkillRole } from "../skills/policy.js";
import { DocumentVersionRepository } from "../document-version/repository.js";
import { VersionedDocumentWriter } from "../document-version/service.js";
import { InteractionRepository } from "../interactions/repository.js";
import { prepareIndexedDocument, syncPreparedDocument } from "../lib/document-indexing.js";
import { ALLOW_ALL_ENTITLEMENTS, type EntitlementPort } from "../lib/policy-ports.js";

// ─── Shared context ───────────────────────────────────────────────

export interface ToolContext {
  storage: ContentStore;
  /** User-token skills storage — RLS-isolated to this user's own skills. */
  skillsStorage: ContentStore;
  db: DbClient;
  projectId: string;
  userId?: string;
  sessionId?: string;
  turnId?: string;
  assistantMessageId?: string;
  /** Trusted background job provenance; mutually exclusive with Agent turn provenance. */
  systemJobId?: string;
  /**
   * Membership gate port. Injected by the composition root (SaaS adapter for
   * hosted builds, allow-all for local-first). Tools never read the membership
   * tables themselves.
   */
  entitlements: EntitlementPort;
  interactionRepository?: Pick<InteractionRepository, "create">;
  documentWriter: Pick<VersionedDocumentWriter, "write">;
  assertProjectWritable: () => Promise<void>;
  onDocumentStatusChanged?: (event: DocumentStatusChange) => Promise<void>;
}

export interface DocumentStatusChange {
  path: string;
  status: string;
  previousStatus: string;
  chapterNumber?: number;
  confirmedHash?: string;
}

export function createToolContext(
  token: string,
  projectId: string,
  userId?: string,
  sessionId?: string,
  systemJobId?: string,
  entitlements?: EntitlementPort,
): ToolContext {
  const db = DbClient.forUser(token);
  const projectService = new ProjectService(new ProjectRepository(db));
  const storage = createContentStore({ mode: "user", token, bucket: "novels", projectId });
  const documentWriter = new VersionedDocumentWriter({
    storage,
    repository: new DocumentVersionRepository(db),
    afterHeadWrite: async (input, afterHash) => {
      const prepared = prepareIndexedDocument(input.path, input.content);
      if (!prepared) return false;
      await syncPreparedDocument(db, projectId, prepared, afterHash);
      return true;
    },
  });
  return {
    // Storage routes require the real user's sub claim so uploaded_by passes RLS.
    storage,
    skillsStorage: createContentStore({ mode: "user", token, bucket: "skills" }),
    db,
    projectId,
    userId,
    sessionId,
    systemJobId,
    // Omitted means local/single-user mode, where the person running the software
    // owns every capability — the same stance as `ALLOW_ALL_ENTITLEMENTS`.
    entitlements: entitlements ?? ALLOW_ALL_ENTITLEMENTS,
    interactionRepository: new InteractionRepository(db),
    documentWriter,
    assertProjectWritable: () => projectService.assertProjectWritable(projectId),
  };
}

// ─── read_doc ─────────────────────────────────────────────────────

const readDocParams = Type.Object({
  path: Type.String({ description: "Document path relative to project root, e.g. 'characters/lin-fan.md'" }),
  offset: Type.Optional(Type.Number({ minimum: 1, description: "1-based line number to start reading from (pairs with search_docs line numbers)" })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2000, description: "Maximum number of lines to return" })),
});

export function createReadDocTool(ctx: ToolContext): AgentTool<typeof readDocParams> {
  return {
    name: "read_doc",
    label: "Read Document",
    description: "Read a Markdown document from the novel project storage. Returns the full content including YAML frontmatter. Pass offset/limit to read a numbered line window starting from a search_docs hit.",
    parameters: readDocParams,
    execute: async (_, params) => {
      try {
        const content = await ctx.storage.read(params.path);
        if (params.offset === undefined && params.limit === undefined) {
          return {
            content: [{ type: "text" as const, text: content }],
            details: { path: params.path, size: content.length },
          };
        }
        const lines = content.split("\n");
        const totalLines = lines.length;
        const start = Math.max(0, (params.offset ?? 1) - 1);
        if (start >= totalLines) {
          return {
            content: [{ type: "text" as const, text: `Offset ${params.offset} is beyond end of file (${params.path}, ${totalLines} lines)` }],
            details: { path: params.path, totalLines, offset: params.offset },
          };
        }
        const window = lines.slice(start, params.limit !== undefined ? start + params.limit : undefined);
        const truncated = params.limit !== undefined && start + window.length < totalLines;
        const numbered = window.map((line, idx) => `${start + idx + 1}: ${line}`).join("\n");
        return {
          content: [{ type: "text" as const, text: numbered }],
          details: { path: params.path, size: content.length, totalLines, returnedLines: window.length, offset: start + 1, truncated },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error reading ${params.path}: ${err.message}` }],
          details: { path: params.path, error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── load_skill ───────────────────────────────────────────────────

const loadSkillParams = Type.Object({
  slug: Type.String({ description: "Skill slug (directory name), e.g. 'my-writing-style'" }),
});

const listSkillsParams = Type.Object({});

function normalizeSkillSlug(value: string): string {
  const trimmed = value.trim();
  const match = /(?:^|\/)([^/]+)\/SKILL\.md$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

async function canLoadSkillForRole(ctx: ToolContext, skill: any, slug: string, role: SkillRole): Promise<boolean> {
  if (skill.source === "built-in") {
    return slug !== "skill-creator" || role === "chief_editor";
  }
  if (skill.review_status !== "approved" || skill.review_policy_version !== SKILL_POLICY_VERSION) {
    return false;
  }
  const roles = await ctx.db.listSkillRoles(skill.id);
  if (!roles.includes(role)) return false;
  const required = Array.isArray(skill.metadata?.requiredCapabilities)
    ? skill.metadata.requiredCapabilities.filter((item: unknown): item is string => typeof item === "string")
    : [];
  return checkCapabilityCompatibility(role, required).ok;
}

function skillLocation(skill: any, slug: string, userId?: string): string {
  return skill.source === "built-in"
    ? `builtin/${slug}/SKILL.md`
    : skillFilePath(slug, "user", skill.user_id ?? userId);
}

export function createListSkillsTool(ctx: ToolContext, role: SkillRole = "chief_editor"): AgentTool<typeof listSkillsParams> {
  return {
    name: "list_skills",
    label: "List Skills",
    description: "List skills enabled for this project and loadable by the current Agent role. Use this when you need to discover available skills before calling load_skill.",
    parameters: listSkillsParams,
    execute: async () => {
      try {
        const workspaceSkills = await ctx.db.listWorkspaceSkills(ctx.projectId);
        const enabledSlugs = workspaceSkills
          .filter((entry: any) => entry.enabled)
          .map((entry: any) => entry.skill_slug);
        const skills: Array<{
          slug: string;
          name: string;
          description: string;
          source: string;
          location: string;
        }> = [];

        for (const slug of enabledSlugs) {
          const skill = await ctx.db.getSkillForUser(slug, ctx.userId);
          if (!skill) continue;
          if (!(await canLoadSkillForRole(ctx, skill, slug, role))) continue;
          skills.push({
            slug,
            name: skill.name ?? slug,
            description: skill.description ?? "",
            source: skill.source === "built-in" ? "built-in" : "user",
            location: skillLocation(skill, slug, ctx.userId),
          });
        }

        const text = skills.length > 0
          ? skills
            .map((skill) => `- ${skill.slug} (${skill.name}) [${skill.source}]\n  location: ${skill.location}\n  description: ${skill.description}`)
            .join("\n")
          : "No skills are enabled for this project and Agent role.";

        return {
          content: [{ type: "text" as const, text }],
          details: { role, count: skills.length, skills },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error listing skills: ${err.message}` }],
          details: { role, error: true },
          isError: true,
        };
      }
    },
  };
}

export function createLoadSkillTool(ctx: ToolContext, role: SkillRole = "chief_editor"): AgentTool<typeof loadSkillParams> {
  return {
    name: "load_skill",
    label: "Load Skill",
    description: "Load a skill's full SKILL.md content from storage. Use when a task matches a skill's description — read the skill file to get detailed instructions before proceeding.",
    parameters: loadSkillParams,
    execute: async (_, params) => {
      const slug = normalizeSkillSlug(params.slug);
      try {
        // Resolve the skill scoped to this user (built-in wins on collision).
        const skill = await ctx.db.getSkillForUser(slug, ctx.userId);
        if (!skill) {
          return {
            content: [{ type: "text" as const, text: `Skill "${slug}" not found` }],
            details: { slug, error: true },
            isError: true,
          };
        }
        const workspaceSkills = await ctx.db.listWorkspaceSkills(ctx.projectId);
        if (!workspaceSkills.some((entry: any) => entry.skill_slug === slug && entry.enabled)) {
          throw new Error("Skill is not enabled for this project");
        }
        if (!(await canLoadSkillForRole(ctx, skill, slug, role))) {
          throw new Error("Skill is not loadable by this Agent role");
        }
        // Built-ins use the verified platform resource service. User skills
        // keep using the user's own token, preserving RLS isolation.
        let content: string;
        if (skill.source === "built-in") {
          const file = await loadBuiltInSkillContent(slug);
          if (!file) {
            return {
              content: [{ type: "text" as const, text: `Skill "${slug}" not found` }],
              details: { slug, error: true },
              isError: true,
            };
          }
          content = file.content;
        } else {
          const filePath = skillFilePath(slug, "user", skill.user_id);
          content = await ctx.skillsStorage.read(filePath);
          const actualHash = createHash("sha256").update(content, "utf8").digest("hex");
          if (!skill.approved_content_hash || skill.approved_content_hash !== actualHash) {
            throw new Error("Skill content no longer matches its approved review");
          }
        }
        return {
          content: [{ type: "text" as const, text: content }],
          details: { slug, size: content.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Skill "${slug}" not found: ${err.message}` }],
          details: { slug, error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── write_doc ────────────────────────────────────────────────────

const writeDocParams = Type.Object({
  path: Type.String({ description: "Document path, e.g. worldview/power-system.md, characters/protagonist.md, outline/volume-01.md, text/ch-001.md" }),
  content: Type.String({ description: "Full Markdown content including YAML frontmatter" }),
});

export function createWriteDocTool(ctx: ToolContext, role: SkillRole = "chief_editor"): AgentTool<typeof writeDocParams> {
  return {
    name: "write_doc",
    label: "Write Document",
    description: "Write a Markdown document to the novel project storage and sync its frontmatter to the database index. Both 'path' and 'content' are required. Path format: {type}/{name}.md, e.g. worldview/power-system.md. Content must include valid YAML frontmatter.",
    parameters: writeDocParams,
    execute: async (toolCallId, params) => {
      try {
        await ctx.assertProjectWritable();
        if (isReservedDocumentPath(params.path)) throw new Error("Invalid or reserved document path");
        prepareIndexedDocument(params.path, params.content);
        if (role === "script_supervisor") {
          await validateSupervisorWrite(ctx, params.path, params.content);
        }
        const source = ctx.systemJobId
          ? { type: "system" as const, jobId: ctx.systemJobId }
          : ctx.userId && ctx.sessionId && ctx.turnId
            ? {
                type: "agent" as const,
                userId: ctx.userId,
                agentId: role,
                sessionId: ctx.sessionId,
                turnId: ctx.turnId,
                toolCallId,
              }
            : null;
        if (!source) throw new Error("Missing Agent document write provenance");
        const result = await ctx.documentWriter.write({
          projectId: ctx.projectId,
          path: params.path,
          content: params.content,
          source,
        });
        return {
          content: [{ type: "text" as const, text: result.changed
            ? `Document written: ${result.path} (version ${result.versionNo})`
            : `Document unchanged: ${result.path}` }],
          details: result.changed ? {
            changed: true,
            path: result.path,
            versionId: result.versionId,
            versionNo: result.versionNo,
            addedLines: result.addedLines,
            deletedLines: result.deletedLines,
            changedSections: result.changedSections,
            indexed: result.indexed,
          } : { changed: false, path: result.path },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error writing ${params.path}: ${err.message}` }],
          details: { path: params.path, error: true },
          isError: true,
        };
      }
    },
  };
}

async function validateSupervisorWrite(ctx: ToolContext, path: string, content: string): Promise<void> {
  const canonicalPath = path === "summary/story-so-far.md"
    || /^characters\/[a-z0-9-]+-state\.md$/.test(path)
    || /^foreshadowing\/fs-\d{3}\.md$/.test(path);
  if (!canonicalPath) {
    throw new Error(`script_supervisor output path must be canonical: ${path}`);
  }

  const { frontmatter } = parseFrontmatter(content);
  const type = frontmatter.type ?? frontmatter.doc_type;
  if (typeof type !== "string") throw new Error("script_supervisor output requires frontmatter.type");
  if (path === "summary/story-so-far.md" && type !== "story-summary") {
    throw new Error("summary/story-so-far.md must use type story-summary");
  }
  if (path.includes("-state.md") && type !== "character-state") {
    throw new Error("character state paths must use type character-state");
  }
  if (path.startsWith("foreshadowing/") && type !== "foreshadow") {
    throw new Error("foreshadowing paths must use type foreshadow");
  }

  const latestChapter = frontmatter.latest_chapter;
  if (type === "story-summary" || type === "character-state") {
    if (typeof latestChapter !== "number") throw new Error(`${type} requires numeric latest_chapter`);
    const existing = await ctx.db.getDocument(ctx.projectId, path);
    const previousChapter = existing?.meta?.latest_chapter;
    if (typeof previousChapter === "number" && latestChapter < previousChapter) {
      throw new Error(`${path} latest_chapter cannot move backwards from ${previousChapter} to ${latestChapter}`);
    }
  }
}

// ─── delete_doc ───────────────────────────────────────────────────

const deleteDocParams = Type.Object({
  path: Type.String({ description: "Document path to delete, e.g. 'characters/old-character.md'" }),
});

export function createDeleteDocTool(ctx: ToolContext): AgentTool<typeof deleteDocParams> {
  return {
    name: "delete_doc",
    label: "Delete Document",
    description: "Delete a document from both storage and the database index. This operation is irreversible.",
    parameters: deleteDocParams,
    execute: async (_, params) => documentWrites.run(
      documentWriteKey(ctx.projectId, params.path),
      async () => {
      try {
        await ctx.assertProjectWritable();
        // 1. Read the file first to check if it's a foreshadow (need to clean foreshadow_index too)
        let isForeshadow = false;
        let foreshadowId = "";
        try {
          const content = await ctx.storage.read(params.path);
          const { frontmatter } = parseFrontmatter(content);
          if ((frontmatter.type ?? frontmatter.doc_type) === "foreshadow") {
            isForeshadow = true;
            foreshadowId = frontmatter.id as string;
          }
        } catch {
          // File doesn't exist or can't be read — still try to clean up DB record
        }

        // 2. Delete from storage
        await ctx.storage.delete(params.path);

        // 3. Delete from document_index
        await ctx.db.deleteDocument(ctx.projectId, params.path);

        // 4. If foreshadow, also clean up foreshadow_index
        if (isForeshadow && foreshadowId) {
          try {
            await ctx.db.deleteForeshadow(ctx.projectId, foreshadowId);
          } catch {
            // Best-effort
          }
        }

        return {
          content: [{ type: "text" as const, text: `Document deleted: ${params.path}` }],
          details: { path: params.path, deleted: true },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error deleting ${params.path}: ${err.message}` }],
          details: { path: params.path, error: true },
          isError: true,
        };
      }
      },
    ),
  };
}

// ─── search_docs ──────────────────────────────────────────────────

const SEARCH_PAGE_SIZE = 50;
const SEARCH_SNIPPET_MAX = 200;

const searchDocsParams = Type.Object({
  query: Type.String({ description: "Case-sensitive JavaScript regular expression, e.g. 林默|northern-pass or ch37" }),
  scope: Type.Optional(Type.String({ description: "Optional doc_type filter: characters, worldview, outline, outline-skeleton, scripts, text, foreshadowing, summary, volume. Omit to search every indexed document." })),
  chapter_range: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2, description: "Optional [from, to]; filters chapter documents by their index chapter_num before reading any file" })),
  context_lines: Type.Optional(Type.Number({ minimum: 0, maximum: 3, description: "Lines of context around each match (0-3, default 0)" })),
  mode: Type.Optional(Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count")], { description: "content = matching lines with path:line numbers (paginated); files = paths with match totals; count = per-path match counts. Default: content." })),
  cursor: Type.Optional(Type.String({ description: "Opaque cursor from a previous truncated result; pass it to fetch the next page" })),
});

/** Map user-facing scope name to doc_type filter. */
const SCOPE_DOC_TYPE: Record<string, string> = {
  characters: "character",
  worldview: "worldview",
  outline: "chapter-card",
  "outline-skeleton": "chapter-skeleton",
  scripts: "director-script",
  text: "chapter-text",
  foreshadowing: "foreshadow",
  summary: "story-summary",
};

interface SearchMatch {
  path: string;
  line: number;
  text: string;
  contextBefore: string[];
  contextAfter: string[];
}

function encodeSearchCursor(skip: number): string {
  return Buffer.from(String(skip), "utf8").toString("base64");
}

function decodeSearchCursor(cursor: string): number {
  const skip = Number(Buffer.from(cursor, "base64").toString("utf8"));
  if (!Number.isInteger(skip) || skip < 0) throw new Error(`Invalid search cursor: ${cursor}`);
  return skip;
}

function scanDocumentLines(content: string, regex: RegExp, contextRadius: number, path: string): SearchMatch[] {
  const lines = content.split("\n");
  const matches: SearchMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!regex.test(lines[i])) continue;
    matches.push({
      path,
      line: i + 1,
      text: lines[i].trim().slice(0, SEARCH_SNIPPET_MAX),
      contextBefore: lines.slice(Math.max(0, i - contextRadius), i).map((l) => l.trim().slice(0, SEARCH_SNIPPET_MAX)),
      contextAfter: lines.slice(i + 1, i + 1 + contextRadius).map((l) => l.trim().slice(0, SEARCH_SNIPPET_MAX)),
    });
  }
  return matches;
}

export function createSearchDocsTool(ctx: ToolContext): AgentTool<typeof searchDocsParams> {
  return {
    name: "search_docs",
    label: "Search Documents",
    description: "Grep every project document with a regular expression. Returns path:line numbers you can pass to read_doc(offset=...). Use chapter_range or scope to narrow before scanning when you already know where to look.",
    parameters: searchDocsParams,
    execute: async (_, params) => {
      try {
        const regex = new RegExp(params.query);
        const docType = params.scope ? (SCOPE_DOC_TYPE[params.scope] ?? params.scope) : undefined;
        const docs = await ctx.db.listDocuments(ctx.projectId, docType);
        const range = params.chapter_range;
        const candidates = range
          ? docs.filter((d: any) => typeof d.chapter_num === "number" && d.chapter_num >= range[0] && d.chapter_num <= range[1])
          : docs;

        const contextRadius = params.context_lines ?? 0;
        const matches: SearchMatch[] = [];
        for (const doc of candidates) {
          try {
            const content = await ctx.storage.read(doc.doc_path);
            matches.push(...scanDocumentLines(content, regex, contextRadius, doc.doc_path));
          } catch {
            // Skip unreadable files
          }
        }

        const mode = params.mode ?? "content";
        if (matches.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No results found for "${params.query}"` }],
            details: { query: params.query, mode, count: 0, totalMatches: 0 },
          };
        }

        if (mode === "count" || mode === "files") {
          const perPath = new Map<string, number>();
          for (const match of matches) perPath.set(match.path, (perPath.get(match.path) ?? 0) + 1);
          const lines = [...perPath.entries()].sort().map(([path, count]) =>
            mode === "count" ? `${path}: ${count}` : `${path} (${count} match${count === 1 ? "" : "es"})`);
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: { query: params.query, mode, count: matches.length, totalMatches: matches.length, paths: perPath.size },
          };
        }

        const skip = params.cursor ? decodeSearchCursor(params.cursor) : 0;
        const page = matches.slice(skip, skip + SEARCH_PAGE_SIZE);
        const rendered: string[] = [];
        for (const match of page) {
          match.contextBefore.forEach((before, idx) =>
            rendered.push(`${match.path}:${match.line - match.contextBefore.length + idx}- ${before}`));
          rendered.push(`${match.path}:${match.line}: ${match.text}`);
          match.contextAfter.forEach((after, idx) =>
            rendered.push(`${match.path}:${match.line + 1 + idx}- ${after}`));
        }
        const details: Record<string, unknown> = {
          query: params.query,
          mode,
          count: page.length,
          totalMatches: matches.length,
        };
        if (skip + page.length < matches.length) {
          details.nextCursor = encodeSearchCursor(skip + page.length);
          rendered.push(`— showing matches ${skip + 1}-${skip + page.length} of ${matches.length}; pass cursor "${details.nextCursor}" for the next page`);
        } else {
          rendered.push(`— showing matches ${skip + 1}-${matches.length} of ${matches.length}`);
        }
        return {
          content: [{ type: "text" as const, text: rendered.join("\n") }],
          details,
        };
      } catch (err: any) {
        const message = err instanceof SyntaxError ? `Invalid regex: ${params.query}` : `Search error: ${err.message}`;
        return {
          content: [{ type: "text" as const, text: message }],
          details: { query: params.query, error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── list_docs ────────────────────────────────────────────────────

const listDocsParams = Type.Object({
  doc_type: Type.String({ description: "Document type to list: worldview, character, chapter-card, chapter-skeleton, director-script, chapter-text, foreshadow, volume, story-summary, character-state" }),
});

export function createListDocsTool(ctx: ToolContext): AgentTool<typeof listDocsParams> {
  return {
    name: "list_docs",
    label: "List Documents",
    description: "List all documents of a given type from the project index.",
    parameters: listDocsParams,
    execute: async (_, params) => {
      try {
        const docs = await ctx.db.listDocuments(ctx.projectId, params.doc_type);
        const text = docs.length > 0
          ? docs.map(d => `[${d.status}] ${d.doc_path}${d.name ? ` — ${d.name}` : ""}`).join("\n")
          : `No documents found with type "${params.doc_type}"`;
        return {
          content: [{ type: "text" as const, text }],
          details: { doc_type: params.doc_type, count: docs.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `List error: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── Append-note section slicing ──────────────────────────────────

const NOTE_SECTION_HEADING = /^##\s*Ch\.?\s*\d+/;

export function splitAppendSections(content: string): { head: string; sections: string[] } {
  const lines = content.split("\n");
  const firstSection = lines.findIndex((line) => NOTE_SECTION_HEADING.test(line));
  if (firstSection === -1) return { head: content, sections: [] };
  const head = lines.slice(0, firstSection).join("\n");
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines.slice(firstSection)) {
    if (NOTE_SECTION_HEADING.test(line) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return { head, sections };
}

/**
 * Deterministic tail slice for append-only continuity notes:
 * frontmatter/preamble plus the last N `## Ch.N` sections. Content without
 * section structure (legacy rolling summaries) passes through unchanged.
 */
export function tailNoteSections(content: string, maxSections: number): string {
  const { head, sections } = splitAppendSections(content);
  if (sections.length === 0) return content;
  return [head, ...sections.slice(-maxSections)].join("\n").trimEnd() + "\n";
}

/** Current-state slice: frontmatter/preamble plus only the final `## Ch.N` section. */
export function lastNoteSection(content: string): string {
  return tailNoteSections(content, 1);
}

// ─── chapter_context ──────────────────────────────────────────────

const chapterContextParams = Type.Object({
  chapter_num: Type.Number({ description: "Chapter number to assemble context for" }),
});

export function createChapterContextTool(ctx: ToolContext): AgentTool<typeof chapterContextParams> {
  return {
    name: "chapter_context",
    label: "Assemble Chapter Context",
    description: "Assemble full context for writing a chapter: outline card, characters, character live-state, world elements, rolling story summary, previous chapter ending, and director script.",
    parameters: chapterContextParams,
    execute: async (_, params) => {
      try {
        const parts: string[] = [];
        const warnings: string[] = [];
        const isApproved = (doc: any) => doc?.status === "confirmed" || doc?.status === "locked";
        const chooseApproved = (docs: any[], predicate: (doc: any) => boolean) => docs
          .filter((doc) => isApproved(doc) && predicate(doc))
          .sort((a, b) => Number(b.status === "locked") - Number(a.status === "locked"))[0];

        // 1. Find chapter card from outline
        const chapterDocs = await ctx.db.listDocuments(ctx.projectId, "chapter-card");
        const chapterCard = chooseApproved(
          chapterDocs,
          (d: any) => d.chapter_num === params.chapter_num,
        );
        if (chapterCard) {
          const content = await ctx.storage.read(chapterCard.doc_path);
          parts.push(`=== CHAPTER CARD (Chapter ${params.chapter_num}) ===\n${content}`);
        }

        if (!chapterCard) {
          return {
            content: [{ type: "text" as const, text: `No chapter card found for chapter ${params.chapter_num}. The outline must be created first.` }],
            details: { chapter_num: params.chapter_num, error: true },
            isError: true,
          };
        }

        const meta = chapterCard.meta ?? {};
        const charSlugs: string[] = (meta as any).characters ?? [];
        const worldSlugs: string[] = (meta as any).world_elements ?? [];
        const foreshadowIds = [...new Set<string>([
          ...((meta as any).foreshadow_plant ?? []),
          ...((meta as any).foreshadow_resolve ?? []),
        ])];

        // 2. Fetch the explicit source sets. Canonical documents must be confirmed/locked.
        const [characterDocs, charStateResults, worldDocs, prevChapterDocs, scripts] = await Promise.all([
          ctx.db.listDocuments(ctx.projectId, "character"),
          // Read all character live-state files in parallel (script_supervisor maintained)
          Promise.allSettled(
            charSlugs.map(slug => ctx.storage.read(`characters/${slug}-state.md`))
          ),
          // Fetch worldview list once (was inside loop)
          ctx.db.listDocuments(ctx.projectId, "worldview"),
          // Fetch previous chapter text list
          params.chapter_num > 1
            ? ctx.db.listDocuments(ctx.projectId, "chapter-text")
            : Promise.resolve([]),
          // Fetch director scripts
          ctx.db.listDocuments(ctx.projectId, "director-script"),
        ]);

        const charResults = await Promise.allSettled(charSlugs.map((slug) => {
          const doc = chooseApproved(characterDocs, (candidate: any) =>
            candidate.meta?.slug === slug
            || candidate.name === slug
            || candidate.doc_path === `characters/${slug}.md`);
          return doc
            ? ctx.storage.read(doc.doc_path)
            : Promise.reject(new Error("no confirmed character document"));
        }));

        // Process character results
        for (let i = 0; i < charSlugs.length; i++) {
          const result = charResults[i];
          if (result.status === "fulfilled") {
            parts.push(`\n=== CHARACTER: ${charSlugs[i]} ===\n${result.value}`);
          } else {
            parts.push(`\n=== CHARACTER: ${charSlugs[i]} === (file not found)`);
            warnings.push(`Missing confirmed/locked character: ${charSlugs[i]}`);
          }
        }

        // Character live-state (current-state section only — append-only notes)
        for (let i = 0; i < charSlugs.length; i++) {
          const result = charStateResults[i];
          if (result.status === "fulfilled") {
            parts.push(`\n=== CHARACTER STATE: ${charSlugs[i]} ===\n${lastNoteSection(result.value).trimEnd()}`);
          } else {
            warnings.push(`Missing derived character state: ${charSlugs[i]}`);
          }
        }

        // 3. Read referenced world elements (batch after single DB lookup)
        const worldReads: Promise<[string, string | null]>[] = [];
        for (const slug of worldSlugs) {
          const worldDoc = chooseApproved(
            worldDocs,
            (d: any) => d.name === slug || d.doc_path.includes(slug),
          );
          if (worldDoc) {
            worldReads.push(
              ctx.storage.read(worldDoc.doc_path)
                .then(content => [slug, content] as [string, string])
                .catch(() => [slug, null] as [string, null])
            );
          }
        }
        const worldResults = await Promise.allSettled(worldReads);
        for (const result of worldResults) {
          if (result.status === "fulfilled" && result.value[1] !== null) {
            const [slug, content] = result.value;
            parts.push(`\n=== WORLD ELEMENT: ${slug} ===\n${content}`);
          }
        }

        // 3.5. Explicit foreshadow references from the chapter card.
        const foreshadowResults = await Promise.allSettled(
          foreshadowIds.map((id) => ctx.storage.read(`foreshadowing/${id}.md`)),
        );
        for (let i = 0; i < foreshadowIds.length; i++) {
          const result = foreshadowResults[i];
          if (result.status === "fulfilled") {
            parts.push(`\n=== FORESHADOW: ${foreshadowIds[i]} ===\n${result.value}`);
          } else {
            warnings.push(`Missing referenced foreshadow: ${foreshadowIds[i]}`);
          }
        }

        // 4. Previous chapter ending
        if (params.chapter_num > 1) {
          const prevChapter = chooseApproved(
            prevChapterDocs,
            (d: any) => d.chapter_num === params.chapter_num - 1,
          );
          if (prevChapter) {
            try {
              const content = await ctx.storage.read(prevChapter.doc_path);
              const tail = content.length > 2000 ? "...(truncated)\n" + content.slice(-2000) : content;
              parts.push(`\n=== PREVIOUS CHAPTER ENDING ===\n${tail}`);
            } catch { /* skip */ }
          }
        }

        // 4.5. Story-so-far tail (script_supervisor maintained) — last 10 appended sections
        try {
          const content = await ctx.storage.read("summary/story-so-far.md");
          parts.push(`\n=== STORY SO FAR (DERIVED CONTINUITY) ===\n${tailNoteSections(content, 10).trimEnd()}`);
        } catch { warnings.push("Missing derived story summary: summary/story-so-far.md"); }

        // 5. Director script
        const script = chooseApproved(scripts, (d: any) => d.chapter_num === params.chapter_num);
        if (script) {
          try {
            const content = await ctx.storage.read(script.doc_path);
            parts.push(`\n=== DIRECTOR SCRIPT ===\n${content}`);
          } catch { /* skip */ }
        }

        if (warnings.length > 0) {
          parts.push(`\n=== MATERIAL WARNINGS ===\n${warnings.map((warning) => `- ${warning}`).join("\n")}`);
        }

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: { chapter_num: params.chapter_num, sections: parts.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Context assembly error: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── Convenience: create all file tools ───────────────────────────

export function createFileTools(ctx: ToolContext, role: SkillRole = "chief_editor"): AgentTool<any>[] {
  return [
    createReadDocTool(ctx),
    createListSkillsTool(ctx, role),
    createLoadSkillTool(ctx, role),
    createWriteDocTool(ctx, role),
    createDeleteDocTool(ctx),
    createSearchDocsTool(ctx),
    createListDocsTool(ctx),
    createChapterContextTool(ctx),
  ];
}
