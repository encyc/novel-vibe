/**
 * Index tools: sync frontmatter to DB, rebuild full index.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { hashContent } from "../lib/frontmatter.js";
import { prepareIndexedDocument, syncPreparedDocument } from "../lib/document-indexing.js";
import type { ToolContext } from "./file-tools.js";

// ─── sync_index ───────────────────────────────────────────────────

const syncIndexParams = Type.Object({
  path: Type.String({ description: "Document path to sync" }),
});

export function createSyncIndexTool(ctx: ToolContext): AgentTool<typeof syncIndexParams> {
  return {
    name: "sync_index",
    label: "Sync Document Index",
    description: "Parse a document's YAML frontmatter and sync to the database index. Call after creating or modifying any document.",
    parameters: syncIndexParams,
    execute: async (_, params) => {
      try {
        // 1. Read file from storage
        const content = await ctx.storage.read(params.path);
        const prepared = prepareIndexedDocument(params.path, content);
        if (!prepared) {
          return {
            content: [{ type: "text" as const, text: `Error: Document ${params.path} has no 'type' field in frontmatter.` }],
            details: { path: params.path, error: true },
            isError: true,
          };
        }

        await syncPreparedDocument(ctx.db, ctx.projectId, prepared, hashContent(content));

        return {
          content: [{ type: "text" as const, text: `Index synced: ${params.path} [${prepared.docType}] status=${prepared.status ?? "draft"}` }],
          details: { path: params.path, docType: prepared.docType, status: prepared.status },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Sync error for ${params.path}: ${err.message}` }],
          details: { path: params.path, error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── sync_all_indexes ─────────────────────────────────────────────

const syncAllParams = Type.Object({});

export function createSyncAllIndexesTool(ctx: ToolContext): AgentTool<typeof syncAllParams> {
  return {
    name: "sync_all_indexes",
    label: "Rebuild All Indexes",
    description: "Re-parse all documents and rebuild the entire project index. Use for recovery or initial setup.",
    parameters: syncAllParams,
    execute: async (_, params) => {
      try {
        // Get all known documents from DB
        const allDocs = await ctx.db.listDocuments(ctx.projectId);
        let synced = 0;
        let errors = 0;

        for (const doc of allDocs) {
          try {
            const content = await ctx.storage.read(doc.doc_path);
            const prepared = prepareIndexedDocument(doc.doc_path, content);
            if (!prepared) throw new Error(`Document ${doc.doc_path} has no type`);
            await syncPreparedDocument(ctx.db, ctx.projectId, prepared, hashContent(content));
            synced++;
          } catch {
            errors++;
          }
        }

        return {
          content: [{ type: "text" as const, text: `Index rebuild complete: ${synced} synced, ${errors} errors` }],
          details: { synced, errors },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Rebuild error: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── Convenience ──────────────────────────────────────────────────

export function createIndexTools(ctx: ToolContext): AgentTool<any>[] {
  return [createSyncIndexTool(ctx), createSyncAllIndexesTool(ctx)];
}
