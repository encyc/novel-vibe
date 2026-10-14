import type { Pool } from "pg";

export async function expireReferralBindings(
  pool: Pick<Pool, "query">,
  now = new Date(),
  limit = 500,
): Promise<number> {
  const result = await pool.query(
    "SELECT novel.expire_referral_bindings($1, $2) AS expired_count",
    [now.toISOString(), limit],
  );
  return Number(result.rows[0]?.expired_count ?? 0);
}
