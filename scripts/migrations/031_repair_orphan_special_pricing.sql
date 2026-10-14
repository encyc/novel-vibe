BEGIN;

UPDATE novel.credit_rate_context_tiers AS tier
SET is_active = false,
    updated_at = now()
FROM novel.credit_rates AS rate
WHERE tier.credit_rate_id = rate.id
  AND tier.is_active = true
  AND NOT rate.is_active;

UPDATE novel.credit_rate_time_windows AS rate_window
SET is_active = false,
    updated_at = now()
FROM novel.credit_rates AS rate
WHERE rate_window.credit_rate_id = rate.id
  AND rate_window.is_active = true
  AND NOT rate.is_active;

WITH ranked_active_windows AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY credit_rate_id, timezone, start_minute, end_minute,
        input_rate, output_rate, cache_read_rate, cache_write_rate, priority
      ORDER BY updated_at DESC, id DESC
    ) AS semantic_rank
  FROM novel.credit_rate_time_windows
  WHERE is_active = true
)
UPDATE novel.credit_rate_time_windows AS rate_window
SET is_active = false,
    updated_at = now()
FROM ranked_active_windows AS ranked
WHERE rate_window.id = ranked.id
  AND ranked.semantic_rank > 1;

COMMIT;
