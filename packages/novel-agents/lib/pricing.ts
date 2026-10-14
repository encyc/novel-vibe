/**
 * Pricing engine — rate resolution and quoted-credit calculation.
 *
 * The shared value shapes this module is built on (`RateComponents`, the `PricingQuote`
 * family, `TokenUsageParts`) are owned by the core module `usage-cost-types.js`: the
 * creation core describes its compaction billing port in those terms, so the SaaS side
 * satisfies the core contract instead of defining it. Everything moved there is
 * re-exported below so existing `./pricing.js` imports keep resolving.
 */
import type {
  CreditRateContextTier,
  PricingQuote,
  RateComponents,
  TokenUsageParts,
} from "./usage-cost-types.js";

export type {
  CreditRateContextTier,
  PricingQuote,
  PricingQuoteBase,
  PricingQuoteV1,
  PricingQuoteV2,
  RateComponents,
  TokenUsageParts,
} from "./usage-cost-types.js";

export interface CreditRate extends RateComponents {
  id: string;
  name: string;
  modelPattern: string;
  providerPattern: string | null;
  priority: number;
}

export interface CreditRateTimeWindow extends RateComponents {
  id: string;
  creditRateId: string;
  label: string;
  timezone: "UTC";
  startMinute: number;
  endMinute: number;
  priority: number;
}

export interface QuotedCharge extends RateComponents {
  credits: number;
  contextTokens: number;
  contextTierId: string | null;
  contextTierLabel: string | null;
}

function assertRateComponents(value: RateComponents, source: string): void {
  for (const [name, rate] of Object.entries(value)) {
    if (!name.endsWith("Rate")) continue;
    if (!Number.isFinite(rate) || rate < 0) throw new Error(`Invalid ${source} ${name}`);
  }
}

function likeToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("%", ".*").replaceAll("_", ".")}$`);
}

export function resolveBaseRate(rates: CreditRate[], modelId: string, provider: string): CreditRate {
  const matches = rates
    .filter((rate) => likeToRegex(rate.modelPattern).test(modelId)
      && (!rate.providerPattern || likeToRegex(rate.providerPattern).test(provider)))
    .sort((left, right) => right.priority - left.priority);
  const rate = matches[0] ?? rates.find((candidate) => candidate.modelPattern === "%");
  if (!rate) throw new Error(`No credit rate for ${provider}/${modelId}`);
  return rate;
}

export function resolveTimeWindow(
  windows: CreditRateTimeWindow[],
  requestStartedAt: Date,
): CreditRateTimeWindow | null {
  if (Number.isNaN(requestStartedAt.getTime())) throw new Error("Invalid request start time");
  const minute = requestStartedAt.getUTCHours() * 60 + requestStartedAt.getUTCMinutes();
  const matches = windows
    .filter((window) => window.startMinute <= minute && minute < window.endMinute)
    .sort((left, right) => right.priority - left.priority);
  if (matches.length > 1 && matches[0]!.priority === matches[1]!.priority) {
    throw new Error("Ambiguous pricing windows at the same priority");
  }
  return matches[0] ?? null;
}

export function validatePricingConfiguration(
  rates: CreditRate[],
  windows: CreditRateTimeWindow[],
  tiers: CreditRateContextTier[] = [],
): void {
  const rateIds = new Set(rates.map((rate) => rate.id));
  const windowsById = new Map(windows.map((window) => [window.id, window]));
  for (const rate of rates) assertRateComponents(rate, `rate ${rate.id}`);
  for (const window of windows) {
    assertRateComponents(window, `window ${window.id}`);
    if (window.timezone !== "UTC") throw new Error(`Window ${window.id} must use UTC`);
    if (!Number.isInteger(window.startMinute) || !Number.isInteger(window.endMinute)
      || window.startMinute < 0 || window.endMinute > 1440
      || window.startMinute >= window.endMinute) {
      throw new Error(`Invalid window range ${window.id}`);
    }
    if (!rateIds.has(window.creditRateId)) throw new Error(`Unknown base rate for window ${window.id}`);
  }
  for (let index = 0; index < windows.length; index += 1) {
    const left = windows[index]!;
    for (let other = index + 1; other < windows.length; other += 1) {
      const right = windows[other]!;
      if (left.creditRateId === right.creditRateId && left.priority === right.priority
        && left.startMinute < right.endMinute && right.startMinute < left.endMinute) {
        throw new Error(`Ambiguous pricing windows ${left.id} and ${right.id}`);
      }
    }
  }
  const tierScopes = new Map<string, CreditRateContextTier[]>();
  for (const tier of tiers) {
    assertRateComponents(tier, `context tier ${tier.id}`);
    if (!rateIds.has(tier.creditRateId)) {
      throw new Error(`Unknown base rate for context tier ${tier.id}`);
    }
    if (tier.creditRateTimeWindowId) {
      const window = windowsById.get(tier.creditRateTimeWindowId);
      if (!window) throw new Error(`Unknown time window for context tier ${tier.id}`);
      if (window.creditRateId !== tier.creditRateId) {
        throw new Error(`Mismatched time window for context tier ${tier.id}`);
      }
    }
    if (!Number.isInteger(tier.minContextTokens) || tier.minContextTokens < 0
      || (tier.maxContextTokens !== null
        && (!Number.isInteger(tier.maxContextTokens) || tier.maxContextTokens < tier.minContextTokens))) {
      throw new Error(`Invalid context range for tier ${tier.id}`);
    }
    const scope = `${tier.creditRateId}:${tier.creditRateTimeWindowId ?? "base"}`;
    const scoped = tierScopes.get(scope) ?? [];
    scoped.push(tier);
    tierScopes.set(scope, scoped);
  }
  for (const scoped of tierScopes.values()) {
    scoped.sort((left, right) => left.minContextTokens - right.minContextTokens);
    for (let index = 0; index < scoped.length; index += 1) {
      const tier = scoped[index]!;
      const next = scoped[index + 1];
      if (!next) {
        if (tier.maxContextTokens !== null) {
          throw new Error(`Context tier gap after ${tier.id}: final tier must be unbounded`);
        }
        continue;
      }
      if (tier.maxContextTokens === null || next.minContextTokens <= tier.maxContextTokens) {
        throw new Error(`Overlapping context tiers ${tier.id} and ${next.id}`);
      }
      if (next.minContextTokens !== tier.maxContextTokens + 1) {
        throw new Error(`Context tier gap between ${tier.id} and ${next.id}`);
      }
    }
  }
}

export function buildPricingQuote(params: {
  rate: CreditRate;
  windows: CreditRateTimeWindow[];
  tiers?: CreditRateContextTier[];
  modelId: string;
  modelProvider: string;
  requestStartedAt: Date;
  billingMultiplier: number;
}): PricingQuote {
  if (!Number.isFinite(params.billingMultiplier) || params.billingMultiplier < 0) {
    throw new Error("Invalid billing multiplier");
  }
  const window = resolveTimeWindow(
    params.windows.filter((candidate) => candidate.creditRateId === params.rate.id),
    params.requestStartedAt,
  );
  const applied = window ?? params.rate;
  const selectedWindowId = window?.id ?? null;
  const contextTiers = Object.freeze((params.tiers ?? [])
    .filter((tier) => tier.creditRateId === params.rate.id
      && tier.creditRateTimeWindowId === selectedWindowId)
    .map((tier) => Object.freeze({ ...tier })));
  return Object.freeze({
    version: 2,
    requestStartedAt: params.requestStartedAt.toISOString(),
    modelId: params.modelId,
    modelProvider: params.modelProvider,
    creditRateId: params.rate.id,
    creditRateWindowId: window?.id ?? null,
    pricingPeriod: window?.label ?? "off_peak",
    inputRate: applied.inputRate,
    outputRate: applied.outputRate,
    cacheReadRate: applied.cacheReadRate,
    cacheWriteRate: applied.cacheWriteRate,
    billingMultiplier: params.billingMultiplier,
    contextTiers,
  });
}

function contextTokenCount(usage: TokenUsageParts): number {
  for (const [name, value] of [
    ["input", usage.input],
    ["output", usage.output],
    ["cacheRead", usage.cacheRead],
    ["cacheWrite", usage.cacheWrite],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid usage ${name}`);
  }
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function resolveQuotedComponents(
  quote: PricingQuote,
  contextTokens: number,
): { rates: RateComponents; tier: CreditRateContextTier | null } {
  if (quote.version === 1) return { rates: quote, tier: null };
  const matches = quote.contextTiers
    .filter((tier) => tier.minContextTokens <= contextTokens
      && (tier.maxContextTokens === null || contextTokens <= tier.maxContextTokens))
    .sort((left, right) => right.priority - left.priority);
  if (matches.length > 1 && matches[0]!.priority === matches[1]!.priority) {
    throw new Error("Ambiguous context pricing tiers at the same priority");
  }
  const firstOverride = quote.contextTiers.reduce(
    (minimum, tier) => Math.min(minimum, tier.minContextTokens),
    Number.POSITIVE_INFINITY,
  );
  if (!matches[0] && contextTokens >= firstOverride) {
    throw new Error(`No context pricing tier for ${contextTokens} tokens`);
  }
  return { rates: matches[0] ?? quote, tier: matches[0] ?? null };
}

export function calculateQuotedCharge(quote: PricingQuote, usage: TokenUsageParts): QuotedCharge {
  const contextTokens = contextTokenCount(usage);
  const { rates, tier } = resolveQuotedComponents(quote, contextTokens);
  const base = (usage.input / 1000) * rates.inputRate
    + (usage.output / 1000) * rates.outputRate
    + (usage.cacheRead / 1000) * rates.cacheReadRate
    + (usage.cacheWrite / 1000) * rates.cacheWriteRate;
  return {
    credits: Math.round(base * quote.billingMultiplier * 100) / 100,
    contextTokens,
    contextTierId: tier?.id ?? null,
    contextTierLabel: tier?.label ?? null,
    inputRate: rates.inputRate,
    outputRate: rates.outputRate,
    cacheReadRate: rates.cacheReadRate,
    cacheWriteRate: rates.cacheWriteRate,
  };
}

export function calculateQuotedCredits(quote: PricingQuote, usage: TokenUsageParts): number {
  return calculateQuotedCharge(quote, usage).credits;
}
