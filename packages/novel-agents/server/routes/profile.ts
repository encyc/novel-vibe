import {
  isSupportedLanguage,
  normalizeSupportedLanguage,
  type SupportedLanguage,
} from "../../lib/language.js";
import { ProfileInputError, ProfileService } from "../../billing/profile-service.js";
import { RequestBodyTooLargeError } from "../http.js";
import { apiTokenInfrastructureError } from "../http.js";
import { createApiTokenService } from "../runtime.js";
import { decodeApiTokenId } from "../http.js";
import { errorResponse } from "../http.js";
import { jsonResponse } from "../http.js";
import { parseBody } from "../http.js";
import { parseBytes } from "../http.js";

import { API_SCOPES, expandScopePresets, type ApiScope, type ScopePreset } from "../../auth/scopes.js";
import type { ApiTokenLifetimeDays } from "../../auth/api-token-service.js";

import type { RouteContext } from "../http.js";

export class ApiTokenInputError extends Error {}

/**
 * Validate an API-token creation body.
 *
 * Lives with the profile route rather than in `server/http.ts`. It encodes SaaS
 * token policy (allowed lifetimes, delegable scopes, scope presets); keeping it
 * in the shared HTTP spine made the creation core depend on a SaaS decision, and
 * duplicated rules that already live in `auth/api-token-service.ts`.
 */
export function parseApiTokenCreateInput(value: unknown): {
  name: string;
  lifetimeDays: ApiTokenLifetimeDays;
  scopes: ApiScope[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiTokenInputError("Invalid API token request");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string") throw new ApiTokenInputError("Invalid token name");
  const name = input.name.trim();
  if (!name || name.length > 100) {
    throw new ApiTokenInputError("Token name must be between 1 and 100 characters");
  }
  if (input.lifetimeDays !== 30 && input.lifetimeDays !== 90 && input.lifetimeDays !== 365) {
    throw new ApiTokenInputError("Token lifetime must be 30, 90, or 365 days");
  }
  const hasScopes = input.scopes !== undefined;
  const hasPresets = input.presets !== undefined;
  if (hasScopes === hasPresets) throw new ApiTokenInputError("Provide either scopes or presets");

  let scopes: ApiScope[];
  if (hasScopes) {
    if (!Array.isArray(input.scopes) || !input.scopes.every((scope) => typeof scope === "string" && Object.hasOwn(API_SCOPES, scope))) {
      throw new ApiTokenInputError("Invalid token scopes");
    }
    scopes = input.scopes as ApiScope[];
  } else {
    const validPresets = new Set<ScopePreset>(["read", "write", "agent:run"]);
    if (!Array.isArray(input.presets) || !input.presets.every((preset) => validPresets.has(preset as ScopePreset))) {
      throw new ApiTokenInputError("Invalid token scope presets");
    }
    scopes = expandScopePresets(input.presets as ScopePreset[]);
  }
  if (scopes.length === 0) throw new ApiTokenInputError("At least one scope is required");
  if (scopes.some((scope) => !API_SCOPES[scope].delegable)) {
    throw new ApiTokenInputError("All scopes must be delegable");
  }
  return { name, lifetimeDays: input.lifetimeDays, scopes };
}

export async function profileTokensGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  try {
    jsonResponse(res, { tokens: await createApiTokenService().list(userId) });
  } catch (error) {
    apiTokenInfrastructureError(res, error);
  }
  return;

}

export async function profileTokensPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  let input;
  try {
    input = parseApiTokenCreateInput(JSON.parse((await parseBytes(req, 16 * 1024)).toString("utf8")));
    const created = await createApiTokenService().create({ ownerId: userId, ...input });
    jsonResponse(res, created, 201);
  } catch (error) {
    if (error instanceof ApiTokenInputError || error instanceof SyntaxError) {
      errorResponse(res, 400, "INVALID_API_TOKEN_INPUT", error.message);
      return;
    }
    if (error instanceof ProfileInputError || error instanceof RequestBodyTooLargeError) throw error;
    apiTokenInfrastructureError(res, error);
  }
  return;

}

export async function apiTokenDelete({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const tokenId = decodeApiTokenId(params[1]);
  if (!tokenId) {
    errorResponse(res, 404, "API_TOKEN_NOT_FOUND", "API token not found");
    return;
  }
  let revoked: boolean;
  try {
    revoked = await createApiTokenService().revoke(tokenId, userId);
  } catch (error) {
    apiTokenInfrastructureError(res, error);
    return;
  }
  if (!revoked) {
    errorResponse(res, 404, "API_TOKEN_NOT_FOUND", "API token not found");
    return;
  }
  jsonResponse(res, { ok: true });
  return;

}

export async function profileGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const requestedLocale = normalizeSupportedLanguage(req.headers["x-interface-locale"], "zh-CN");
  jsonResponse(res, await profileService().getProfile(userId, email, requestedLocale));
  return;

}

export async function profilePatch({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const body = JSON.parse(await parseBody(req));
  jsonResponse(res, await profileService().updateProfile(userId, email, {
    displayName: typeof body.displayName === "string" ? body.displayName : undefined,
    locale: body.locale,
  }));
  return;

}

export async function profileAvatarPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const mime = String(req.headers["content-type"] ?? "").split(";", 1)[0];
  const bytes = await parseBytes(req, 2 * 1024 * 1024 + 1);
  jsonResponse(res, await profileService().updateAvatar(userId, email, mime, bytes));
  return;

}
