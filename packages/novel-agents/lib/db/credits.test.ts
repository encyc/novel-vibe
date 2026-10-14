import { describe, beforeEach } from "vitest";
import { createDbTestContext } from "./test-kit.js";

let ctx: ReturnType<typeof createDbTestContext>;

beforeEach(() => {
  ctx = createDbTestContext();
});

describe("profile and credit center", () => {
    it("reads a profile from the public schema", async () => {
      ctx.mockOkRaw([{ id: "user-1", nickname: "墨白", avatar_url: null, locale: "en" }]);

      await expect(ctx.db.getUserProfile("user-1")).resolves.toMatchObject({ nickname: "墨白" });

      const [url, options] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("/users?id=eq.user-1");
      expect(options.headers["Accept-Profile"]).toBe("public");
    });

    it("updates a profile through the public schema", async () => {
      ctx.mockOkRaw([{ id: "user-1", nickname: "墨白", avatar_url: null, locale: "en" }]);

      await expect(ctx.db.upsertUserProfile({ userId: "user-1", nickname: "墨白", avatarUrl: null, locale: "en" }))
        .resolves.toMatchObject({ locale: "en" });

      const [, options] = ctx.fetchMock.mock.calls[0];
      expect(options.method).toBe("PATCH");
      expect(options.headers["Content-Profile"]).toBe("public");
      expect(options.headers.Prefer).toBe("return=representation");
      expect(JSON.parse(options.body)).toEqual({ nickname: "墨白", avatar_url: null, locale: "en" });
    });

    it("uses cursor and activity RPCs", async () => {
      ctx.mockOkRaw([]);
      await ctx.db.listCreditTransactionsCursor({ userId: "user-1", type: "consume", limit: 21 });
      expect(ctx.fetchMock.mock.calls[0][0]).toContain("/rpc/list_credit_transactions_cursor");
      expect(JSON.parse(ctx.fetchMock.mock.calls[0][1].body)).toMatchObject({
        p_user_id: "user-1", p_type: "consume", p_limit: 21,
      });

      ctx.mockOkRaw([{ activity_date: "2026-07-01", credits_consumed: 12.5 }]);
      await ctx.db.getCreditActivity({ userId: "user-1", year: 2026, timezone: "Asia/Shanghai" });
      expect(ctx.fetchMock.mock.calls[1][0]).toContain("/rpc/credit_activity_by_day");
    });

    // PostgREST serialises a RETURNS TABLE function as a one-element array.
    // Returning it verbatim made callers read `undefined` for success/new_balance
    // and warn about an "insufficient balance" on charges that had succeeded.
    it("unwraps the single row returned by the deduct_credits RPC", async () => {
      ctx.mockOk([{ success: true, new_balance: 217.2 }]);

      await expect(ctx.db.deductCreditsAtomic(
        "user-1", 0.59, "usage_record", "usage-1", "chief_editor: deepseek-v4-flash",
      )).resolves.toEqual({ success: true, new_balance: 217.2 });

      expect(ctx.fetchMock.mock.calls[0][0]).toContain("/rpc/deduct_credits");
    });

    it("surfaces a rejected deduction with its real balance", async () => {
      ctx.mockOk([{ success: false, new_balance: 0.49 }]);

      await expect(ctx.db.deductCreditsAtomic(
        "user-1", 5, "usage_record", "usage-2", "chief_editor: deepseek-v4-flash",
      )).resolves.toEqual({ success: false, new_balance: 0.49 });
    });

    it("fails loudly on a malformed deduction payload", async () => {
      ctx.mockOkRaw([]);

      await expect(ctx.db.deductCreditsAtomic(
        "user-1", 5, "usage_record", "usage-3", "chief_editor: deepseek-v4-flash",
      )).rejects.toThrow("unexpected payload");
    });
  });
