import { describe, expect, it, vi } from "vitest";
import { attachUsageTracker } from "./usage-tracker.js";

function setup(options: { isByokTurn?: () => boolean } = {}) {
  let listener: (event: any) => Promise<void> | void = () => undefined;
  const agent = {
    state: { model: { id: "deepseek-v4-pro", provider: "opencode" } },
    subscribe: vi.fn((next: typeof listener) => { listener = next; return () => undefined; }),
  };
  const quote = {
    version: 1 as const, requestStartedAt: "2026-08-17T03:59:59.000Z",
    modelId: "deepseek-v4-pro", modelProvider: "opencode", creditRateId: "rate-1",
    creditRateWindowId: "window-1", pricingPeriod: "peak", billingMultiplier: 2,
    inputRate: 0.0924, outputRate: 0.2772, cacheReadRate: 0.00308, cacheWriteRate: 0,
  };
  const billing = {
    createPricingQuote: vi.fn().mockResolvedValue(quote),
    recordAndChargeQuotedUsage: vi.fn().mockResolvedValue(undefined),
    recordByokUsage: vi.fn().mockResolvedValue(undefined),
  };
  const times = [new Date("2026-08-17T03:59:59Z"), new Date("2026-08-17T04:00:01Z")];
  attachUsageTracker({
    agent: agent as any, billing: billing as any, userId: "user-1", projectId: "project-1",
    sessionId: () => "session-1", agentId: "chief_editor", now: () => times.shift()!,
    ...(options.isByokTurn ? { isByokTurn: options.isByokTurn } : {}),
  });
  return { agent, billing, emit: (event: any) => listener(event), quote };
}

const assistantEnd = {
  type: "message_end",
  message: {
    role: "assistant", model: "deepseek-v4-pro", provider: "opencode",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  },
};

describe("attachUsageTracker", () => {
  it("creates and consumes one quote per model turn", async () => {
    const { billing, emit } = setup();
    await emit({ type: "turn_start" });
    await emit(assistantEnd);
    await emit({ type: "turn_start" });
    await emit(assistantEnd);
    expect(billing.createPricingQuote).toHaveBeenCalledTimes(2);
    expect(billing.createPricingQuote.mock.calls[0][0].requestStartedAt.toISOString()).toBe("2026-08-17T03:59:59.000Z");
    expect(billing.createPricingQuote.mock.calls[1][0].requestStartedAt.toISOString()).toBe("2026-08-17T04:00:01.000Z");
    expect(billing.recordAndChargeQuotedUsage).toHaveBeenCalledTimes(2);
  });

  it("fails closed when quote creation fails", async () => {
    const { billing, emit } = setup();
    billing.createPricingQuote.mockRejectedValueOnce(new Error("pricing unavailable"));
    await expect(emit({ type: "turn_start" })).rejects.toThrow("pricing unavailable");
    expect(billing.recordAndChargeQuotedUsage).not.toHaveBeenCalled();
  });

  it("rejects a billable completion without a quote", async () => {
    const { emit } = setup();
    await expect(emit(assistantEnd)).rejects.toThrow("Missing pricing quote");
  });

  it("ignores non-assistant messages", async () => {
    const { billing, emit } = setup();
    await emit({ type: "message_end", message: { role: "user", content: "hi" } });
    expect(billing.recordAndChargeQuotedUsage).not.toHaveBeenCalled();
  });

  it("skips quoting and records zero-credit usage on byok turns", async () => {
    const { billing, emit } = setup({ isByokTurn: () => true });
    await emit({ type: "turn_start" });
    await emit(assistantEnd);
    expect(billing.createPricingQuote).not.toHaveBeenCalled();
    expect(billing.recordAndChargeQuotedUsage).not.toHaveBeenCalled();
    expect(billing.recordByokUsage).toHaveBeenCalledTimes(1);
    expect(billing.recordByokUsage.mock.calls[0][0]).toMatchObject({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-1",
      agentId: "chief_editor",
    });
  });

  it("stays on the quote path when isByokTurn is false", async () => {
    const { billing, emit } = setup({ isByokTurn: () => false });
    await emit({ type: "turn_start" });
    await emit(assistantEnd);
    expect(billing.createPricingQuote).toHaveBeenCalledTimes(1);
    expect(billing.recordAndChargeQuotedUsage).toHaveBeenCalledTimes(1);
    expect(billing.recordByokUsage).not.toHaveBeenCalled();
  });

  it("rejects an unconsumed byok turn", async () => {
    const { emit } = setup({ isByokTurn: () => true });
    await emit({ type: "turn_start" });
    await expect(emit({ type: "turn_start" })).rejects.toThrow("Unconsumed byok usage");
  });
});
