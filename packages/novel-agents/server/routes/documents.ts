import { DbClient } from "../../lib/db.js";
import { DocumentConflictError, VersionedDocumentWriter } from "../../document-version/service.js";
import { DocumentVersionRepository } from "../../document-version/repository.js";
import { createContentStore } from "../../lib/content-store-factory.js";
import { parseFrontmatter } from "../../lib/frontmatter.js";
import { prepareIndexedDocument, syncPreparedDocument } from "../../lib/document-indexing.js";
import { createProjectService } from "../runtime.js";
import { documentWrites, documentWriteKey } from "../../lib/document-write-coordinator.js";
import { errorResponse } from "../http.js";
import { jsonResponse } from "../http.js";
import { parseBody } from "../http.js";
import { sha256Content } from "../../lib/storage.js";
import { sliceDiffPage } from "../../document-version/diff.js";
import { validateProjectOwnership } from "../http.js";
import { parseChapterTextPath } from "../../lib/document-paths.js";

import type { RouteContext } from "../http.js";

import { createLogger } from "../../lib/logger.js";

const log = createLogger("server");

export async function docListGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const projectId = params[1];
  const docType = url.searchParams.get("type") ?? undefined;
  const db = DbClient.forUser(token);
  const docs = await db.listDocuments(projectId, docType);
  jsonResponse(res, { documents: docs });
  return;

}

export async function docVersionsGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const projectId = params[1];
  const docPath = decodeURIComponent(params[2]);
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && (!/^\d+$/.test(cursor) || Number(cursor) <= 0)) {
    errorResponse(res, 400, "INVALID_CURSOR", "Invalid version cursor");
    return;
  }
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 20;
  const repository = new DocumentVersionRepository(DbClient.forUser(token));
  jsonResponse(res, await repository.listVersions(projectId, docPath, cursor, limit));
  return;

}

export async function versionDiffGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const versionId = decodeURIComponent(params[1]);
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && (!/^\d+$/.test(cursor) || Number(cursor) < 0)) {
    errorResponse(res, 400, "INVALID_CURSOR", "Invalid diff cursor");
    return;
  }
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 20;
  const repository = new DocumentVersionRepository(DbClient.forUser(token));
  const version = await repository.getVersion(versionId);
  if (!version) {
    errorResponse(res, 404, "DOCUMENT_VERSION_NOT_FOUND", "Document version not found");
    return;
  }
  const diff = await repository.getDiff(versionId);
  if (!diff || diff.status === "unavailable") {
    errorResponse(res, 409, "DOCUMENT_DIFF_UNAVAILABLE", "Document diff is unavailable", {
      versionId,
      repairable: true,
    });
    return;
  }
  jsonResponse(res, sliceDiffPage(diff, cursor, limit));
  return;

}

export async function versionDetailGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const versionId = decodeURIComponent(params[1]);
  const repository = new DocumentVersionRepository(DbClient.forUser(token));
  const version = await repository.getVersion(versionId);
  if (!version) {
    errorResponse(res, 404, "DOCUMENT_VERSION_NOT_FOUND", "Document version not found");
    return;
  }
  jsonResponse(res, version);
  return;

}

export async function docExportGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService, entitlements }: RouteContext) {
  // Membership gate: export requires the "export" feature.
  if (!(await entitlements().has(userId, "export"))) {
    errorResponse(res, 403, "MEMBERSHIP_REQUIRED", "导出是会员功能，开通月卡后可使用");
    return;
  }
  const projectId = params[1];
  const docPath = decodeURIComponent(params[2]);
  const exportFormat = params[3] as "md" | "txt" | "docx";
  try {
    const storage = createContentStore({ mode: "user", token, bucket: "novels", projectId });
    const content = await storage.read(docPath);
    const { exportDocument, contentTypeFor, exportFileName } = await import("../../lib/export.js");
    const { frontmatter } = parseFrontmatter(content);
    const docName = String(frontmatter.name ?? frontmatter.title ?? docPath.split("/").pop()?.replace(/\.md$/, "") ?? "document");
    const buffer = await exportDocument(content, docName, exportFormat);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(exportFormat),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(exportFileName(docPath, exportFormat))}`,
      "Content-Length": String(buffer.byteLength),
    });
    res.end(buffer);
  } catch (err: any) {
    log.error(`Export failed for ${projectId}:${docPath} as ${exportFormat}:`, err);
    errorResponse(res, 500, "INTERNAL_ERROR");
  }
  return;

}

export async function docReadGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const projectId = params[1];
  const docPath = decodeURIComponent(params[2]);
  const storage = createContentStore({ mode: "user", token, bucket: "novels", projectId });
  const content = await storage.read(docPath);

  // ─── Export ──────────────────────────────────────────────
  const exportFormat = url.searchParams.get("export");
  if (exportFormat) {
    const { exportDocument, isExportFormat, contentTypeFor, exportFileName } = await import("../../lib/export.js");
    if (!isExportFormat(exportFormat)) {
      errorResponse(
        res,
        400,
        "UNSUPPORTED_EXPORT_FORMAT",
        `Unsupported export format: ${exportFormat}`,
        { format: exportFormat, supported: ["md", "txt", "docx"] },
      );
      return;
    }
    try {
      const { frontmatter } = parseFrontmatter(content);
      const docName = String(frontmatter.name ?? frontmatter.title ?? docPath.split("/").pop()?.replace(/\.md$/, "") ?? "document");
      const buffer = await exportDocument(content, docName, exportFormat);
      res.writeHead(200, {
        "Content-Type": contentTypeFor(exportFormat),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(exportFileName(docPath, exportFormat))}`,
        "Content-Length": String(buffer.byteLength),
      });
      res.end(buffer);
    } catch (err: any) {
      log.error(`Export failed for ${projectId}:${docPath} as ${exportFormat}:`, err);
      errorResponse(res, 500, "INTERNAL_ERROR");
    }
    return;
  }

  jsonResponse(res, { content, hash: sha256Content(content), path: docPath });
  return;

}

export async function docWritePut({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService, entitlements }: RouteContext) {
  const projectId = params[1];
  const docPath = decodeURIComponent(params[2]);
  const body = JSON.parse(await parseBody(req));
  const content = body.content;
  const baseHash = body.base_hash;

  if (typeof content !== "string" || typeof baseHash !== "string") {
    errorResponse(res, 400, "INVALID_DOCUMENT_INPUT", "Missing content or base_hash");
    return;
  }

  await createProjectService(token).assertProjectWritable(projectId);

  // Validate ownership against the server-derived user id
  const ownershipMismatch = await validateProjectOwnership(token, projectId, userId);
  if (ownershipMismatch) {
    errorResponse(res, 403, "FORBIDDEN", "You do not own this project");
    return;
  }

  const storage = createContentStore({ mode: "user", token, bucket: "novels", projectId });
  const db = DbClient.forUser(token);
  const prepared = prepareIndexedDocument(docPath, content);
  const confirmedChapter = prepared?.docType === "chapter-text" && prepared.status === "confirmed"
    ? parseChapterTextPath(docPath)
    : null;
  const previousDocument = confirmedChapter === null
    ? null
    : await db.getDocument(projectId, docPath);
  const writer = new VersionedDocumentWriter({
    storage,
    repository: new DocumentVersionRepository(db),
    afterHeadWrite: async (input, afterHash) => {
      const indexed = prepared ?? prepareIndexedDocument(input.path, input.content);
      if (!indexed) return false;
      await syncPreparedDocument(db, projectId, indexed, afterHash);
      return true;
    },
  });
  let result;
  try {
    result = await writer.write({
      projectId,
      path: docPath,
      content,
      baseHash,
      source: { type: "user", userId },
    });
  } catch (error) {
    if (error instanceof DocumentConflictError) {
      errorResponse(res, 409, "DOCUMENT_CONFLICT", "Document conflict", {
        content: error.content,
        hash: error.hash,
        path: error.path,
      });
      return;
    }
    throw error;
  }
  if (
    result.changed
    && confirmedChapter !== null
    && previousDocument?.status !== "confirmed"
  ) {
    // Continuity checks on confirmed chapters are a membership entitlement.
    if (await entitlements().has(userId, "continuity")) {
      await db.enqueueContinuityJob({
        projectId,
        chapterNumber: confirmedChapter,
        chapterPath: docPath,
        confirmedHash: result.afterHash,
      });
    }
  }
  jsonResponse(res, {
    ok: true,
    changed: result.changed,
    hash: result.afterHash,
    path: result.path,
    indexed: result.indexed,
    ...(result.changed ? { versionId: result.versionId, versionNo: result.versionNo } : {}),
  });
  return;

}

export async function docDeleteDelete({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const projectId = params[1];
  const docPath = decodeURIComponent(params[2]);

  // Body is optional for DELETE — ownership uses the server-derived user id
  await parseBody(req).catch(() => {});
  await createProjectService(token).assertProjectWritable(projectId);
  const ownershipMismatch = await validateProjectOwnership(token, projectId, userId);
  if (ownershipMismatch) {
    errorResponse(res, 403, "FORBIDDEN", "You do not own this project");
    return;
  }

  await documentWrites.run(documentWriteKey(projectId, docPath), async () => {
  try {
    const storage = createContentStore({ mode: "user", token, bucket: "novels", projectId });

    // Try reading to check if it's a foreshadow (clean up foreshadow_index too)
    let isForeshadow = false;
    let foreshadowId = "";
    try {
      const content = await storage.read(docPath);
      const { frontmatter } = parseFrontmatter(content);
      if ((frontmatter.type ?? frontmatter.doc_type) === "foreshadow") {
        isForeshadow = true;
        foreshadowId = frontmatter.id as string;
      }
    } catch {
      // File doesn't exist or unreadable — still clean up DB
    }

    await storage.delete(docPath);

    const db = DbClient.forUser(token);
    await db.deleteDocument(projectId, docPath);

    if (isForeshadow && foreshadowId) {
      try {
        await db.deleteForeshadow(projectId, foreshadowId);
      } catch {
        // Best-effort
      }
    }

    jsonResponse(res, { ok: true, path: docPath, deleted: true });
  } catch (err: any) {
    log.error(`Delete failed for ${projectId}:${docPath}:`, err);
    errorResponse(res, 500, "INTERNAL_ERROR");
  }
  });
  return;

}
