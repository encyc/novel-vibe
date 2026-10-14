import type { AiModel } from "../types";
import type { ApiRequestContext } from "./context.js";

export const BYOK_PROVIDER_PREFIX = "byok-";

export interface ByokModelInfo { id: string; name: string; contextWindow: number }
export interface ByokProviderConfig { id: string; label: string; models: ByokModelInfo[] }
export interface ByokConfig { enabled: boolean; providers: ByokProviderConfig[] }
export interface UserLlmKey { provider: string; keyLast4: string; updatedAt: string }

export async function getByokConfig(client: ApiRequestContext): Promise<ByokConfig> {
  return client.request("/api/byok/config");
}

export async function listLlmKeys(client: ApiRequestContext): Promise<{ keys: UserLlmKey[] }> {
  return client.request("/api/settings/llm-keys");
}

export function saveLlmKey(client: ApiRequestContext, provider: string, apiKey: string): Promise<{ key: UserLlmKey }> {
  return client.request("/api/settings/llm-keys", { method: "PUT", body: JSON.stringify({ provider, api_key: apiKey }) });
}

export function deleteLlmKey(client: ApiRequestContext, provider: string): Promise<{ revoked: boolean }> {
  return client.request(`/api/settings/llm-keys/${encodeURIComponent(provider)}`, { method: "DELETE" });
}

/**
 * Pure selector: platform models + byok models the member may actually use.
 *
 * Entries the platform list already offers are dropped. In local mode `/api/models`
 * returns the BYOK catalog itself, and a saved key makes this merge build the very
 * same entries again — identical `id`, `provider` and `model` — so without the filter
 * the selector listed every model twice and rendered a duplicate list key. The first
 * occurrence wins, so the platform entry is kept.
 */
export function mergeByokModels(
  platformModels: AiModel[],
  byok: ByokConfig | null,
  keys: Array<{ provider: string }> | null,
  hasByokEntitlement: boolean,
): AiModel[] {
  if (!byok?.enabled || !hasByokEntitlement || !keys?.length) return platformModels;
  const keyed = new Set(keys.map((key) => key.provider));
  const byokModels: AiModel[] = byok.providers
    .filter((provider) => keyed.has(provider.id))
    .flatMap((provider) => provider.models.map((model) => ({
      id: `${BYOK_PROVIDER_PREFIX}${provider.id}:${model.id}`,
      name: model.name,
      provider: `${BYOK_PROVIDER_PREFIX}${provider.id}`,
      providerLabel: provider.label,
      model: model.id,
    })));
  const alreadyOffered = new Set(platformModels.map((model) => model.id));
  return [...platformModels, ...byokModels.filter((model) => !alreadyOffered.has(model.id))];
}
