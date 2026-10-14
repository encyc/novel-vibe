import { describe, expect, it } from "vitest";
import {
  buildPricingQuote,
  calculateQuotedCharge,
  calculateQuotedCredits,
  resolveBaseRate,
  resolveTimeWindow,
  validatePricingConfiguration,
  type CreditRate,
  type CreditRateContextTier,
  type CreditRateTimeWindow,
  type PricingQuoteV1,
} from "./pricing.js";

const base: CreditRate = {
  id: "pro", name: "DeepSeek V4 Pro", modelPattern: "deepseek-v4-pro",
  providerPattern: "opencode", inputRate: 0.0462, outputRate: 0.1386,
  cacheReadRate: 0.00154, cacheWriteRate: 0, priority: 10,
};

const contextTier = (
  id: string,
  minContextTokens: number,
  maxContextTokens: number | null,
  creditRateTimeWindowId: string | null = null,
  priority = 100,
): CreditRateContextTier => ({
  id,
  creditRateId: "pro",
  creditRateTimeWindowId,
  label: minContextTokens === 272_001 ? "over_272k" : "high_context",
  minContextTokens,
  maxContextTokens,
  inputRate: 0.7,
  outputRate: 3.15,
  cacheReadRate: 0.07,
  cacheWriteRate: 0,
  priority,
});

const peak = (id: string, startMinute: number, endMinute: number, priority = 100): CreditRateTimeWindow => ({
  id, creditRateId: "pro", label: "peak", timezone: "UTC",
  startMinute, endMinute, inputRate: 0.0924, outputRate: 0.2772,
  cacheReadRate: 0.00308, cacheWriteRate: 0, priority,
});

describe("peak pricing resolver", () => {
  const windows = [peak("first", 60, 240), peak("second", 360, 600)];

  it.each([
    ["2026-08-17T00:59:59Z", null], ["2026-08-17T01:00:00Z", "first"],
    ["2026-08-17T03:59:59Z", "first"], ["2026-08-17T04:00:00Z", null],
    ["2026-08-17T05:59:59Z", null], ["2026-08-17T06:00:00Z", "second"],
    ["2026-08-17T09:59:59Z", "second"], ["2026-08-17T10:00:00Z", null],
  ])("resolves half-open UTC boundary %s", (timestamp, expected) => {
    expect(resolveTimeWindow(windows, new Date(timestamp))?.id ?? null).toBe(expected);
  });

  it("uses priority and rejects ambiguous top-priority overlaps", () => {
    expect(resolveTimeWindow([peak("low", 60, 240, 1), peak("high", 60, 240, 2)], new Date("2026-08-17T02:00:00Z"))?.id).toBe("high");
    expect(() => resolveTimeWindow([peak("a", 60, 240), peak("b", 120, 180)], new Date("2026-08-17T02:30:00Z"))).toThrow("Ambiguous pricing windows");
  });

  it("matches SQL LIKE patterns without treating model punctuation as regex", () => {
    const fallback = { ...base, id: "fallback", modelPattern: "%", providerPattern: null, priority: 0 };
    const dotted = { ...base, id: "dot", modelPattern: "model.v1", providerPattern: "open_code", priority: 20 };
    expect(resolveBaseRate([fallback, dotted], "model.v1", "openXcode").id).toBe("dot");
    expect(resolveBaseRate([fallback, dotted], "modelXv1", "openXcode").id).toBe("fallback");
  });

  it("builds an immutable quote and calculates using the locked multiplier", () => {
    const quote = buildPricingQuote({
      rate: base, windows, modelId: "deepseek-v4-pro", modelProvider: "opencode",
      requestStartedAt: new Date("2026-08-17T03:59:59Z"), billingMultiplier: 2,
    });
    expect(quote).toMatchObject({ pricingPeriod: "peak", creditRateWindowId: "first", inputRate: 0.0924 });
    expect(Object.isFrozen(quote)).toBe(true);
    expect(calculateQuotedCredits(quote, { input: 1000, output: 500, cacheRead: 100, cacheWrite: 0 })).toBe(0.46);
  });

  it("validates rate values, window bounds, UTC, and parent ids", () => {
    expect(() => validatePricingConfiguration([base], [{ ...peak("bad", 60, 60) }])).toThrow();
    expect(() => validatePricingConfiguration([base], [{ ...peak("bad", 60, 240), timezone: "Asia/Shanghai" as "UTC" }])).toThrow();
    expect(() => validatePricingConfiguration([base], [{ ...peak("bad", 60, 240), creditRateId: "missing" }])).toThrow();
    expect(() => validatePricingConfiguration([{ ...base, inputRate: -1 }], [])).toThrow();
    expect(() => validatePricingConfiguration([base], [peak("a", 60, 240), peak("b", 120, 180)])).toThrow("Ambiguous");
  });
});

describe("context-tier pricing resolver", () => {
  const high = contextTier("tier-high", 272_001, null);

  it("uses the low rate through 272K and the high tier from 272001", () => {
    const quote = buildPricingQuote({
      rate: base,
      windows: [],
      tiers: [high],
      modelId: "deepseek-v4-pro",
      modelProvider: "opencode",
      requestStartedAt: new Date("2026-08-17T12:00:00Z"),
      billingMultiplier: 2,
    });

    const low = calculateQuotedCharge(quote, {
      input: 272_000, output: 100, cacheRead: 0, cacheWrite: 0,
    });
    expect(low.contextTokens).toBe(272_000);
    expect(low.contextTierId).toBeNull();
    expect(low.inputRate).toBe(base.inputRate);

    const tiered = calculateQuotedCharge(quote, {
      input: 200_000, output: 100, cacheRead: 72_000, cacheWrite: 1,
    });
    expect(tiered.contextTokens).toBe(272_001);
    expect(tiered.contextTierId).toBe("tier-high");
    expect(tiered.inputRate).toBe(0.7);
  });

  it("keeps exactly 200K in the low tier and starts the high tier at 200001", () => {
    const quote = buildPricingQuote({
      rate: base,
      windows: [],
      tiers: [contextTier("over-200k", 200_001, null)],
      modelId: "deepseek-v4-pro",
      modelProvider: "opencode",
      requestStartedAt: new Date("2026-08-17T12:00:00Z"),
      billingMultiplier: 1,
    });
    expect(calculateQuotedCharge(quote, {
      input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0,
    }).contextTierId).toBeNull();
    expect(calculateQuotedCharge(quote, {
      input: 200_000, output: 0, cacheRead: 1, cacheWrite: 0,
    }).contextTierId).toBe("over-200k");
  });

  it("does not count output tokens toward the context threshold", () => {
    const quote = buildPricingQuote({
      rate: base, windows: [], tiers: [high], modelId: "deepseek-v4-pro",
      modelProvider: "opencode", requestStartedAt: new Date(), billingMultiplier: 1,
    });
    expect(calculateQuotedCharge(quote, {
      input: 272_000, output: 500_000, cacheRead: 0, cacheWrite: 0,
    }).contextTierId).toBeNull();
  });

  it("locks only tiers belonging to the selected time scope", () => {
    const selectedWindow = peak("first", 60, 240);
    const quote = buildPricingQuote({
      rate: base,
      windows: [selectedWindow],
      tiers: [high, contextTier("peak-high", 272_001, null, "first")],
      modelId: "deepseek-v4-pro",
      modelProvider: "opencode",
      requestStartedAt: new Date("2026-08-17T02:00:00Z"),
      billingMultiplier: 1,
    });
    expect(quote.version).toBe(2);
    expect(quote.contextTiers.map((tier) => tier.id)).toEqual(["peak-high"]);
    expect(Object.isFrozen(quote.contextTiers[0])).toBe(true);
  });

  it("preserves Quote v1 charging", () => {
    const quote: PricingQuoteV1 = {
      version: 1,
      requestStartedAt: "2026-08-17T12:00:00.000Z",
      modelId: "deepseek-v4-pro",
      modelProvider: "opencode",
      creditRateId: "pro",
      creditRateWindowId: null,
      pricingPeriod: "off_peak",
      inputRate: 1,
      outputRate: 2,
      cacheReadRate: 0.1,
      cacheWriteRate: 0.5,
      billingMultiplier: 2,
    };
    expect(calculateQuotedCharge(quote, {
      input: 1000, output: 500, cacheRead: 100, cacheWrite: 200,
    })).toMatchObject({ credits: 4.22, contextTierId: null, contextTokens: 1300 });
  });

  it("rejects invalid usage and invalid context tier configuration", () => {
    const quote = buildPricingQuote({
      rate: base, windows: [], tiers: [high], modelId: "deepseek-v4-pro",
      modelProvider: "opencode", requestStartedAt: new Date(), billingMultiplier: 1,
    });
    expect(() => calculateQuotedCharge(quote, {
      input: -1, output: 0, cacheRead: 0, cacheWrite: 0,
    })).toThrow("Invalid usage input");
    expect(() => validatePricingConfiguration([base], [], [
      contextTier("first", 200_001, 300_000),
      contextTier("gap", 300_002, null),
    ])).toThrow("gap");
    expect(() => validatePricingConfiguration([base], [], [
      contextTier("wrong-parent", 200_001, null, "missing"),
    ])).toThrow("Unknown time window");
  });
});
