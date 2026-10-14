BEGIN;

CREATE TABLE IF NOT EXISTS novel.credit_rate_context_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_rate_id UUID NOT NULL REFERENCES novel.credit_rates(id) ON DELETE CASCADE,
  credit_rate_time_window_id UUID REFERENCES novel.credit_rate_time_windows(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  min_context_tokens BIGINT NOT NULL CHECK (min_context_tokens >= 0),
  max_context_tokens BIGINT,
  input_rate NUMERIC(10,6) NOT NULL CHECK (input_rate >= 0),
  output_rate NUMERIC(10,6) NOT NULL CHECK (output_rate >= 0),
  cache_read_rate NUMERIC(10,6) NOT NULL CHECK (cache_read_rate >= 0),
  cache_write_rate NUMERIC(10,6) NOT NULL CHECK (cache_write_rate >= 0),
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (max_context_tokens IS NULL OR max_context_tokens >= min_context_tokens),
  UNIQUE NULLS NOT DISTINCT (credit_rate_id, credit_rate_time_window_id, min_context_tokens)
);

CREATE INDEX IF NOT EXISTS idx_credit_rate_context_tiers_active
  ON novel.credit_rate_context_tiers(
    credit_rate_id, credit_rate_time_window_id, is_active, priority DESC, min_context_tokens
  );

CREATE OR REPLACE FUNCTION novel.validate_credit_rate_context_tier_parent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.credit_rate_time_window_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM novel.credit_rate_time_windows AS rate_window
    WHERE rate_window.id = NEW.credit_rate_time_window_id
      AND rate_window.credit_rate_id = NEW.credit_rate_id
  ) THEN
    RAISE EXCEPTION 'context tier time window must belong to the same credit rate';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS validate_credit_rate_context_tier_parent
  ON novel.credit_rate_context_tiers;
CREATE TRIGGER validate_credit_rate_context_tier_parent
BEFORE INSERT OR UPDATE OF credit_rate_id, credit_rate_time_window_id
ON novel.credit_rate_context_tiers
FOR EACH ROW EXECUTE FUNCTION novel.validate_credit_rate_context_tier_parent();

ALTER TABLE novel.usage_records
  ADD COLUMN IF NOT EXISTS context_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS credit_rate_context_tier_id UUID;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'usage_records_context_tokens_check'
      AND conrelid = 'novel.usage_records'::regclass
  ) THEN
    ALTER TABLE novel.usage_records
      ADD CONSTRAINT usage_records_context_tokens_check
      CHECK (context_tokens IS NULL OR context_tokens >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'usage_records_credit_rate_context_tier_id_fkey'
      AND conrelid = 'novel.usage_records'::regclass
  ) THEN
    ALTER TABLE novel.usage_records
      ADD CONSTRAINT usage_records_credit_rate_context_tier_id_fkey
      FOREIGN KEY (credit_rate_context_tier_id)
      REFERENCES novel.credit_rate_context_tiers(id)
      ON DELETE SET NULL;
  END IF;
END
$migration$;

WITH tier_seed(
  model_pattern, label, min_context_tokens,
  input_rate, output_rate, cache_read_rate, cache_write_rate, priority
) AS (
  VALUES
    ('claude-sonnet-4-5', 'over_200k', 200001, 0.420000, 1.575000, 0.042000, 0.525000, 100),
    ('claude-sonnet-4.5', 'over_200k', 200001, 0.420000, 1.575000, 0.042000, 0.525000, 100),
    ('gemini-3.1-pro%',   'over_200k', 200001, 0.280000, 1.260000, 0.028000, 0.000000, 100),
    ('gpt-5.4',           'over_272k', 272001, 0.350000, 1.575000, 0.035000, 0.000000, 100),
    ('gpt-5.5',           'over_272k', 272001, 0.700000, 3.150000, 0.070000, 0.000000, 100)
)
INSERT INTO novel.credit_rate_context_tiers (
  credit_rate_id, credit_rate_time_window_id, label,
  min_context_tokens, max_context_tokens,
  input_rate, output_rate, cache_read_rate, cache_write_rate,
  priority, is_active
)
SELECT
  rate.id, NULL::UUID, seed.label,
  seed.min_context_tokens, NULL::BIGINT,
  seed.input_rate, seed.output_rate, seed.cache_read_rate, seed.cache_write_rate,
  seed.priority, true
FROM novel.credit_rates AS rate
JOIN tier_seed AS seed ON seed.model_pattern = rate.model_pattern
WHERE rate.provider_pattern = 'opencode'
  AND rate.is_active = true
ON CONFLICT (credit_rate_id, credit_rate_time_window_id, min_context_tokens) DO UPDATE
SET label = EXCLUDED.label,
    max_context_tokens = EXCLUDED.max_context_tokens,
    input_rate = EXCLUDED.input_rate,
    output_rate = EXCLUDED.output_rate,
    cache_read_rate = EXCLUDED.cache_read_rate,
    cache_write_rate = EXCLUDED.cache_write_rate,
    priority = EXCLUDED.priority,
    is_active = true,
    updated_at = now();

ALTER TABLE novel.credit_rate_context_tiers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON novel.credit_rate_context_tiers FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.validate_credit_rate_context_tier_parent() FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.credit_rate_context_tiers TO project_admin;
GRANT SELECT ON novel.credit_rate_context_tiers TO authenticated, anon;

COMMIT;
