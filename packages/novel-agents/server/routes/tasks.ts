import { DbClient } from "../../lib/db.js";
import { errorResponse } from "../http.js";
import { jsonResponse } from "../http.js";

import type { RouteContext } from "../http.js";

export async function tasksGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const projectId = url.searchParams.get("project_id");
  if (!projectId) {
    errorResponse(res, 400, "INVALID_TASK_QUERY", "Missing project_id");
    return;
  }
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const db = DbClient.forUser(token);
  const tasks = await db.listTasks(projectId, limit);
  jsonResponse(res, { tasks });
  return;

}
