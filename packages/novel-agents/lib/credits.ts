/**
 * Credit billing client — rate resolution, usage recording, credit deduction.
 */
import type { DbClient } from "./db.js";
import { createLogger } from "./logger.js";
import {
  buildPricingQuote,
  calculateQuotedCharge,
  resolveBaseRate,
  validatePricingConfiguration,
  type CreditRate,
  type CreditRateContextTier,
  type CreditRateTimeWindow,
  type PricingQuote,
} from "./pricing.js";
import type { CompactionUsageRecordParams, Usage, UsageRecordParams } from "./usage-cost-types.js";
import { InsufficientCreditsError } from "./policy-ports.js";

export type { CreditRate, PricingQuote } from "./pricing.js";
export type { CompactionUsageRecordParams, Usage, UsageRecordParams } from "./usage-cost-types.js";
export { InsufficientCreditsError } from "./policy-ports.js";

const log = createLogger("credits");

// ─── Types ─────────────────────────────────────────────────────────

export interface CreditBalance {
  userId: string;
  balance: number;
  totalGranted: number;
  totalConsumed: number;
  level: number;
  multiplier: number;
}

// `Usage`, `UsageRecordParams` and `CompactionUsageRecordParams` are core-owned shapes
// (`usage-cost-types.js`): the creation core describes its compaction and turn billing
// ports with them, so this SaaS module imports and re-exports them rather than defining
// them. See the `export type` block above.

// ─── Rate caching ──────────────────────────────────────────────────

interface PricingSnapshot {
  rates: CreditRate[];
  windows: CreditRateTimeWindow[];
  tiers: CreditRateContextTier[];
}

let cachedPricing: PricingSnapshot | null = null;
let pricingCacheExpiry = 0;
const RATES_CACHE_TTL_MS = 60_000;

function invalidateRatesCache(): void {
  cachedPricing = null;
  pricingCacheExpiry = 0;
}

// ─── CreditBillingClient ──────────────────────────────────────────

// `InsufficientCreditsError` is core-owned (`policy-ports.js`): the chat route both
// throws it and classifies it, so the class must live where the core can reach it
// without importing this SaaS client. Re-exported below to keep every existing
// import site and `instanceof` check working against a single class identity.

export class CreditBillingClient {
  private db: DbClient;

  constructor(db: DbClient) {
    this.db = db;
  }

  async getBalance(userId: string): Promise<CreditBalance | null> {
    const row = await this.db.getCreditBalance(userId);
    if (!row) return null;
    return {
      userId: row.user_id,
      balance: parseFloat(row.balance),
      totalGranted: parseFloat(row.total_granted),
      totalConsumed: parseFloat(row.total_consumed),
      level: row.level,
      multiplier: parseFloat(row.multiplier),
    };
  }

  async ensureBalance(userId: string, initialCredits: number): Promise<CreditBalance> {
    let balance = await this.getBalance(userId);
    if (!balance) {
      await this.db.createCreditBalance(userId, initialCredits);
      balance = await this.getBalance(userId);
    }
    return balance!;
  }

  async topUp(userId: string, amount: number, description?: string, metadata?: Record<string, unknown>, type: "topup" | "grant" = "topup"): Promise<CreditBalance> {
    await this.db.topUpCredits(userId, amount, description, metadata, type);
    await this.db.recalcUserLevel(userId);
    return (await this.getBalance(userId))!;
  }

  async getRates(): Promise<CreditRate[]> {
    return (await this.getPricingSnapshot()).rates;
  }

  private async getPricingSnapshot(): Promise<PricingSnapshot> {
    const now = Date.now();
    if (cachedPricing && now < pricingCacheExpiry) {
      return cachedPricing;
    }
    try {
      const [rateRows, windowRows, tierRows] = await Promise.all([
        this.db.listCreditRates(),
        this.db.listCreditRateTimeWindows(),
        this.db.listCreditRateContextTiers(),
      ]);
      const rates: CreditRate[] = rateRows.map((r: any) => ({
        id: r.id, name: r.name, modelPattern: r.model_pattern,
        providerPattern: r.provider_pattern, inputRate: parseFloat(r.input_rate),
        outputRate: parseFloat(r.output_rate), cacheReadRate: parseFloat(r.cache_read_rate),
        cacheWriteRate: parseFloat(r.cache_write_rate), priority: r.priority,
      }));
      const activeRateIds = new Set(rates.map((rate) => rate.id));
      const semanticWindowKeys = new Set<string>();
      const windows: CreditRateTimeWindow[] = windowRows.map((r: any) => ({
        id: r.id, creditRateId: r.credit_rate_id, label: r.label, timezone: r.timezone,
        startMinute: r.start_minute, endMinute: r.end_minute,
        inputRate: parseFloat(r.input_rate), outputRate: parseFloat(r.output_rate),
        cacheReadRate: parseFloat(r.cache_read_rate), cacheWriteRate: parseFloat(r.cache_write_rate),
        priority: r.priority,
      })).filter((window) => activeRateIds.has(window.creditRateId)).filter((window) => {
        const semanticKey = [
          window.creditRateId, window.timezone, window.startMinute, window.endMinute,
          window.inputRate, window.outputRate, window.cacheReadRate, window.cacheWriteRate,
          window.priority,
        ].join("\u0000");
        if (semanticWindowKeys.has(semanticKey)) return false;
        semanticWindowKeys.add(semanticKey);
        return true;
      });
      const activeWindowIds = new Set(windows.map((window) => window.id));
      const tiers: CreditRateContextTier[] = tierRows.map((r: any) => ({
        id: r.id,
        creditRateId: r.credit_rate_id,
        creditRateTimeWindowId: r.credit_rate_time_window_id,
        label: r.label,
        minContextTokens: Number(r.min_context_tokens),
        maxContextTokens: r.max_context_tokens === null ? null : Number(r.max_context_tokens),
        inputRate: parseFloat(r.input_rate),
        outputRate: parseFloat(r.output_rate),
        cacheReadRate: parseFloat(r.cache_read_rate),
        cacheWriteRate: parseFloat(r.cache_write_rate),
        priority: r.priority,
      })).filter((tier) => activeRateIds.has(tier.creditRateId)
        && (!tier.creditRateTimeWindowId || activeWindowIds.has(tier.creditRateTimeWindowId)));
      validatePricingConfiguration(rates, windows, tiers);
      cachedPricing = { rates, windows, tiers };
      pricingCacheExpiry = now + RATES_CACHE_TTL_MS;
      return cachedPricing;
    } catch (error) {
      if (cachedPricing) {
        log.warn({ event: "pricing_cache_degraded", error: error instanceof Error ? error.message : String(error) });
        return cachedPricing;
      }
      throw error;
    }
  }

  /**
   * A model is "free" when every rate component is zero — calling it costs no
   * credits, so the balance pre-check should exempt it. Rate resolution is
   * best-effort: an unknown model resolves to the default `%` rate (treated as
   * paid) and any lookup failure resolves to `false` (require balance), both of
   * which err on the side of charging.
   */
  async isFreeModel(modelId: string, provider: string): Promise<boolean> {
    try {
      const snapshot = await this.getPricingSnapshot();
      const resolved = this.resolveRate(snapshot.rates, modelId, provider);
      if (!resolved) return false;
      const possibleRates = [
        resolved,
        ...snapshot.windows.filter((window) => window.creditRateId === resolved.id),
        ...snapshot.tiers.filter((tier) => tier.creditRateId === resolved.id),
      ];
      return possibleRates.every((candidate) => [
        candidate.inputRate,
        candidate.outputRate,
        candidate.cacheReadRate,
        candidate.cacheWriteRate,
      ].every((value) => value === 0));
    } catch {
      return false;
    }
  }

  resolveRate(rates: CreditRate[], modelId: string, provider: string): CreditRate {
    return resolveBaseRate(rates, modelId, provider);
  }

  calculateCredits(rate: CreditRate, usage: Usage): number {
    return Math.round(
      ((usage.input / 1000) * rate.inputRate +
      (usage.output / 1000) * rate.outputRate +
      (usage.cacheRead / 1000) * rate.cacheReadRate +
      (usage.cacheWrite / 1000) * rate.cacheWriteRate) * 100,
    ) / 100;
  }

  async recordAndCharge(params: UsageRecordParams): Promise<void> {
    const quote = await this.createPricingQuote({
      userId: params.userId,
      modelId: params.modelId,
      modelProvider: params.modelProvider,
      requestStartedAt: new Date(),
    });
    await this.recordAndChargeQuotedUsage({ ...params, quote });
  }

  async createPricingQuote(params: {
    userId: string;
    modelId: string;
    modelProvider: string;
    requestStartedAt: Date;
  }): Promise<PricingQuote> {
    const snapshot = await this.getPricingSnapshot();
    const rate = resolveBaseRate(snapshot.rates, params.modelId, params.modelProvider);
    const balance = await this.getBalance(params.userId);
    const multiplier = balance?.multiplier ?? 2.0;
    return buildPricingQuote({
      rate,
      windows: snapshot.windows,
      tiers: snapshot.tiers,
      modelId: params.modelId,
      modelProvider: params.modelProvider,
      requestStartedAt: params.requestStartedAt,
      billingMultiplier: multiplier,
    });
  }

  async recordAndChargeQuotedUsage(params: UsageRecordParams & { quote: PricingQuote }): Promise<void> {
    if (params.quote.modelId !== params.modelId || params.quote.modelProvider !== params.modelProvider) {
      throw new Error("Pricing quote does not match completed model call");
    }
    const charge = calculateQuotedCharge(params.quote, params.usage);
    const credits = charge.credits;
    const rateSnapshot = {
      version: 2,
      selected: {
        inputRate: charge.inputRate,
        outputRate: charge.outputRate,
        cacheReadRate: charge.cacheReadRate,
        cacheWriteRate: charge.cacheWriteRate,
        contextTierId: charge.contextTierId,
        contextTierLabel: charge.contextTierLabel,
      },
      quote: params.quote,
    };

    let record;
    try {
      record = await this.db.insertUsageRecord({
        userId: params.userId,
        projectId: params.projectId,
        sessionId: params.sessionId,
        agentId: params.agentId,
        modelId: params.modelId,
        modelProvider: params.modelProvider,
        inputTokens: params.usage.input,
        outputTokens: params.usage.output,
        cacheReadTokens: params.usage.cacheRead,
        cacheWriteTokens: params.usage.cacheWrite,
        totalTokens: params.usage.totalTokens,
        costUsd: params.usage.cost.total,
        creditsConsumed: credits,
        creditRateId: params.quote.creditRateId,
        requestStartedAt: params.quote.requestStartedAt,
        pricingPeriod: params.quote.pricingPeriod,
        creditRateWindowId: params.quote.creditRateWindowId,
        contextTokens: charge.contextTokens,
        creditRateContextTierId: charge.contextTierId,
        rateSnapshot,
        billingMultiplier: params.quote.billingMultiplier,
      });
    } catch (err: any) {
      // If session_id FK fails (session not persisted), retry without it
      if (params.sessionId && err.message?.includes("session_id")) {
        record = await this.db.insertUsageRecord({
          userId: params.userId,
          projectId: params.projectId,
          sessionId: undefined,
          agentId: params.agentId,
          modelId: params.modelId,
          modelProvider: params.modelProvider,
          inputTokens: params.usage.input,
          outputTokens: params.usage.output,
          cacheReadTokens: params.usage.cacheRead,
          cacheWriteTokens: params.usage.cacheWrite,
          totalTokens: params.usage.totalTokens,
          costUsd: params.usage.cost.total,
          creditsConsumed: credits,
          creditRateId: params.quote.creditRateId,
          requestStartedAt: params.quote.requestStartedAt,
          pricingPeriod: params.quote.pricingPeriod,
          creditRateWindowId: params.quote.creditRateWindowId,
          contextTokens: charge.contextTokens,
          creditRateContextTierId: charge.contextTierId,
          rateSnapshot,
          billingMultiplier: params.quote.billingMultiplier,
        });
      } else {
        throw err;
      }
    }

    if (params.userId) {
      const result = await this.db.deductCreditsAtomic(
        params.userId,
        credits,
        "usage_record",
        record.id,
        `${params.agentId}: ${params.modelId} (${params.usage.totalTokens} tokens)`,
      );
      if (!result.success) {
        // The charge was rejected and rolled back by `novel.deduct_credits`.
        // The usage row above is already written, so this is a genuine
        // under-charge (a concurrent turn drained the balance after the
        // pre-flight gate) rather than a user-facing failure.
        log.warn(`Insufficient balance for user ${params.userId}: needed ${credits}, have ${result.new_balance}`);
      }
    }
  }

  /** Records a model call made outside the normal Agent event loop. */
  async recordCompactionUsage(params: CompactionUsageRecordParams & { quote: PricingQuote }): Promise<void> {
    await this.recordAndChargeQuotedUsage({
      ...params,
      agentId: "session_compaction",
    });
  }

  /**
   * BYOK turns are billed by the user's own provider key: record an audit row
   * with zero credits and no deduction. No platform rate lookup applies.
   */
  async recordByokUsage(params: UsageRecordParams): Promise<void> {
    await this.db.insertUsageRecord({
      userId: params.userId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      agentId: params.agentId,
      modelId: params.modelId,
      modelProvider: params.modelProvider,
      inputTokens: params.usage.input,
      outputTokens: params.usage.output,
      cacheReadTokens: params.usage.cacheRead,
      cacheWriteTokens: params.usage.cacheWrite,
      totalTokens: params.usage.totalTokens,
      costUsd: 0,
      creditsConsumed: 0,
      requestStartedAt: new Date().toISOString(),
      rateSnapshot: { version: 2, source: "byok" },
      billingMultiplier: 1,
    });
  }

  async listTransactions(userId: string, limit = 50, offset = 0): Promise<any[]> {
    return this.db.listCreditTransactions(userId, limit, offset);
  }

  async listUsageRecords(userId: string, projectId?: string, limit = 50): Promise<any[]> {
    return this.db.listUsageRecords(userId, projectId, limit);
  }
}

// Exported for testing
export { invalidateRatesCache };
