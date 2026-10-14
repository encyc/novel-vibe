import { describe, beforeEach } from "vitest";
import { createDbTestContext } from "./test-kit.js";

let ctx: ReturnType<typeof createDbTestContext>;

beforeEach(() => {
  ctx = createDbTestContext();
});

describe("member referrals", () => {
    it("uses RPCs for anonymous preview and caller-scoped dashboard", async () => {
      ctx.mockOkRaw([{ valid: true }]);
      await expect(ctx.db.previewReferralCode("ABCD2345")).resolves.toEqual({ valid: true });
      expect(String(ctx.fetchMock.mock.calls[0][0])).toContain("/rpc/preview_referral_code");
      expect(JSON.parse(ctx.fetchMock.mock.calls[0][1].body)).toEqual({ p_code: "ABCD2345" });

      ctx.fetchMock.mockClear();
      ctx.mockOkRaw({ code: "ABCD2345" });
      await expect(ctx.db.getReferralDashboard("u1")).resolves.toEqual({ code: "ABCD2345" });
      expect(String(ctx.fetchMock.mock.calls[0][0])).toContain("/rpc/get_referral_dashboard");
      expect(JSON.parse(ctx.fetchMock.mock.calls[0][1].body)).toEqual({ p_user_id: "u1" });
    });
  });
