import { afterEach, describe, expect, it, vi } from "vitest";
import { MembershipService } from "./billing/membership-service.js";
import { PaymentError } from "./billing/payment-service.js";
import { generateSign } from "./lib/zpay.js";

function setup() {
  const db = {
    listMembershipPlans: vi.fn().mockResolvedValue([{
      id: "plan-1", slug: "monthly", name: "月卡会员", description: "...",
      price_cents: 990, duration_days: 30, bonus_credits: 100,
      features: ["unlimited_projects", "export"], is_active: true,
    }]),
    createMembershipPurchase: vi.fn().mockImplementation(async (input) => ({
      id: "purchase-1", user_id: input.userId, out_trade_no: input.outTradeNo,
      payment_status: "pending",
    })),
    getMembershipPurchase: vi.fn(),
    completeMembershipPurchase: vi.fn().mockResolvedValue({
      payment_status: "completed", expires_at: "2026-08-05T00:00:00Z", bonus_credited: 100,
    }),
    getActiveMembership: vi.fn(),
  };
  return { db, service: new MembershipService(db as any) };
}

describe("MembershipService", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("listPlans maps rows to the public view shape", async () => {
    const { service } = setup();
    const plans = await service.listPlans();
    expect(plans).toEqual([{
      id: "plan-1", slug: "monthly", name: "月卡会员",
      priceCents: 990, durationDays: 30, bonusCredits: 100,
      features: ["unlimited_projects", "export"],
    }]);
  });

  it("createPurchase snapshots plan fields and builds a 9.90 pay url", async () => {
    vi.stubEnv("ZPAY_PID", "pid-1"); vi.stubEnv("ZPAY_KEY", "secret");
    const { db, service } = setup();
    const result = await service.createPurchase("user-1", "plan-1");
    expect(db.createMembershipPurchase).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1", planId: "plan-1", planName: "月卡会员",
      priceCents: 990, durationDays: 30, bonusCredits: 100,
      features: ["unlimited_projects", "export"],
    }));
    expect(result.orderNo).toMatch(/^MC-/);
    expect(new URL(result.payUrl).searchParams.get("money")).toBe("9.90");
  });

  it("createPurchase rejects unknown plans and unconfigured Z-Pay", async () => {
    const { db, service } = setup();
    db.listMembershipPlans.mockResolvedValue([]);
    await expect(service.createPurchase("user-1", "missing")).rejects.toBeInstanceOf(PaymentError);
    db.listMembershipPlans.mockResolvedValue([{ id: "plan-1", is_active: true, features: [] }]);
    await expect(service.createPurchase("user-1", "plan-1")).rejects.toMatchObject({ status: 503 });
  });

  it("getPurchase only returns an order to its owner", async () => {
    const { db, service } = setup();
    db.getMembershipPurchase.mockResolvedValue({ out_trade_no: "MC-1", user_id: "other", payment_status: "pending" });
    await expect(service.getPurchase("user-1", "MC-1")).rejects.toMatchObject({ status: 404 });
  });

  it("getStatus returns active false when no membership exists", async () => {
    const { service } = setup();
    const status = await service.getStatus("user-1");
    expect(status).toEqual({ active: false, planName: null, expiresAt: null, features: [] });
  });

  it("getStatus maps an active membership row", async () => {
    const { db, service } = setup();
    db.getActiveMembership.mockResolvedValue({
      plan_name: "月卡会员", features: ["unlimited_projects", "export"],
      expires_at: "2026-08-05T00:00:00Z", active: true,
    });
    const status = await service.getStatus("user-1");
    expect(status).toEqual({
      active: true, planName: "月卡会员",
      expiresAt: "2026-08-05T00:00:00Z", features: ["unlimited_projects", "export"],
    });
  });

  it("handleNotification validates sign + amount before completing", async () => {
    vi.stubEnv("ZPAY_PID", "pid-1"); vi.stubEnv("ZPAY_KEY", "secret");
    const { db, service } = setup();
    db.getMembershipPurchase.mockResolvedValue({
      out_trade_no: "MC-1", user_id: "user-1", price_cents: 990, payment_status: "pending",
    });
    const fields: Record<string, string> = {
      pid: "pid-1", out_trade_no: "MC-1", trade_no: "zpay-1",
      trade_status: "TRADE_SUCCESS", money: "9.90", param: "user-1", sign_type: "MD5",
    };
    fields.sign = generateSign(fields, "secret");
    await expect(service.handleNotification(new URLSearchParams(fields))).resolves.toBe("success");
    expect(db.completeMembershipPurchase).toHaveBeenCalledWith("MC-1", "zpay-1");
  });

  it("accepts an atomic referral-aware completion result without a second reward call", async () => {
    vi.stubEnv("ZPAY_PID", "pid-1"); vi.stubEnv("ZPAY_KEY", "secret");
    const { db, service } = setup();
    db.getMembershipPurchase.mockResolvedValue({
      out_trade_no: "MC-1", user_id: "user-1", price_cents: 990, payment_status: "pending",
    });
    db.completeMembershipPurchase.mockResolvedValue({
      payment_status: "completed", referral_status: "successful", referral_reward_days: 10,
    });
    const fields: Record<string, string> = {
      pid: "pid-1", out_trade_no: "MC-1", trade_no: "zpay-1",
      trade_status: "TRADE_SUCCESS", money: "9.90", param: "user-1", sign_type: "MD5",
    };
    fields.sign = generateSign(fields, "secret");
    await expect(service.handleNotification(new URLSearchParams(fields))).resolves.toBe("success");
    expect(db.completeMembershipPurchase).toHaveBeenCalledTimes(1);
  });

  it("handleNotification rejects amount tampering", async () => {
    vi.stubEnv("ZPAY_PID", "pid-1"); vi.stubEnv("ZPAY_KEY", "secret");
    const { db, service } = setup();
    db.getMembershipPurchase.mockResolvedValue({
      out_trade_no: "MC-1", user_id: "user-1", price_cents: 990, payment_status: "pending",
    });
    const fields: Record<string, string> = {
      pid: "pid-1", out_trade_no: "MC-1", trade_no: "zpay-1",
      trade_status: "TRADE_SUCCESS", money: "0.01", param: "user-1", sign_type: "MD5",
    };
    fields.sign = generateSign(fields, "secret");
    await expect(service.handleNotification(new URLSearchParams(fields))).rejects.toMatchObject({ status: 400 });
  });
});
