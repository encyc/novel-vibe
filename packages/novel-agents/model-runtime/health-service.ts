import type { DisableRuntimeModelInput } from "./types.js";
import type { ModelResolver, ResolvedRuntimeModel } from "./model-resolver.js";
import { classifyModelFailure } from "./failure-classifier.js";

export interface RuntimeModelHealthRepository {
  disableRuntimeModel(input: DisableRuntimeModelInput): Promise<boolean>;
}

interface HealthLogger {
  info(message: string, metadata?: unknown): void;
  warn(message: string, metadata?: unknown): void;
}

export class RuntimeModelHealthService {
  private readonly repository: RuntimeModelHealthRepository;
  private readonly resolver: Pick<ModelResolver, "invalidate">;
  private readonly recipient: string | null;
  private readonly logger: HealthLogger;
  private readonly completed = new Set<string>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(options: {
    repository: RuntimeModelHealthRepository;
    resolver: Pick<ModelResolver, "invalidate">;
    recipient?: string | null;
    logger: HealthLogger;
  }) {
    this.repository = options.repository;
    this.resolver = options.resolver;
    this.recipient = options.recipient?.trim() || null;
    this.logger = options.logger;
  }

  async observeFailure(
    resolved: ResolvedRuntimeModel,
    error: unknown,
    requestId?: string,
  ): Promise<void> {
    if (resolved.source !== "opencode-dynamic" || !resolved.runtimeFingerprint) return;
    const classification = classifyModelFailure(error);
    if (!classification.deterministic) return;

    const provider = resolved.model.provider;
    const modelId = resolved.model.id;
    const key = `${provider}\0${modelId}\0${resolved.runtimeFingerprint}`;
    if (this.completed.has(key)) return;
    const running = this.inflight.get(key);
    if (running) return running;

    const operation = this.disable({
      provider,
      modelId,
      runtimeFingerprint: resolved.runtimeFingerprint,
      classification: classification.category,
      errorCode: classification.errorCode ?? (classification.status === null ? null : String(classification.status)),
      errorSummary: classification.summary,
      requestId: requestId ?? null,
      recipient: this.recipient,
    }, key);
    this.inflight.set(key, operation);
    try {
      await operation;
    } finally {
      if (this.inflight.get(key) === operation) this.inflight.delete(key);
    }
  }

  private async disable(input: DisableRuntimeModelInput, key: string): Promise<void> {
    try {
      const transitioned = await this.repository.disableRuntimeModel(input);
      this.completed.add(key);
      if (!transitioned) return;
      this.resolver.invalidate(input.provider, input.modelId, input.runtimeFingerprint);
      this.logger.info("dynamic_model_disabled", {
        provider: input.provider,
        modelId: input.modelId,
        runtimeFingerprint: input.runtimeFingerprint,
        classification: input.classification,
        requestId: input.requestId ?? null,
      });
    } catch (error) {
      this.logger.warn("dynamic_model_disable_failed", {
        provider: input.provider,
        modelId: input.modelId,
        runtimeFingerprint: input.runtimeFingerprint,
        error: error instanceof Error ? error.message.slice(0, 500) : "unknown",
      });
    }
  }
}
