import { describe, expect, it, vi } from "vitest";
import { reconcileRegistrationReservations } from "./reconcile.js";

describe("registration reconciliation", () => {
  it("runs a bounded idempotent reconciliation RPC", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ finalized_count: 2, expired_count: 1 }] });
    const now = new Date("2026-08-18T00:00:00Z");
    await expect(reconcileRegistrationReservations({ query } as never, now, 25))
      .resolves.toEqual({ finalized: 2, expired: 1 });
    expect(query).toHaveBeenCalledWith(
      "SELECT * FROM novel.reconcile_registration_reservations($1, $2)",
      [now.toISOString(), 25],
    );
  });
});
