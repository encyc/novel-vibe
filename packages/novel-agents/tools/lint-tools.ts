/**
 * Read-only quality-check tool. Advisory in Phase 1: findings inform the
 * agent's next iteration but never block writes (verifier-stack ADR-6).
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { formatLintReport, runProseLint, countFindings } from "../lint/index.js";
import type { ToolContext } from "./file-tools.js";

const lintDocParams = Type.Object({
  path: Type.String({ description: "Document path relative to project root, e.g. 'text/ch-003.md'" }),
});

export function createLintDocTool(ctx: ToolContext): AgentTool<typeof lintDocParams> {
  return {
    name: "lint_doc",
    label: "Lint Document",
    description:
      "Run deterministic quality checks on a stored Markdown document without modifying it: frontmatter schema validity, word-count honesty, AI-cliché phrases, repeated passages, and POV consistency. Run this on your draft before finishing the task, fix errors and consider warnings.",
    parameters: lintDocParams,
    execute: async (_, params) => {
      try {
        const content = await ctx.storage.read(params.path);
        const report = runProseLint(params.path, content);
        const { errors, warnings } = countFindings(report);
        return {
          content: [{ type: "text" as const, text: formatLintReport(report) }],
          details: { path: params.path, docType: report.docType, errors, warnings },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error linting ${params.path}: ${err.message}` }],
          details: { path: params.path, error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── notes_health ─────────────────────────────────────────────────

const NOTE_SECTION = /^##\s*Ch\.?\s*(\d+)/;
const APPROVED_STATUSES = new Set(["confirmed", "locked"]);

interface NotesIssue {
  check: "coverage" | "sections" | "orphans" | "staleness";
  message: string;
}

function noteSectionNumbers(content: string): Set<number> {
  const numbers = new Set<number>();
  for (const line of content.split("\n")) {
    const match = NOTE_SECTION.exec(line);
    if (match) numbers.add(Number(match[1]));
  }
  return numbers;
}

const notesHealthParams = Type.Object({});

export function createNotesHealthTool(ctx: ToolContext): AgentTool<typeof notesHealthParams> {
  return {
    name: "notes_health",
    label: "Continuity Notes Health",
    description: "Deterministic advisory check of the supervisor-maintained continuity notes (story-so-far, character states) against confirmed canon: coverage gaps, missing per-chapter sections, orphan state files, and chapters re-confirmed after the notes were last updated. Read-only; run this before trusting continuity notes.",
    parameters: notesHealthParams,
    execute: async () => {
      try {
        const [chapterDocs, summaryDocs, stateDocs, characterDocs] = await Promise.all([
          ctx.db.listDocuments(ctx.projectId, "chapter-text"),
          ctx.db.listDocuments(ctx.projectId, "story-summary"),
          ctx.db.listDocuments(ctx.projectId, "character-state"),
          ctx.db.listDocuments(ctx.projectId, "character"),
        ]);

        const confirmed = (chapterDocs as any[])
          .filter((d) => APPROVED_STATUSES.has(d.status) && typeof d.chapter_num === "number");
        const maxConfirmed = confirmed.reduce((max, d) => Math.max(max, d.chapter_num), 0);
        const issues: NotesIssue[] = [];

        const summary = (summaryDocs as any[]).find((d) => d.doc_path === "summary/story-so-far.md");
        if (!summary) {
          issues.push({ check: "coverage", message: `缺文件: summary/story-so-far.md 不存在——尚无连续性笔记（正典已确认到第 ${maxConfirmed} 章）` });
        } else {
          const latest = summary.meta?.latest_chapter;
          if (typeof latest === "number" && latest < maxConfirmed) {
            issues.push({ check: "coverage", message: `覆盖缺口: story-so-far latest_chapter=${latest}，正典已确认到第 ${maxConfirmed} 章` });
          }

          try {
            const content = await ctx.storage.read("summary/story-so-far.md");
            const sections = noteSectionNumbers(content);
            if (sections.size > 0) {
              const missing = confirmed
                .map((d) => d.chapter_num as number)
                .filter((n) => !sections.has(n))
                .sort((a, b) => a - b);
              if (missing.length > 0) {
                issues.push({ check: "sections", message: `缺章节: 第 ${missing.join(", ")} 章没有对应的 ## Ch.N 节（缺 ${missing.map((n) => `Ch.${n}`).join("、")}）` });
              }
            }
          } catch {
            issues.push({ check: "coverage", message: "不可读: summary/story-so-far.md 在索引中存在但存储读取失败" });
          }

          if (typeof summary.updated_at === "string") {
            const reconfirmed = confirmed
              .filter((d) => typeof d.updated_at === "string"
                && d.updated_at > summary.updated_at
                && (typeof latest !== "number" || d.chapter_num <= latest))
              .map((d) => d.chapter_num as number)
              .sort((a, b) => a - b);
            if (reconfirmed.length > 0) {
              issues.push({ check: "staleness", message: `可能过期: 第 ${reconfirmed.join(", ")} 章在本笔记最后更新后被重新确认，相关节需复核` });
            }
          }
        }

        for (const state of stateDocs as any[]) {
          const slug: string | undefined = state.meta?.character
            ?? /^characters\/(.+)-state\.md$/.exec(state.doc_path ?? "")?.[1];
          if (!slug) continue;
          const hasProfile = (characterDocs as any[]).some((c) =>
            c.meta?.slug === slug || c.doc_path === `characters/${slug}.md`);
          if (!hasProfile) {
            issues.push({ check: "orphans", message: `孤儿状态文件: characters/${slug}-state.md 没有对应的正典角色档案` });
          }
        }

        const healthy = issues.length === 0;
        const text = healthy
          ? `Notes healthy: story-so-far 覆盖到第 ${maxConfirmed} 章，无缺口、无孤儿、无过期复核项。`
          : `Notes issues (${issues.length}):\n${issues.map((issue) => `- [${issue.check}] ${issue.message}`).join("\n")}\n（advisory：不拦截任何操作；需要时用 search_docs 在正典原文中自证）`;
        return {
          content: [{ type: "text" as const, text }],
          details: { healthy, issueCount: issues.length, maxConfirmedChapter: maxConfirmed },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Notes health check error: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}
