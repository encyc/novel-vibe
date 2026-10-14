import { createProjectService } from "../runtime.js";
import { errorResponse } from "../http.js";
import { getSessionRuntime } from "../runtime.js";
import { jsonResponse } from "../http.js";
import { parseBody } from "../http.js";

import type { RouteContext } from "../http.js";

export async function projectSessionsGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const lifecycleStatus = url.searchParams.get("status") ?? "active";
  if (lifecycleStatus !== "active" && lifecycleStatus !== "archived") {
    errorResponse(res, 400, "INVALID_SESSION_FILTER", "Invalid Session status filter");
    return;
  }
  const page = await getSessionRuntime(userId, token).service.listSessions({
    projectId: decodeURIComponent(params[1]),
    userId,
    limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    lifecycleStatus,
  });
  jsonResponse(res, page);
  return;

}

export async function projectSessionsPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await parseBody(req);
  const projectId = decodeURIComponent(params[1]);
  await createProjectService(token).assertProjectWritable(projectId);
  const created = await getSessionRuntime(userId, token).service.createSession({
    projectId,
    userId,
  });
  jsonResponse(res, { session: created }, 201);
  return;

}

export async function sessionMessagesGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const page = await getSessionRuntime(userId, token).service.listMessages({
    sessionId: decodeURIComponent(params[1]),
    userId,
    limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
  });
  jsonResponse(res, page);
  return;

}

export async function sessionInterruptPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await parseBody(req);
  const result = await getSessionRuntime(userId, token).service.interruptSession({
    sessionId: decodeURIComponent(params[1]),
    userId,
  });
  jsonResponse(res, result);
  return;

}

export async function sessionActionPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await parseBody(req);
  const sessionId = decodeURIComponent(params[1]);
  const action = params[2] as "archive" | "restore";
  const session = action === "archive"
    ? await getSessionRuntime(userId, token).service.archiveSession({ sessionId, userId })
    : await getSessionRuntime(userId, token).service.restoreSession({ sessionId, userId });
  jsonResponse(res, { session });
  return;

}

export async function sessionPatch({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const body = JSON.parse(await parseBody(req));
  const sessionId = decodeURIComponent(params[1]);
  const updated = body.action === "open"
    ? await getSessionRuntime(userId, token).service.openSession({ sessionId, userId })
    : await getSessionRuntime(userId, token).service.renameSession({
        sessionId,
        userId,
        title: body.title,
      });
  jsonResponse(res, { session: updated });
  return;

}

export async function sessionDelete({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await parseBody(req);
  await getSessionRuntime(userId, token).service.deleteSession({
    sessionId: decodeURIComponent(params[1]),
    userId,
  });
  jsonResponse(res, { ok: true });
  return;

}

export async function sessionDelegationMessagesGet({ req, res, url, params, userId, token }: RouteContext) {
  const page = await getSessionRuntime(userId, token).service.listDelegationMessages({
    sessionId: decodeURIComponent(params[1]),
    userId,
    callId: decodeURIComponent(params[2]),
    limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
  });
  jsonResponse(res, page);
}
