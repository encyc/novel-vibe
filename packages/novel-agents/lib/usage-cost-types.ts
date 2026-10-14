/**
 * Core-owned value shapes for model usage and pricing quotes.
 *
 * The creation core (context, session) describes its compaction summary and billing
 * ports in terms of "how many tokens a model call used" and "what a call was quoted
 * at". Those shapes therefore belong to the core: the core defines the contract, and
 * the hosted SaaS billing implementation (`lib/credits.ts`, `lib/pricing.ts`)
 * satisfies it. The SaaS modules re-export every type below, so existing imports from
 * `./pricing.js` / `./credits.js` keep resolving.
 *
 * Types only — no billing logic, no runtime values, and no SaaS imports.
 */

/** Per-1k-token rate components shared by rates, time windows, context tiers and quotes. */
export interface RateComponents {
  inputRate: number;
  outputRate: number;
  cacheReadRate: number;
  cacheWriteRate: number;
}

/**
 * Context-length pricing tier carried by a version 2 quote. Selected by the billing
 * implementation when a request's context size falls inside the tier's token range.
 */
export interface CreditRateContextTier extends RateComponents {
  id: string;
  creditRateId: string;
  creditRateTimeWindowId: string | null;
  label: string;
  minContextTokens: number;
  maxContextTokens: number | null;
  priority: number;
}

/** Fields shared by every pricing-quote version. */
export interface PricingQuoteBase extends RateComponents {
  requestStartedAt: string;
  modelId: string;
  modelProvider: string;
  creditRateId: string;
  creditRateWindowId: string | null;
  pricingPeriod: string;
  billingMultiplier: number;
}

/** Version 1 quote: a single flat rate for the whole call. */
export interface PricingQuoteV1 extends PricingQuoteBase {
  version: 1;
}

/** Version 2 quote: a flat rate plus optional context-length tiers. */
export interface PricingQuoteV2 extends PricingQuoteBase {
  version: 2;
  contextTiers: readonly CreditRateContextTier[];
}

export type PricingQuote = PricingQuoteV1 | PricingQuoteV2;

/** Raw token counts of a single model call, before costing. */
export interface TokenUsageParts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Token usage and USD cost of one model call, as reported by the model runtime. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/**
 * One billable model call, as handed to the billing implementation.
 *
 * Core-owned because the `TurnUsageBilling` port in `./policy-ports.js` is described
 * in terms of it: the core decides *what* to record, the SaaS client decides *how*
 * to price and charge it.
 */
export interface UsageRecordParams {
  userId: string;
  projectId: string;
  sessionId?: string;
  agentId: string;
  modelId: string;
  modelProvider: string;
  usage: Usage;
}

/** Compaction summaries are attributed to no single agent. */
export type CompactionUsageRecordParams = Omit<UsageRecordParams, "agentId">;
