BEGIN;

CREATE TABLE IF NOT EXISTS novel.credit_rate_time_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_rate_id UUID NOT NULL REFERENCES novel.credit_rates(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (timezone = 'UTC'),
  start_minute SMALLINT NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute SMALLINT NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  input_rate NUMERIC(10,6) NOT NULL CHECK (input_rate >= 0),
  output_rate NUMERIC(10,6) NOT NULL CHECK (output_rate >= 0),
  cache_read_rate NUMERIC(10,6) NOT NULL CHECK (cache_read_rate >= 0),
  cache_write_rate NUMERIC(10,6) NOT NULL CHECK (cache_write_rate >= 0),
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (start_minute < end_minute),
  UNIQUE (credit_rate_id, label, start_minute, end_minute)
);

CREATE INDEX IF NOT EXISTS idx_credit_rate_time_windows_active
  ON novel.credit_rate_time_windows(credit_rate_id, is_active, priority DESC);

ALTER TABLE novel.usage_records
  ADD COLUMN IF NOT EXISTS request_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pricing_period TEXT,
  ADD COLUMN IF NOT EXISTS credit_rate_window_id UUID,
  ADD COLUMN IF NOT EXISTS rate_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS billing_multiplier NUMERIC(8,4);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'usage_records_credit_rate_window_id_fkey'
      AND conrelid = 'novel.usage_records'::regclass
  ) THEN
    ALTER TABLE novel.usage_records
      ADD CONSTRAINT usage_records_credit_rate_window_id_fkey
      FOREIGN KEY (credit_rate_window_id)
      REFERENCES novel.credit_rate_time_windows(id)
      ON DELETE SET NULL;
  END IF;
END
$migration$;

UPDATE novel.credit_rates
SET input_rate = CASE model_pattern
      WHEN 'deepseek-v4-pro' THEN 0.046200
      ELSE 0.015400
    END,
    output_rate = CASE model_pattern
      WHEN 'deepseek-v4-pro' THEN 0.138600
      ELSE 0.046200
    END,
    cache_read_rate = CASE model_pattern
      WHEN 'deepseek-v4-pro' THEN 0.001540
      ELSE 0.000490
    END,
    cache_write_rate = 0,
    updated_at = now()
WHERE provider_pattern = 'opencode'
  AND model_pattern IN ('deepseek-v4-pro', 'deepseek-v4-flash');

UPDATE novel.credit_rate_time_windows AS existing_window
SET is_active = false,
    updated_at = now()
FROM novel.credit_rates AS rate
WHERE existing_window.credit_rate_id = rate.id
  AND existing_window.is_active = true
  AND rate.provider_pattern = 'opencode'
  AND rate.model_pattern IN ('deepseek-v4-pro', 'deepseek-v4-flash')
  AND (existing_window.start_minute, existing_window.end_minute)
    IN ((60, 240), (360, 600));

WITH windows(label, start_minute, end_minute) AS (
  VALUES ('peak', 60, 240), ('peak', 360, 600)
)
INSERT INTO novel.credit_rate_time_windows (
  credit_rate_id, label, start_minute, end_minute,
  input_rate, output_rate, cache_read_rate, cache_write_rate, priority
)
SELECT rate.id, windows.label, windows.start_minute, windows.end_minute,
  CASE rate.model_pattern WHEN 'deepseek-v4-pro' THEN 0.092400 ELSE 0.030800 END,
  CASE rate.model_pattern WHEN 'deepseek-v4-pro' THEN 0.277200 ELSE 0.092400 END,
  CASE rate.model_pattern WHEN 'deepseek-v4-pro' THEN 0.003080 ELSE 0.000980 END,
  0,
  100
FROM novel.credit_rates AS rate
CROSS JOIN windows
WHERE rate.provider_pattern = 'opencode'
  AND rate.model_pattern IN ('deepseek-v4-pro', 'deepseek-v4-flash')
ON CONFLICT (credit_rate_id, label, start_minute, end_minute) DO UPDATE SET
  input_rate = EXCLUDED.input_rate,
  output_rate = EXCLUDED.output_rate,
  cache_read_rate = EXCLUDED.cache_read_rate,
  cache_write_rate = EXCLUDED.cache_write_rate,
  priority = EXCLUDED.priority,
  is_active = true,
  updated_at = now();

ALTER TABLE novel.credit_rate_time_windows ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON novel.credit_rate_time_windows FROM PUBLIC, authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON novel.credit_rates FROM authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.credit_rate_time_windows TO project_admin;
GRANT SELECT ON novel.credit_rates TO authenticated, anon;

COMMIT;
