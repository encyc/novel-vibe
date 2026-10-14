/**
 * Status tools: update document status, get project progress.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DocumentStatusChange, ToolContext } from "./file-tools.js";
import { parseChapterTextPath } from "../lib/document-paths.js";

// ─── Status state machine ─────────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft:     ["confirmed"],
  confirmed: ["locked", "draft"],
  locked:    ["draft"],
};

function describeValidTransitions(): string {
  return "draft → confirmed → locked (confirmed may be rejected back to draft; locked may be unlocked to draft)";
}

// ─── update_status ────────────────────────────────────────────────

const updateStatusParams = Type.Object({
  path: Type.String({ description: "Document path" }),
  status: Type.Union([
    Type.Literal("draft"),
    Type.Literal("confirmed"),
    Type.Literal("locked"),
  ], { description: "New status" }),
});

export function createUpdateStatusTool(ctx: ToolContext): AgentTool<typeof updateStatusParams> {
  return {
    name: "update_status",
    label: "Update Document Status",
    description: "Update a document's status (draft → confirmed → locked). Only the Chief Editor should change status based on user approval.",
    parameters: updateStatusParams,
    execute: async (toolCallId, params) => {
      try {
        await ctx.assertProjectWritable();
        // Validate transition: read current status from DB
        const current = await ctx.db.getDocument(ctx.projectId, params.path);
        const currentStatus: string = current?.status ?? "draft";
        const allowed = VALID_TRANSITIONS[currentStatus];
        if (!allowed || !allowed.includes(params.status)) {
          const validList = allowed ? allowed.map(s => `"${s}"`).join(", ") : "none";
          return {
            content: [{ type: "text" as const, text: `Status transition rejected: cannot change from "${currentStatus}" to "${params.status}". Valid transitions from "${currentStatus}": ${validList}. (Allowed chain: ${describeValidTransitions()})` }],
            details: { path: params.path, currentStatus, requested: params.status, error: true },
            isError: true,
          };
        }

        const content = await ctx.storage.read(params.path);
        const updatedContent = content.replace(
          /^status:\s*\w+/m,
          `status: ${params.status}`,
        );
        if (!ctx.userId || !ctx.sessionId || !ctx.turnId) {
          throw new Error("Missing Agent document write provenance");
        }
        const result = await ctx.documentWriter.write({
          projectId: ctx.projectId,
          path: params.path,
          content: updatedContent,
          source: {
            type: "agent",
            userId: ctx.userId,
            agentId: "chief_editor",
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            toolCallId,
          },
        });

        const confirmedChapter = parseChapterTextPath(params.path);
        if (result.changed && ctx.onDocumentStatusChanged && params.status === "confirmed" && confirmedChapter !== null) {
          const event: DocumentStatusChange = {
            path: params.path,
            status: params.status,
            previousStatus: currentStatus,
            chapterNumber: confirmedChapter,
            confirmedHash: result.afterHash,
          };
          try {
            await ctx.onDocumentStatusChanged(event);
          } catch (checkpointError: any) {
            return {
              content: [{ type: "text" as const, text: `Status updated: ${params.path} → ${params.status}; continuity checkpoint failed: ${checkpointError.message}` }],
              details: {
                path: params.path,
                status: params.status,
                changed: result.changed,
                ...(result.changed ? {
                  versionId: result.versionId,
                  versionNo: result.versionNo,
                  addedLines: result.addedLines,
                  deletedLines: result.deletedLines,
                  changedSections: result.changedSections,
                } : {}),
                continuityCheckpointError: checkpointError.message,
              },
            };
          }
        }

        return {
          content: [{ type: "text" as const, text: `Status updated: ${params.path} → ${params.status}` }],
          details: {
            path: params.path,
            status: params.status,
            changed: result.changed,
            ...(result.changed ? {
              versionId: result.versionId,
              versionNo: result.versionNo,
              addedLines: result.addedLines,
              deletedLines: result.deletedLines,
              changedSections: result.changedSections,
              indexed: result.indexed,
            } : {}),
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Status update error: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── get_project_status ───────────────────────────────────────────

const getProjectStatusParams = Type.Object({});

export function createGetProjectStatusTool(ctx: ToolContext): AgentTool<typeof getProjectStatusParams> {
  return {
    name: "get_project_status",
    label: "Get Project Status",
    description: "Get the current project progress: document counts by type and status.",
    parameters: getProjectStatusParams,
    execute: async (_, params) => {
      try {
        const allDocs = await ctx.db.listDocuments(ctx.projectId);

        const byType: Record<string, number> = {};
        const byStatus: Record<string, number> = {};

        for (const doc of allDocs) {
          byType[doc.doc_type] = (byType[doc.doc_type] ?? 0) + 1;
          byStatus[doc.status] = (byStatus[doc.status] ?? 0) + 1;
        }

        const lines = [
          `Project: ${ctx.projectId}`,
          `Total documents: ${allDocs.length}`,
          ``,
          `By type:`,
          ...Object.entries(byType).map(([t, c]) => `  ${t}: ${c}`),
          ``,
          `By status:`,
          ...Object.entries(byStatus).map(([s, c]) => `  ${s}: ${c}`),
        ];

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { total: allDocs.length, byType, byStatus },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Status error: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── Convenience ──────────────────────────────────────────────────

export function createStatusTools(ctx: ToolContext): AgentTool<any>[] {
  return [createUpdateStatusTool(ctx), createGetProjectStatusTool(ctx)];
}
