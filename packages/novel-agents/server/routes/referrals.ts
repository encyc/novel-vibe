import { errorResponse, jsonResponse, parseBytes } from "../http.js";
import { createReferralService } from "../runtime.js";
import type { PublicRouteContext, RouteContext } from "../http.js";

export async function referralPreviewGet({ res, path }: PublicRouteContext) {
  const match = path.match(/^\/api\/referrals\/preview\/([^/]+)$/);
  try {
    jsonResponse(res, await createReferralService().preview(decodeURIComponent(match?.[1] ?? "")));
  } catch {
    errorResponse(res, 500, "INTERNAL_ERROR");
  }
}

export async function referralsMeGet({ res, userId }: RouteContext) {
  jsonResponse(res, await createReferralService().dashboard(userId));
}

export async function referralAdminCampaignGet({ res, userId }: RouteContext) {
  const metrics = await createReferralService().adminMetrics(userId);
  jsonResponse(res, { campaign: (metrics as Record<string, unknown>).campaign ?? null });
}

export async function referralAdminMetricsGet({ res, userId }: RouteContext) {
  jsonResponse(res, await createReferralService().adminMetrics(userId));
}

export async function referralAdminCampaignPatch({ req, res, userId }: RouteContext) {
  const body = JSON.parse((await parseBytes(req, 16 * 1024)).toString("utf8"));
  jsonResponse(res, { campaign: await createReferralService().updateCampaign(userId, {
    bindingEndsAt: String(body.bindingEndsAt ?? ""),
    reason: String(body.reason ?? ""),
  }) });
}

export async function referralAdminBindingsGet({ res, userId, url }: RouteContext) {
  const limit = Number(url.searchParams.get("limit") ?? 50);
  jsonResponse(res, { items: await createReferralService().adminBindings(userId, {
    search: url.searchParams.get("search") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: Number.isFinite(limit) ? limit : 50,
  }) });
}

export async function referralAdminReviewPost({ req, res, userId, params }: RouteContext) {
  const body = JSON.parse((await parseBytes(req, 16 * 1024)).toString("utf8"));
  jsonResponse(res, await createReferralService().review(
    userId,
    decodeURIComponent(params[1]),
    params[2] as "approve" | "reject",
    String(body.reason ?? ""),
  ));
}
