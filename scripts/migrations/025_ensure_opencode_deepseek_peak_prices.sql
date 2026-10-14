BEGIN;

-- Production databases created before opencode offered V4 Flash may only have
-- the direct DeepSeek row. Create either opencode base row when absent; the
-- NOT EXISTS guard keeps this migration safe under the deploy-time rerunner.
INSERT INTO novel.credit_rates (
  name, model_pattern, provider_pattern,
  input_rate, output_rate, cache_read_rate, cache_write_rate, priority
)
SELECT desired.name, desired.model_pattern, 'opencode',
  desired.input_rate, desired.output_rate, desired.cache_read_rate, 0, 50
FROM (
  VALUES
    ('DeepSeek V4 Pro',   'deepseek-v4-pro',   0.046200::numeric, 0.138600::numeric, 0.001540::numeric),
    ('DeepSeek V4 Flash', 'deepseek-v4-flash', 0.015400::numeric, 0.046200::numeric, 0.000490::numeric)
) AS desired(name, model_pattern, input_rate, output_rate, cache_read_rate)
WHERE NOT EXISTS (
  SELECT 1
  FROM novel.credit_rates AS existing
  WHERE existing.provider_pattern = 'opencode'
    AND existing.model_pattern = desired.model_pattern
);

-- Also converge pre-existing rows to the current off-peak price.
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
    is_active = true,
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

COMMIT;
