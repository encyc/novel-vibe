import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { splitByokProvider } from "../lib/byok.js";
import type { RuntimeModelApi, RuntimeModelRow } from "./types.js";

const DYNAMIC_APIS = new Set<RuntimeModelApi>([
  "anthropic-messages",
  "google-generative-ai",
  "openai-responses",
  "openai-completions",
]);

export interface RuntimeModelRepository {
  getRuntimeModel(provider: string, modelId: string): Promise<RuntimeModelRow | null>;
}

export interface ResolvedRuntimeModel {
  model: Model<Api>;
  source: "pi-ai" | "opencode-dynamic";
  runtimeCatalogId?: string;
  runtimeFingerprint?: string;
}

export type ModelResolutionErrorCode =
  | "model_not_found"
  | "dynamic_disabled"
  | "runtime_unavailable"
  | "invalid_runtime";

export class ModelResolutionError extends Error {
  constructor(
    public readonly code: ModelResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

interface CacheEntry {
  value?: ResolvedRuntimeModel;
  error?: ModelResolutionError;
  expiresAt: number;
}

export function isOpenCodeDynamicModelsEnabled(
  env: { OPENCODE_DYNAMIC_MODELS_ENABLED?: string } = process.env,
): boolean {
  return env.OPENCODE_DYNAMIC_MODELS_ENABLED === "true";
}

function defaultBuiltinLookup(provider: string, modelId: string): Model<Api> | undefined {
  return (getBuiltinModel as (provider: string, modelId: string) => Model<Api> | undefined)(provider, modelId);
}

export class ModelResolver {
  private readonly repository: RuntimeModelRepository;
  private readonly dynamicEnabled: boolean;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly builtinLookup: (provider: string, modelId: string) => Model<Api> | undefined;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ResolvedRuntimeModel>>();

  constructor(options: {
    repository: RuntimeModelRepository;
    dynamicEnabled: boolean;
    ttlMs?: number;
    now?: () => number;
    builtinLookup?: (provider: string, modelId: string) => Model<Api> | undefined;
  }) {
    this.repository = options.repository;
    this.dynamicEnabled = options.dynamicEnabled;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.builtinLookup = options.builtinLookup ?? defaultBuiltinLookup;
  }

  invalidate(provider: string, modelId: string, runtimeFingerprint?: string): void {
    const key = `${provider}\0${modelId}`;
    const cached = this.cache.get(key);
    if (!cached) return;
    if (runtimeFingerprint && cached.value?.runtimeFingerprint !== runtimeFingerprint) return;
    this.cache.delete(key);
  }

  async resolve(provider: string, modelId: string): Promise<ResolvedRuntimeModel> {
    // byok-<base> shares the builtin catalog of its base provider; the key is
    // injected per-request at the streamFn layer, never here.
    const byokBase = splitByokProvider(provider);
    const builtin = this.builtinLookup(byokBase ?? provider, modelId);
    if (builtin) return { model: builtin, source: "pi-ai" };

    if (provider !== "opencode") {
      throw new ModelResolutionError("model_not_found", `Model not found: ${provider}/${modelId}`);
    }
    if (!this.dynamicEnabled) {
      throw new ModelResolutionError(
        "dynamic_disabled",
        `Dynamic OpenCode models are disabled: ${modelId}`,
      );
    }

    const key = `${provider}\0${modelId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return this.fromCache(cached);

    const running = this.inflight.get(key);
    if (running) return running;

    const refresh = this.refresh(provider, modelId, key, cached);
    this.inflight.set(key, refresh);
    try {
      return await refresh;
    } finally {
      if (this.inflight.get(key) === refresh) this.inflight.delete(key);
    }
  }

  private fromCache(entry: CacheEntry): ResolvedRuntimeModel {
    if (entry.value) return entry.value;
    throw entry.error ?? new ModelResolutionError("model_not_found", "Model not found");
  }

  private async refresh(
    provider: string,
    modelId: string,
    key: string,
    stale: CacheEntry | undefined,
  ): Promise<ResolvedRuntimeModel> {
    try {
      const row = await this.repository.getRuntimeModel(provider, modelId);
      if (!row) {
        const error = new ModelResolutionError("model_not_found", `Model not found: ${provider}/${modelId}`);
        this.cache.set(key, { error, expiresAt: this.now() + this.ttlMs });
        throw error;
      }
      const value = this.fromRuntimeRow(provider, modelId, row);
      this.cache.set(key, { value, expiresAt: this.now() + this.ttlMs });
      return value;
    } catch (error) {
      if (!(error instanceof ModelResolutionError) && stale?.value) return stale.value;
      if (error instanceof ModelResolutionError && !this.cache.has(key)) {
        this.cache.set(key, { error, expiresAt: this.now() + this.ttlMs });
      }
      throw error;
    }
  }

  private fromRuntimeRow(
    provider: string,
    modelId: string,
    row: RuntimeModelRow,
  ): ResolvedRuntimeModel {
    if (row.status !== "active") {
      throw new ModelResolutionError(
        "runtime_unavailable",
        `Dynamic model runtime is ${row.status}: ${provider}/${modelId}`,
      );
    }
    const valid = row.provider === provider
      && row.modelId === modelId
      && row.source === "opencode-dynamic"
      && row.baseUrl === "https://opencode.ai/zen/v1"
      && DYNAMIC_APIS.has(row.api)
      && Number.isInteger(row.contextWindow)
      && row.contextWindow > 0
      && Number.isInteger(row.maxTokens)
      && row.maxTokens > 0
      && row.reasoning === false
      && row.inputModalities.length === 1
      && row.inputModalities[0] === "text"
      && row.id.length > 0
      && row.name.trim().length > 0
      && row.runtimeFingerprint.trim().length > 0;
    if (!valid) {
      throw new ModelResolutionError(
        "invalid_runtime",
        `Invalid dynamic model runtime metadata: ${provider}/${modelId}`,
      );
    }

    const model: Model<Api> = {
      id: row.modelId,
      name: row.name,
      api: row.api,
      provider: row.provider,
      baseUrl: row.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: row.contextWindow,
      maxTokens: row.maxTokens,
    };
    return {
      model,
      source: "opencode-dynamic",
      runtimeCatalogId: row.id,
      runtimeFingerprint: row.runtimeFingerprint,
    };
  }
}
