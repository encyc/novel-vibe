/**
 * Chapter draft variant branching — verifier-stack spec Phase 3.
 *
 * Variants are ordinary documents at sibling paths (`text/ch-003.b.md`) that
 * stay `draft`, so chapter_context's approved-only selection ignores them.
 * Promotion reuses the versioned write path onto the canonical file and
 * archives the variant (object + index row), giving branch/merge semantics
 * without touching document-version internals.
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { parseFrontmatter } from "../lib/frontmatter.js";
import type { ToolContext } from "./file-tools.js";

export const VARIANT_PATH_PATTERN = /^text\/ch-\d{3}\.[a-z]\.md$/;

const promoteParams = Type.Object({
  variant_path: Type.String({ description: "Variant draft path to promote, e.g. 'text/ch-003.b.md'" }),
});

export function canonicalChapterPathFor(variantPath: string): string | null {
  const match = variantPath.match(/^text\/(ch-\d{3})\.[a-z]\.md$/);
  return match ? `text/${match[1]}.md` : null;
}

export function createPromoteVariantTool(ctx: ToolContext): AgentTool<typeof promoteParams> {
  return {
    name: "promote_variant",
    label: "Promote Variant",
    description:
      "Promote a chapter variant draft (text/ch-NNN.x.md) onto its canonical path (text/ch-NNN.md), preserving full version history, then archive the variant file. Use after comparing draft variants to elect the winning cut.",
    parameters: promoteParams,
    execute: async (toolCallId, params) => {
      try {
        await ctx.assertProjectWritable();
        if (!VARIANT_PATH_PATTERN.test(params.variant_path)) {
          throw new Error(`Not a valid variant path: ${params.variant_path} (expected text/ch-NNN.<letter>.md)`);
        }
        const canonicalPath = canonicalChapterPathFor(params.variant_path);
        if (!canonicalPath) throw new Error("Cannot resolve canonical path");

        if (!ctx.userId || !ctx.sessionId || !ctx.turnId) {
          throw new Error("Missing Agent document write provenance");
        }

        // Versioned write keeps canonical history intact; content copies verbatim —
        // status stays whatever the variant declared, and the Chief Editor still owns
        // any later draft→confirmed change through the normal approval flow.
        const variantContent = await ctx.storage.read(params.variant_path);
        const { frontmatter } = parseFrontmatter(variantContent);
        if ((frontmatter.type ?? frontmatter.doc_type) !== "chapter-text") {
          throw new Error(`Variant must be a chapter-text document: ${params.variant_path}`);
        }
        const expectedChapter = Number(canonicalPath.match(/ch-(\d{3})\.md$/)![1]);
        if (frontmatter.chapter !== expectedChapter) {
          throw new Error(
            `Variant chapter mismatch: path ${params.variant_path} expects chapter ${expectedChapter}`
              + ` but frontmatter declares ${String(frontmatter.chapter)}. Refusing to promote mislabeled drafts.`,
          );
        }

        const result = await ctx.documentWriter.write({
          projectId: ctx.projectId,
          path: canonicalPath,
          content: variantContent,
          source: {
            type: "agent",
            userId: ctx.userId,
            agentId: "chief_editor",
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            toolCallId,
          },
        });

        // Promotion already succeeded at this point; a cleanup failure must
        // not be reported as a failed promote (it would mask the live write).
        let cleanupError: string | null = null;
        try {
          await ctx.storage.delete(params.variant_path);
          await ctx.db.deleteDocument(ctx.projectId, params.variant_path);
        } catch (cleanupErr: any) {
          cleanupError = cleanupErr.message;
        }
        const cleanupNote = cleanupError
          ? `（注意：变体清理失败，${params.variant_path} 仍残留：${cleanupError}。晋升本身已生效，请手动删除残留变体。）`
          : "";

        return {
          content: [{
            type: "text" as const,
            text: result.changed
              ? `已将 ${params.variant_path} 晋升为 ${canonicalPath}（版本 ${result.versionNo}），变体文件已归档。正文当前仍为 draft 状态，确认请走正常审批。${cleanupNote}`
              : `${params.variant_path} 与 ${canonicalPath} 内容一致，无需晋升；变体文件已清理。${cleanupNote}`,
          }],
          details: {
            variantPath: params.variant_path,
            canonicalPath,
            changed: result.changed,
            versionNo: result.changed ? result.versionNo : null,
            ...(cleanupError ? { cleanupError } : {}),
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Promote failed: ${err.message}` }],
          details: { variantPath: params.variant_path, error: true },
          isError: true,
        };
      }
    },
  };
}
