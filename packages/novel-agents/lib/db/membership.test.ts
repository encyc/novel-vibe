import { describe, beforeEach } from "vitest";
import { createDbTestContext } from "./test-kit.js";

let ctx: ReturnType<typeof createDbTestContext>;

beforeEach(() => {
  ctx = createDbTestContext();
});

describe("membership operations", () => {
    it("listMembershipPlans queries active plans ordered by display_order", async () => {
      ctx.mockOkRaw([{ slug: "monthly" }]);
      const rows = await ctx.db.listMembershipPlans();
      expect(rows).toEqual([{ slug: "monthly" }]);
      expect(String(ctx.fetchMock.mock.calls[0][0])).toContain("/membership_plans?is_active=eq.true");
      expect(String(ctx.fetchMock.mock.calls[0][0])).toContain("order=display_order.asc");
    });

    it("createMembershipPurchase posts snapshotted fields", async () => {
      ctx.mockOkRaw([{ id: "p1" }]);
      await ctx.db.createMembershipPurchase({
        userId: "u1", outTradeNo: "MC-1", planId: "plan-1", planName: "月卡会员",
        priceCents: 990, durationDays: 30, bonusCredits: 100, features: ["unlimited_projects", "export"],
      });
      const [, init] = ctx.fetchMock.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.out_trade_no).toBe("MC-1");
      expect(body.plan_name_snapshot).toBe("月卡会员");
      expect(body.duration_days_snapshot).toBe(30);
      expect(body.bonus_credits_snapshot).toBe(100);
      expect(body.features_snapshot).toEqual(["unlimited_projects", "export"]);
      expect(body.payment_status).toBe("pending");
    });

    it("getMembershipPurchase filters by out_trade_no", async () => {
      ctx.mockOkRaw([{ out_trade_no: "MC-1" }]);
      const row = await ctx.db.getMembershipPurchase("MC-1");
      expect(row).toEqual({ out_trade_no: "MC-1" });
      expect(String(ctx.fetchMock.mock.calls[0][0])).toContain("out_trade_no=eq.MC-1");
    });

    it("completeMembershipPurchase calls the RPC", async () => {
      ctx.mockOkRaw([{ payment_status: "completed" }]);
      await ctx.db.completeMembershipPurchase("MC-1", "zpay-1");
      const [url, init] = ctx.fetchMock.mock.calls[0];
      expect(String(url)).toContain("/rpc/complete_membership_purchase");
      expect(JSON.parse(init.body)).toEqual({ p_out_trade_no: "MC-1", p_payment_id: "zpay-1" });
    });

    it("getActiveMembership calls the status RPC", async () => {
      ctx.mockOkRaw([{ active: true }]);
      const row = await ctx.db.getActiveMembership("u1");
      expect(row).toEqual({ active: true });
      const [url, init] = ctx.fetchMock.mock.calls[0];
      expect(String(url)).toContain("/rpc/get_active_membership");
      expect(JSON.parse(init.body)).toEqual({ p_user_id: "u1" });
    });

    it("countProjectsByOwner returns the row count", async () => {
      ctx.mockOkRaw([{ id: "a" }, { id: "b" }]);
      const count = await ctx.db.countProjectsByOwner("u1");
      expect(count).toBe(2);
      expect(String(ctx.fetchMock.mock.calls[0][0])).toContain("owner_id=eq.u1");
    });
  });
