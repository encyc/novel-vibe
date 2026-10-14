import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentService } from "./billing/payment-service.js";
import { generateSign } from "./lib/zpay.js";

function setup() {
  const db = {
    listCreditPackages: vi.fn().mockResolvedValue([{
      id: "pkg-1", name: "基础包", price_cents: 2000, credits: 200,
      bonus_credits: 50, is_active: true,
    }]),
    createPurchase: vi.fn().mockImplementation(async (input) => ({
      id: "purchase-1", user_id: input.userId, out_trade_no: input.outTradeNo,
      credits: input.credits, bonus_credits_snapshot: input.bonusCredits,
      price_cents: input.priceCents, payment_status: "pending",
    })),
    getPurchase: vi.fn(),
    completeCreditPurchase: vi.fn().mockResolvedValue({ payment_status: "completed", new_balance: 250 }),
  };
  return { db, service: new PaymentService(db as any) };
}

describe("PaymentService", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("creates an order from the server-side package snapshot", async () => {
    vi.stubEnv("ZPAY_PID", "pid-1"); vi.stubEnv("ZPAY_KEY", "secret");
    const { db, service } = setup();
    const result = await service.createPurchase("user-1", "pkg-1");
    expect(db.createPurchase).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1", packageId: "pkg-1", packageName: "基础包",
      credits: 200, bonusCredits: 50, priceCents: 2000,
    }));
    expect(new URL(result.payUrl).searchParams.get("money")).toBe("20.00");
  });

  it("rejects unavailable packages and missing payment config", async () => {
    const { db, service } = setup();
    db.listCreditPackages.mockResolvedValue([]);
    await expect(service.createPurchase("user-1", "missing")).rejects.toMatchObject({ status: 404 });
    db.listCreditPackages.mockResolvedValue([{ id: "pkg-1", is_active: true }]);
    await expect(service.createPurchase("user-1", "pkg-1")).rejects.toMatchObject({ status: 503 });
  });

  it("only returns an order to its owner", async () => {
    const { db, service } = setup();
    db.getPurchase.mockResolvedValue({ out_trade_no: "NOVEL123", user_id: "other", payment_status: "pending" });
    await expect(service.getPurchase("user-1", "NOVEL123")).rejects.toMatchObject({ status: 404 });
  });

  it("validates a successful callback before atomic completion", async () => {
    vi.stubEnv("ZPAY_PID", "pid-1"); vi.stubEnv("ZPAY_KEY", "secret");
    const { db, service } = setup();
    db.getPurchase.mockResolvedValue({ out_trade_no: "NOVEL123", user_id: "user-1", price_cents: 2000, payment_status: "pending" });
    const fields: Record<string, string> = {
      pid: "pid-1", out_trade_no: "NOVEL123", trade_no: "zpay-1",
      trade_status: "TRADE_SUCCESS", money: "20.00", param: "user-1", sign_type: "MD5",
    };
    fields.sign = generateSign(fields, "secret");
    await expect(service.handleNotification(new URLSearchParams(fields))).resolves.toBe("success");
    expect(db.completeCreditPurchase).toHaveBeenCalledWith("NOVEL123", "zpay-1");
  });

  it("rejects callback amount tampering", async () => {
    vi.stubEnv("ZPAY_PID", "pid-1"); vi.stubEnv("ZPAY_KEY", "secret");
    const { db, service } = setup();
    db.getPurchase.mockResolvedValue({ out_trade_no: "NOVEL123", user_id: "user-1", price_cents: 2000, payment_status: "pending" });
    const fields: Record<string, string> = {
      pid: "pid-1", out_trade_no: "NOVEL123", trade_no: "zpay-1",
      trade_status: "TRADE_SUCCESS", money: "0.01", param: "user-1", sign_type: "MD5",
    };
    fields.sign = generateSign(fields, "secret");
    await expect(service.handleNotification(new URLSearchParams(fields))).rejects.toMatchObject({ status: 400 });
  });
});
