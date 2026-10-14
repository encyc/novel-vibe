import {
  isSupportedLanguage,
  normalizeSupportedLanguage,
  type SupportedLanguage,
} from "../../lib/language.js";
import { DbClient } from "../../lib/db.js";
import { ProjectDomainError, type ProjectLifecycleStatus } from "../../project/types.js";
import { createProjectService } from "../runtime.js";
import { errorResponse } from "../http.js";
import { jsonResponse } from "../http.js";
import { parseBody } from "../http.js";

import type { RouteContext } from "../http.js";

export async function projectsGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const requestedStatus = url.searchParams.get("status") ?? "active";
  if (!new Set(["active", "archived", "trash"]).has(requestedStatus)) {
    errorResponse(res, 400, "INVALID_PROJECT_INPUT", "Invalid Project status filter");
    return;
  }
  const projects = await createProjectService(token).list({
    lifecycleStatus: requestedStatus as ProjectLifecycleStatus,
  });
  jsonResponse(res, { projects });
  return;

}

export async function projectsPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService, entitlements }: RouteContext) {
  const body = JSON.parse(await parseBody(req));
  if (body.creative_language !== undefined && !isSupportedLanguage(body.creative_language)) {
    errorResponse(res, 400, "INVALID_PROJECT_INPUT", "Unsupported creative language");
    return;
  }
  const db = DbClient.forUser(token);
  // Free-tier cap: non-members are limited to 3 projects.
  if (!(await entitlements().has(userId, "unlimited_projects"))) {
    const owned = await db.countProjectsByOwner(userId);
    if (owned >= 3) {
      errorResponse(res, 403, "PROJECT_LIMIT_REACHED", "非会员最多创建 3 个项目，开通月卡可解锁无限项目数");
      return;
    }
  }
  const project = await db.createProject({
    ownerId: userId,
    title: body.title,
    genre: body.genre,
    synopsis: body.synopsis,
    ...(body.creative_language !== undefined ? { creativeLanguage: body.creative_language } : {}),
  });
  jsonResponse(res, { project });
  return;

}

export async function projectActionPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const projectId = decodeURIComponent(params[1]);
  const command = params[2] as "archive" | "trash" | "restore";
  const project = await createProjectService(token)[command]({ projectId });
  jsonResponse(res, { project });
  return;

}

export async function permanentProjectDelete({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const result = await createProjectService(token).permanentlyDelete({
    projectId: decodeURIComponent(params[1]),
    userId,
  });
  jsonResponse(res, { ...result, status: "pending" }, 202);
  return;

}

export async function projectResourcePatch({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const body = JSON.parse(await parseBody(req));
  const project = await createProjectService(token).update(
    decodeURIComponent(params[1]),
    {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.genre !== undefined ? { genre: body.genre } : {}),
      ...(body.synopsis !== undefined ? { synopsis: body.synopsis } : {}),
      ...(body.writing_stage !== undefined ? { writingStage: body.writing_stage } : {}),
      ...(body.creative_language !== undefined ? { creativeLanguage: body.creative_language } : {}),
    },
  );
  jsonResponse(res, { project });
  return;

}

export async function projectGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const projectId = params[1];
  const project = await createProjectService(token).get(projectId);
  jsonResponse(res, { project });
  return;

}
