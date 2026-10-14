import { createProjectService } from "../runtime.js";
import { errorResponse } from "../http.js";
import { jsonResponse } from "../http.js";
import { parseBody } from "../http.js";

import type { RouteContext } from "../http.js";

export async function skillsGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const { listAllSkillsForUI } = await import("../../lib/skills.js");
  const skills = await listAllSkillsForUI(token, userId);
  jsonResponse(res, { skills });
  return;

}

export async function skilldraftsPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const body = JSON.parse(await parseBody(req));
  if ((body.source !== "upload" && body.source !== "paste" && body.source !== "skill_creator" && body.source !== "evolution")
    || !body.slug || !body.content || !Array.isArray(body.roles)) {
    errorResponse(res, 400, "INVALID_SKILL_DRAFT", "Missing or invalid draft fields");
    return;
  }
  const { createSkillReviewService } = await import("../../skills/runtime.js");
  const draft = await createSkillReviewService(token).createDraft(userId, {
    source: body.source,
    slug: body.slug,
    content: body.content,
    roles: body.roles,
    ...(body.filename ? { filename: body.filename } : {}),
    ...(body.session_id ? { sessionId: body.session_id } : {}),
  });
  jsonResponse(res, { draft }, 201);
  return;

}

export async function draftActionAny({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const draftId = params[1];
  const action = params[2];
  const { createSkillReviewService } = await import("../../skills/runtime.js");
  const service = createSkillReviewService(token);
  if (!action && req.method === "GET") {
    jsonResponse(res, { draft: await service.getDraft(userId, draftId) });
    return;
  }
  if (!action && req.method === "DELETE") {
    jsonResponse(res, { draft: await service.cancelDraft(userId, draftId) });
    return;
  }
  if (action === "review" && req.method === "POST") {
    const body = JSON.parse(await parseBody(req));
    if (!Number.isInteger(body.version)) {
      errorResponse(res, 400, "INVALID_DRAFT_VERSION");
      return;
    }
    jsonResponse(res, await service.reviewDraft(userId, draftId, body.version));
    return;
  }
  if (action === "confirm" && req.method === "POST") {
    const body = JSON.parse(await parseBody(req));
    if (!Number.isInteger(body.version) || !body.review_id || !body.candidate_hash || !body.idempotency_key) {
      errorResponse(res, 400, "INVALID_CONFIRMATION");
      return;
    }
    const skill = await service.confirmDraft(userId, draftId, {
      version: body.version,
      reviewId: body.review_id,
      candidateHash: body.candidate_hash,
      idempotencyKey: body.idempotency_key,
    });
    jsonResponse(res, { skill });
    return;
  }

  errorResponse(res, 404, "NOT_FOUND", "Not found");
  return;
}

export async function skillBySlugAny({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const slug = params[1];
  if (req.method === "GET") {
    const { loadSkillForUI } = await import("../../lib/skills.js");
    const skill = await loadSkillForUI(token, slug, userId);
    if (!skill) {
      errorResponse(res, 404, "SKILL_NOT_FOUND", "Skill not found");
      return;
    }
    jsonResponse(res, { skill });
    return;
  }
  if (req.method === "DELETE") {
    const { uninstallSkill } = await import("../../lib/skills.js");
    await uninstallSkill(token, slug, userId);
    jsonResponse(res, { ok: true });
    return;
  }

  errorResponse(res, 404, "NOT_FOUND", "Not found");
  return;
}

export async function skillVersionsGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const slug = params[1];
  const { createSkillReviewService } = await import("../../skills/runtime.js");
  const versions = await createSkillReviewService(token).listVersions(userId, slug);
  jsonResponse(res, { versions });
  return;

}

export async function skillRevertPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const slug = params[1];
  const body = JSON.parse(await parseBody(req));
  if (!Number.isInteger(body.version_number)) {
    errorResponse(res, 400, "INVALID_VERSION", "version_number (integer) is required");
    return;
  }
  const { createSkillReviewService } = await import("../../skills/runtime.js");
  const skill = await createSkillReviewService(token).revertToVersion(userId, slug, body.version_number);
  jsonResponse(res, { skill });
  return;

}

export async function wsSkillsListGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const workspaceId = params[1];
  const { getWorkspaceSkills } = await import("../../lib/skills.js");
  const skills = await getWorkspaceSkills(token, workspaceId, userId);
  jsonResponse(res, { skills });
  return;

}

export async function wsSkillsTogglePut({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const workspaceId = params[1];
  const skillSlug = params[2];
  const body = JSON.parse(await parseBody(req));
  const enabled = body.enabled === true;
  await createProjectService(token).assertProjectWritable(workspaceId);
  const { toggleWorkspaceSkill } = await import("../../lib/skills.js");
  await toggleWorkspaceSkill(token, workspaceId, skillSlug, enabled, userId);
  jsonResponse(res, { ok: true, workspaceId, skillSlug, enabled });
  return;

}
