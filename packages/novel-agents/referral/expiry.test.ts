import { describe, expect, it, vi } from "vitest";
import { expireReferralBindings } from "./expiry.js";

describe("referral expiry", () => {
  it("calls the bounded idempotent expiry RPC", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ expired_count: 3 }] });
    const now = new Date("2026-08-18T00:00:00Z");
    await expect(expireReferralBindings({ query } as never, now, 25)).resolves.toBe(3);
    expect(query).toHaveBeenCalledWith(
      "SELECT novel.expire_referral_bindings($1, $2) AS expired_count",
      [now.toISOString(), 25],
    );
  });
});
