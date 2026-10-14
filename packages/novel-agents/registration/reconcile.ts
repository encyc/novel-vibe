import type { Pool } from "pg";

export async function reconcileRegistrationReservations(
  pool: Pick<Pool, "query">,
  now = new Date(),
  limit = 100,
): Promise<{ finalized: number; expired: number }> {
  const result = await pool.query(
    "SELECT * FROM novel.reconcile_registration_reservations($1, $2)",
    [now.toISOString(), limit],
  );
  const row = result.rows[0];
  return {
    finalized: Number(row?.finalized_count ?? 0),
    expired: Number(row?.expired_count ?? 0),
  };
}
