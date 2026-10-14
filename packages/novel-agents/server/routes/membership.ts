import { jsonResponse } from "../http.js";
import { parseBody } from "../http.js";

import type { RouteContext } from "../http.js";
import { MEMBERSHIP_ENTITLEMENT_CATALOG, PREMIUM_MODEL_PREFIXES } from "../../billing/entitlements.js";

export async function membershipPlansGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  jsonResponse(res, { plans: await membershipService().listPlans() });
  return;

}

export async function membershipEntitlementsGet({ req, res }: RouteContext) {
  jsonResponse(res, { catalog: MEMBERSHIP_ENTITLEMENT_CATALOG, premiumModels: PREMIUM_MODEL_PREFIXES });
  return;

}

export async function membershipStatusGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  jsonResponse(res, await membershipService().getStatus(userId));
  return;

}

export async function membershipPurchasesPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const body = JSON.parse(await parseBody(req));
  jsonResponse(res, await membershipService().createPurchase(userId, String(body.planId ?? "")), 201);
  return;

}

export async function membershipPurchaseGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  jsonResponse(res, await membershipService().getPurchase(userId, decodeURIComponent(params[1])));
  return;

}
