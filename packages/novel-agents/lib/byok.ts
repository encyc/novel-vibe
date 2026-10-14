/**
 * BYOK (bring your own key) shared vocabulary: the `byok-<provider>` request
 * namespace, the v1 provider allowlist, and the per-turn key slot shared
 * between the orchestrator, its streamFn wrapper, and compaction billing.
 */
import { isLocalMode } from "./local-mode.js";

export const BYOK_PROVIDER_PREFIX = "byok-";

export const BYOK_ALLOWED_PROVIDERS = [
  "deepseek",
  "openai",
  "anthropic",
  "google",
  "moonshotai",
  "zai",
  "zai-coding-cn",
  "xiaomi",
  "xiaomi-token-plan-cn",
] as const;

export type ByokBaseProvider = (typeof BYOK_ALLOWED_PROVIDERS)[number];

/** Display names for the settings page and model selector groups. */
export const BYOK_PROVIDER_LABELS: Record<ByokBaseProvider, string> = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
  anthropic: "Claude",
  google: "Gemini",
  moonshotai: "Kimi",
  zai: "智谱 GLM Coding（国际）",
  "zai-coding-cn": "智谱 GLM（Coding 计划）",
  xiaomi: "小米 MiMo",
  "xiaomi-token-plan-cn": "小米 MiMo（Token 计划）",
};

export interface ByokTurnState {
  /** Decrypted key for the active turn, or null when the turn is platform-billed. */
  apiKey: string | null;
}

export function isByokProvider(provider: string): boolean {
  return provider.startsWith(BYOK_PROVIDER_PREFIX);
}

/** Returns the allowlisted base provider, or null when unknown/not byok. */
export function splitByokProvider(provider: string): ByokBaseProvider | null {
  if (!provider.startsWith(BYOK_PROVIDER_PREFIX)) return null;
  const base = provider.slice(BYOK_PROVIDER_PREFIX.length);
  return (BYOK_ALLOWED_PROVIDERS as readonly string[]).includes(base)
    ? (base as ByokBaseProvider)
    : null;
}

/**
 * Whether BYOK can be encrypted and decrypted right now.
 *
 * A hosted deployment is fail-closed: without `BYOK_ENCRYPTION_KEY` there is no
 * key source, so BYOK stays disabled. A local install has no operator to set one,
 * so local mode instead derives a per-install secret from a user-owned file
 * (`resolveByokEncryptionSecret` in `lib/crypto.ts`); that file is created on
 * first use, not by this predicate.
 */
export function byokEncryptionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BYOK_ENCRYPTION_KEY?.trim()) return true;
  return isLocalMode(env);
}
