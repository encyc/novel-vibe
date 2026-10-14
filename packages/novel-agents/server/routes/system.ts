import {
  getSystemModelHealthService,
  getSystemModelResolver,
} from "../../model-runtime/system-resolver.js";
import { DbClient } from "../../lib/db.js";
import { getAgentResourceService } from "../../lib/agent-resources/runtime.js";
import { jsonResponse } from "../http.js";
import { resolve, dirname } from "node:path";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

import type { PublicRouteContext } from "../http.js";

import { createLogger } from "../../lib/logger.js";
import {
  BYOK_ALLOWED_PROVIDERS,
  BYOK_PROVIDER_LABELS,
  BYOK_PROVIDER_PREFIX,
} from "../../lib/byok.js";
import { isLocalMode } from "../../lib/local-mode.js";

const log = createLogger("server");

/** One entry of the local-mode `/api/models` catalog. */
export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
}

/**
 * The only model catalog a local install can actually use.
 *
 * A local install has no platform credentials and no platform rate table, so the
 * reachable models are exactly those the user's own BYOK key can serve. The
 * catalog therefore comes from the BYOK allowlist and the builtin provider
 * catalogs, emitted in the same `byok-<provider>` namespace that
 * `splitByokProvider` and `ModelResolver` already understand — the same source
 * and shape the settings page shows.
 *
 * It touches no database and no network, so the response is available before any
 * key has been stored; `/api/settings/llm-keys` is where keys are added. Models
 * that need service-level credentials rather than a user key (`google-vertex`)
 * are excluded, mirroring `ByokKeyService.config()`.
 */
export function localByokModelCatalog(): CatalogModel[] {
  return BYOK_ALLOWED_PROVIDERS.flatMap((base) => {
    let models: Array<{ id?: unknown; name?: unknown; api?: unknown }> = [];
    try {
      models = getBuiltinModels(base as never) as unknown as typeof models;
    } catch {
      return [];
    }
    return models
      .filter((model) => model.api !== "google-vertex")
      .map((model) => ({
        id: String(model.id),
        name: String(model.name),
        provider: `${BYOK_PROVIDER_PREFIX}${base}`,
        providerLabel: BYOK_PROVIDER_LABELS[base] ?? base,
      }));
  });
}

export async function healthGet({ req, res, url, path }: PublicRouteContext) {
  const resources = getAgentResourceService().health();
  jsonResponse(res, {
    status: resources.status === "healthy" ? "ok" : "degraded",
    service: "novel-vibe-agent-server",
    resources,
  });
  return;

}

export async function modelsGet({ req, res, url, path }: PublicRouteContext) {
  // Local mode has no platform model catalog to read: every model is billed to
  // the user's own provider key, so the BYOK catalog is the whole list. The
  // hosted path below is left byte-for-byte unchanged.
  if (isLocalMode()) {
    jsonResponse(res, { models: localByokModelCatalog() });
    return;
  }
  try {
    const db = DbClient.forSystem();
    const rates = await db.listCreditRates();
    const exactRates = rates.filter((r: any) => {
        const pattern: string = r.model_pattern ?? "";
        return r.is_active !== false && pattern && !pattern.includes("%") && !pattern.includes("_");
      });
    const resolver = getSystemModelResolver();
    const models = (await Promise.all(exactRates.map(async (r: any) => {
      const provider = r.provider_pattern ?? "";
      try {
        await resolver.resolve(provider, r.model_pattern);
      } catch {
        return null;
      }
      return {
          id: r.model_pattern,
          name: r.name,
          provider,
          input_rate: Math.round(parseFloat(r.input_rate) * 1_000_000 * 100) / 100,
          output_rate: Math.round(parseFloat(r.output_rate) * 1_000_000 * 100) / 100,
        };
    }))).filter((model) => model !== null);
    jsonResponse(res, { models });
  } catch (err) {
    log.error("Failed to fetch models from credit_rates:", err);
    jsonResponse(res, { models: [] });
  }
  return;

}
