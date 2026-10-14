import { errorResponse, jsonResponse, parseBody } from "../http.js";
import type { RouteContext } from "../http.js";
import { ByokKeyServiceError } from "../../lib/byok-service.js";

export async function llmKeysGet({ userId, byokService, res }: RouteContext) {
  jsonResponse(res, { keys: await byokService().list(userId) });
}

export async function llmKeysPut({ req, userId, byokService, res }: RouteContext) {
  const body = JSON.parse(await parseBody(req));
  const provider = typeof body.provider === "string" ? body.provider : "";
  const apiKey = typeof body.api_key === "string" ? body.api_key : "";
  if (!provider || !apiKey) {
    errorResponse(res, 400, "INVALID_KEY_INPUT", "provider and api_key are required");
    return;
  }
  try {
    jsonResponse(res, { key: await byokService().save(userId, provider, apiKey) });
  } catch (err) {
    if (err instanceof ByokKeyServiceError) {
      errorResponse(res, err.status, "BYOK_KEY_REJECTED", err.message);
      return;
    }
    throw err;
  }
}

export async function llmKeyDelete({ params, userId, byokService, res }: RouteContext) {
  jsonResponse(res, await byokService().revoke(userId, decodeURIComponent(params[1])));
}
