BEGIN;

UPDATE novel.credit_rates
SET input_rate = CASE model_pattern
      WHEN 'deepseek-v4-pro' THEN 0.000250
      ELSE 0.000200
    END,
    output_rate = CASE model_pattern
      WHEN 'deepseek-v4-pro' THEN 0.060000
      ELSE 0.020000
    END,
    cache_read_rate = CASE model_pattern
      WHEN 'deepseek-v4-pro' THEN 0.030000
      ELSE 0.010000
    END,
    cache_write_rate = CASE model_pattern
      WHEN 'deepseek-v4-pro' THEN 0.030000
      ELSE 0.010000
    END,
    updated_at = now()
WHERE provider_pattern = 'opencode'
  AND model_pattern IN ('deepseek-v4-pro', 'deepseek-v4-flash');

ALTER TABLE novel.usage_records
  DROP CONSTRAINT IF EXISTS usage_records_credit_rate_window_id_fkey,
  DROP COLUMN IF EXISTS request_started_at,
  DROP COLUMN IF EXISTS pricing_period,
  DROP COLUMN IF EXISTS credit_rate_window_id,
  DROP COLUMN IF EXISTS rate_snapshot,
  DROP COLUMN IF EXISTS billing_multiplier;

DROP TABLE IF EXISTS novel.credit_rate_time_windows;

COMMIT;
