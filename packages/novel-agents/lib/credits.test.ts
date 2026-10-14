import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreditBillingClient, invalidateRatesCache, type Usage } from "./credits.js";

function createDb(overrides: Record<string, unknown> = {}) {
  return {
    getCreditBalance: vi.fn(),
    createCreditBalance: vi.fn(),
    topUpCredits: vi.fn(),
    recalcUserLevel: vi.fn(),
    listCreditRates: vi.fn(),
    listCreditRateTimeWindows: vi.fn().mockResolvedValue([]),
    listCreditRateContextTiers: vi.fn().mockResolvedValue([]),
    insertUsageRecord: vi.fn(),
    deductCreditsAtomic: vi.fn(),
    listCreditTransactions: vi.fn(),
    listUsageRecords: vi.fn(),
    ...overrides,
  } as any;
}

const rate = {
  id: "rate-1",
  name: "DeepSeek",
  modelPattern: "deepseek%",
  providerPattern: "deepseek",
  inputRate: 1,
  outputRate: 2,
  cacheReadRate: 0.1,
  cacheWriteRate: 0.5,
  priority: 10,
};

const usage: Usage = {
  input: 1000,
  output: 500,
  cacheRead: 100,
  cacheWrite: 200,
  totalTokens: 1800,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};

describe("CreditBillingClient", () => {
  beforeEach(() => {
    invalidateRatesCache();
  });

  it("maps balance rows and creates a missing balance", async () => {
    const db = createDb();
    db.getCreditBalance
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        user_id: "user-1",
        balance: "88.5",
        total_granted: "100",
        total_consumed: "11.5",
        level: 2,
        multiplier: "1.5",
      });

    const client = new CreditBillingClient(db);
    await expect(client.ensureBalance("user-1", 100)).resolves.toMatchObject({
      userId: "user-1",
      balance: 88.5,
      multiplier: 1.5,
    });
    expect(db.createCreditBalance).toHaveBeenCalledWith("user-1", 100);
  });

  it("resolves rates by provider and calculates credits", () => {
    const client = new CreditBillingClient(createDb());
    const fallback = { ...rate, id: "fallback", modelPattern: "%", providerPattern: null, priority: 0 };

    const resolved = client.resolveRate([fallback, rate], "deepseek-v4", "deepseek");

    expect(resolved.id).toBe("rate-1");
    expect(client.calculateCredits(resolved, usage)).toBe(2.11);
  });

  it("treats a model whose every rate component is zero as free", async () => {
    const db = createDb();
    db.listCreditRates.mockResolvedValue([
      { id: "free", name: "Free", model_pattern: "deepseek-v4-flash-free", provider_pattern: "opencode",
        input_rate: "0", output_rate: "0", cache_read_rate: "0", cache_write_rate: "0", priority: 100 },
      { id: "fallback", name: "Default", model_pattern: "%", provider_pattern: "opencode",
        input_rate: "0.07", output_rate: "0.35", cache_read_rate: "0.007", cache_write_rate: "0.04", priority: 0 },
    ]);
    invalidateRatesCache();
    const client = new CreditBillingClient(db);

    await expect(client.isFreeModel("deepseek-v4-flash-free", "opencode")).resolves.toBe(true);
    await expect(client.isFreeModel("claude-opus-4.7", "opencode")).resolves.toBe(false);
  });

  it("treats a free base model with any paid context tier as paid", async () => {
    const db = createDb();
    db.listCreditRates.mockResolvedValue([{
      id: "free", name: "Free", model_pattern: "free-model", provider_pattern: "opencode",
      input_rate: "0", output_rate: "0", cache_read_rate: "0", cache_write_rate: "0", priority: 100,
    }]);
    db.listCreditRateContextTiers.mockResolvedValue([{
      id: "paid-tier", credit_rate_id: "free", credit_rate_time_window_id: null,
      label: "over_200k", min_context_tokens: 200001, max_context_tokens: null,
      input_rate: "1", output_rate: "2", cache_read_rate: "0.1", cache_write_rate: "0",
      priority: 100,
    }]);
    const client = new CreditBillingClient(db);
    await expect(client.isFreeModel("free-model", "opencode")).resolves.toBe(false);
  });

  it("ignores special pricing with an inactive base rate or time window", async () => {
    const db = createDb();
    db.listCreditRates.mockResolvedValue([{
      id: "active-rate", name: "Active", model_pattern: "%", provider_pattern: "opencode",
      input_rate: "1", output_rate: "2", cache_read_rate: "0.1", cache_write_rate: "0",
      priority: 0,
    }]);
    db.listCreditRateContextTiers.mockResolvedValue([
      {
        id: "orphan-tier", credit_rate_id: "inactive-rate", credit_rate_time_window_id: null,
        label: "over_200k", min_context_tokens: 200001, max_context_tokens: null,
        input_rate: "2", output_rate: "4", cache_read_rate: "0.2", cache_write_rate: "0",
        priority: 100,
      },
      {
        id: "orphan-window-tier", credit_rate_id: "active-rate",
        credit_rate_time_window_id: "inactive-window", label: "peak_over_200k",
        min_context_tokens: 200001, max_context_tokens: null,
        input_rate: "3", output_rate: "6", cache_read_rate: "0.3", cache_write_rate: "0",
        priority: 100,
      },
    ]);
    db.listCreditRateTimeWindows.mockResolvedValue([{
      id: "orphan-window", credit_rate_id: "inactive-rate", label: "peak", timezone: "UTC",
      start_minute: 0, end_minute: 60,
      input_rate: "2", output_rate: "4", cache_read_rate: "0.2", cache_write_rate: "0",
      priority: 100,
    }]);
    const client = new CreditBillingClient(db);

    await expect(client.getRates()).resolves.toHaveLength(1);
  });

  it("ignores semantically duplicate active time windows", async () => {
    const db = createDb();
    db.listCreditRates.mockResolvedValue([{
      id: "active-rate", name: "Active", model_pattern: "%", provider_pattern: "opencode",
      input_rate: "1", output_rate: "2", cache_read_rate: "0.1", cache_write_rate: "0",
      priority: 0,
    }]);
    db.listCreditRateTimeWindows.mockResolvedValue([
      {
        id: "canonical-window", credit_rate_id: "active-rate", label: "peak", timezone: "UTC",
        start_minute: 60, end_minute: 240, input_rate: "2", output_rate: "4",
        cache_read_rate: "0.2", cache_write_rate: "0", priority: 100,
      },
      {
        id: "duplicate-window", credit_rate_id: "active-rate", label: "peak_1", timezone: "UTC",
        start_minute: 60, end_minute: 240, input_rate: "2", output_rate: "4",
        cache_read_rate: "0.2", cache_write_rate: "0", priority: 100,
      },
    ]);
    const client = new CreditBillingClient(db);

    await expect(client.getRates()).resolves.toHaveLength(1);
  });

  it("caches rates and delegates transaction lists", async () => {
    const db = createDb();
    db.listCreditRates.mockResolvedValue([
      {
        id: "rate-1",
        name: "Any",
        model_pattern: "%",
        provider_pattern: null,
        input_rate: "1",
        output_rate: "2",
        cache_read_rate: "0",
        cache_write_rate: "0",
        priority: 0,
      },
    ]);
    db.listCreditTransactions.mockResolvedValue([{ id: "tx-1" }]);
    db.listUsageRecords.mockResolvedValue([{ id: "usage-1" }]);

    const client = new CreditBillingClient(db);

    await expect(client.getRates()).resolves.toHaveLength(1);
    await expect(client.getRates()).resolves.toHaveLength(1);
    expect(db.listCreditRates).toHaveBeenCalledTimes(1);
    await expect(client.listTransactions("user-1", 5, 10)).resolves.toEqual([{ id: "tx-1" }]);
    await expect(client.listUsageRecords("user-1", "project-1", 5)).resolves.toEqual([{ id: "usage-1" }]);
  });

  it("records usage, retries without session_id on FK errors, and deducts credits", async () => {
    const db = createDb();
    db.listCreditRates.mockResolvedValue([
      {
        id: "rate-1",
        name: "DeepSeek",
        model_pattern: "deepseek%",
        provider_pattern: "deepseek",
        input_rate: "1",
        output_rate: "2",
        cache_read_rate: "0.1",
        cache_write_rate: "0.5",
        priority: 10,
      },
    ]);
    db.getCreditBalance.mockResolvedValue({
      user_id: "user-1",
      balance: "10",
      total_granted: "10",
      total_consumed: "0",
      level: 1,
      multiplier: "2",
    });
    db.insertUsageRecord
      .mockRejectedValueOnce(new Error("session_id violates foreign key"))
      .mockResolvedValueOnce({ id: "usage-1" });
    db.deductCreditsAtomic.mockResolvedValue({ success: true, new_balance: 5.78 });

    const client = new CreditBillingClient(db);
    await client.recordAndCharge({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "missing-session",
      agentId: "chief_editor",
      modelId: "deepseek-v4",
      modelProvider: "deepseek",
      usage,
    });

    expect(db.insertUsageRecord).toHaveBeenCalledTimes(2);
    expect(db.insertUsageRecord.mock.calls[1][0]).toMatchObject({ sessionId: undefined });
    expect(db.deductCreditsAtomic).toHaveBeenCalledWith(
      "user-1",
      4.22,
      "usage_record",
      "usage-1",
      "chief_editor: deepseek-v4 (1800 tokens)",
    );
  });

  it("locks Peak rates and multiplier in a quote and persists its audit snapshot", async () => {
    const db = createDb();
    db.listCreditRates.mockResolvedValue([{
      id: "rate-1", name: "DeepSeek V4 Pro", model_pattern: "deepseek-v4-pro",
      provider_pattern: "opencode", input_rate: "0.0462", output_rate: "0.1386",
      cache_read_rate: "0.00154", cache_write_rate: "0", priority: 10,
    }]);
    db.listCreditRateTimeWindows.mockResolvedValue([{
      id: "window-1", credit_rate_id: "rate-1", label: "peak", timezone: "UTC",
      start_minute: 60, end_minute: 240, input_rate: "0.0924", output_rate: "0.2772",
      cache_read_rate: "0.00308", cache_write_rate: "0", priority: 100,
    }]);
    db.getCreditBalance.mockResolvedValue({
      user_id: "user-1", balance: "10", total_granted: "10",
      total_consumed: "0", level: 1, multiplier: "2",
    });
    db.insertUsageRecord.mockResolvedValue({ id: "usage-1" });
    db.deductCreditsAtomic.mockResolvedValue({ success: true, new_balance: 9.54 });
    const client = new CreditBillingClient(db);

    const quote = await client.createPricingQuote({
      userId: "user-1", modelId: "deepseek-v4-pro", modelProvider: "opencode",
      requestStartedAt: new Date("2026-08-17T03:59:59Z"),
    });
    expect(quote).toMatchObject({
      version: 2, pricingPeriod: "peak", inputRate: 0.0924,
      billingMultiplier: 2, contextTiers: [],
    });

    await client.recordAndChargeQuotedUsage({
      userId: "user-1", projectId: "project-1", agentId: "chief_editor",
      modelId: "deepseek-v4-pro", modelProvider: "opencode", quote, usage,
    });
    expect(db.insertUsageRecord).toHaveBeenCalledWith(expect.objectContaining({
      requestStartedAt: "2026-08-17T03:59:59.000Z", pricingPeriod: "peak",
      creditRateWindowId: "window-1", billingMultiplier: 2,
      contextTokens: 1300,
      creditRateContextTierId: null,
      rateSnapshot: {
        version: 2,
        selected: {
          inputRate: 0.0924, outputRate: 0.2772, cacheReadRate: 0.00308,
          cacheWriteRate: 0, contextTierId: null, contextTierLabel: null,
        },
        quote: expect.objectContaining({ version: 2, contextTiers: [] }),
      },
    }));
    expect(db.deductCreditsAtomic).toHaveBeenCalledWith(
      "user-1", 0.46, "usage_record", "usage-1", "chief_editor: deepseek-v4-pro (1800 tokens)",
    );
  });

  it("charges a frozen high-context tier and persists its selected audit data", async () => {
    const db = createDb();
    db.listCreditRates.mockResolvedValue([{
      id: "rate-1", name: "GPT 5.5", model_pattern: "gpt-5.5", provider_pattern: "opencode",
      input_rate: "0.35", output_rate: "2.1", cache_read_rate: "0.035",
      cache_write_rate: "0", priority: 10,
    }]);
    db.listCreditRateContextTiers.mockResolvedValue([{
      id: "tier-high", credit_rate_id: "rate-1", credit_rate_time_window_id: null,
      label: "over_272k", min_context_tokens: 272001, max_context_tokens: null,
      input_rate: "0.7", output_rate: "3.15", cache_read_rate: "0.07",
      cache_write_rate: "0", priority: 100,
    }]);
    db.getCreditBalance.mockResolvedValue({
      user_id: "user-1", balance: "1000", total_granted: "1000",
      total_consumed: "0", level: 1, multiplier: "2",
    });
    db.insertUsageRecord.mockResolvedValue({ id: "usage-high" });
    db.deductCreditsAtomic.mockResolvedValue({ success: true, new_balance: 618.88 });
    const client = new CreditBillingClient(db);
    const quote = await client.createPricingQuote({
      userId: "user-1", modelId: "gpt-5.5", modelProvider: "opencode",
      requestStartedAt: new Date("2026-08-17T12:00:00Z"),
    });
    const highUsage: Usage = {
      input: 200_000, output: 100, cacheRead: 72_000, cacheWrite: 1,
      totalTokens: 272_101,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    await client.recordAndChargeQuotedUsage({
      userId: "user-1", projectId: "project-1", agentId: "writer",
      modelId: "gpt-5.5", modelProvider: "opencode", quote, usage: highUsage,
    });

    expect(db.insertUsageRecord).toHaveBeenCalledWith(expect.objectContaining({
      contextTokens: 272001,
      creditRateContextTierId: "tier-high",
      rateSnapshot: {
        version: 2,
        selected: {
          inputRate: 0.7, outputRate: 3.15, cacheReadRate: 0.07, cacheWriteRate: 0,
          contextTierId: "tier-high", contextTierLabel: "over_272k",
        },
        quote: expect.objectContaining({ version: 2 }),
      },
    }));
    expect(db.deductCreditsAtomic).toHaveBeenCalledWith(
      "user-1", 290.71, "usage_record", "usage-high", "writer: gpt-5.5 (272101 tokens)",
    );
  });

  it("rejects an initial pricing load failure", async () => {
    const db = createDb();
    db.listCreditRates.mockRejectedValue(new Error("database unavailable"));
    const client = new CreditBillingClient(db);
    await expect(client.createPricingQuote({
      userId: "user-1", modelId: "paid", modelProvider: "opencode", requestStartedAt: new Date(),
    })).rejects.toThrow("database unavailable");
  });

  it("uses the last valid pricing snapshot when refresh fails", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-17T01:00:00Z"));
      const db = createDb();
      db.listCreditRates.mockResolvedValueOnce([{
        id: "rate-1", name: "Default", model_pattern: "%", provider_pattern: null,
        input_rate: "1", output_rate: "2", cache_read_rate: "0", cache_write_rate: "0", priority: 0,
      }]);
      db.getCreditBalance.mockResolvedValue({ user_id: "u1", balance: "10", total_granted: "10", total_consumed: "0", level: 1, multiplier: "2" });
      const client = new CreditBillingClient(db);
      await client.createPricingQuote({ userId: "u1", modelId: "paid", modelProvider: "opencode", requestStartedAt: new Date() });

      vi.advanceTimersByTime(61_000);
      db.listCreditRates.mockRejectedValueOnce(new Error("offline"));
      db.listCreditRateTimeWindows.mockRejectedValueOnce(new Error("offline"));
      await expect(client.createPricingQuote({
        userId: "u1", modelId: "paid", modelProvider: "opencode", requestStartedAt: new Date(),
      })).resolves.toMatchObject({ creditRateId: "rate-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a completed model that does not match its quote", async () => {
    const client = new CreditBillingClient(createDb());
    await expect(client.recordAndChargeQuotedUsage({
      userId: "u1", projectId: "p1", agentId: "chief_editor",
      modelId: "other", modelProvider: "opencode",
      quote: {
        version: 1, requestStartedAt: new Date().toISOString(), modelId: "deepseek-v4-pro",
        modelProvider: "opencode", creditRateId: "rate-1", creditRateWindowId: null,
        pricingPeriod: "off_peak", billingMultiplier: 2, inputRate: 1, outputRate: 2,
        cacheReadRate: 0, cacheWriteRate: 0,
      },
      usage,
    })).rejects.toThrow("does not match");
  });

  it("records non-agent-loop compaction usage under a fixed agent id", async () => {
    const client = new CreditBillingClient(createDb());
    vi.spyOn(client, "createPricingQuote").mockResolvedValue({
      version: 1, requestStartedAt: "2026-08-17T05:59:59.000Z",
      modelId: "deepseek-v4", modelProvider: "deepseek", creditRateId: "rate-1",
      creditRateWindowId: null, pricingPeriod: "off_peak", billingMultiplier: 2,
      inputRate: 1, outputRate: 2, cacheReadRate: 0.1, cacheWriteRate: 0.5,
    });
    const record = vi.spyOn(client, "recordAndChargeQuotedUsage").mockResolvedValue(undefined);

    await client.recordCompactionUsage({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-1",
      modelId: "deepseek-v4",
      modelProvider: "deepseek",
      quote: {
        version: 1, requestStartedAt: "2026-08-17T05:59:59.000Z",
        modelId: "deepseek-v4", modelProvider: "deepseek", creditRateId: "rate-1",
        creditRateWindowId: null, pricingPeriod: "off_peak", billingMultiplier: 2,
        inputRate: 1, outputRate: 2, cacheReadRate: 0.1, cacheWriteRate: 0.5,
      },
      usage,
    });

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "session_compaction",
      sessionId: "session-1",
      quote: expect.objectContaining({ requestStartedAt: "2026-08-17T05:59:59.000Z" }),
      usage,
    }));
  });
});
