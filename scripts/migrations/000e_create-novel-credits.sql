-- Migrated verbatim from the InsForge fork backend/src/infra/database/migrations/048_create-novel-credits.sql:
-- this is Novel Vibe application schema, so it belongs in this repository, not in the BaaS fork.
-- Prefixed 000* so run-migrations.sh applies it before 001_durable_sessions.sql.
-- Migration 048: Credit billing system (merged 048+049+050)
-- Tables: credit_balances, credit_transactions, usage_records, credit_rates, level_config
-- Functions: deduct_credits, recalc_user_level
-- All amounts in NUMERIC(16,2) — 10 credits = 1 RMB

-- ---------------------------------------------------------------------------
-- 1. credit_balances — per-user credit balance (one row per user)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS novel.credit_balances (
  user_id        UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance        NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_granted  NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_consumed NUMERIC(16,2) NOT NULL DEFAULT 0,
  level          INT NOT NULL DEFAULT 0,
  multiplier     NUMERIC(4,2) NOT NULL DEFAULT 2.00,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. credit_transactions — immutable ledger of every credit change
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS novel.credit_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('grant','topup','consume','refund','expire')),
  amount          NUMERIC(16,2) NOT NULL,
  balance_after   NUMERIC(16,2) NOT NULL,
  description     TEXT,
  reference_type  TEXT,
  reference_id    TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_txn_user ON novel.credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_txn_user_created ON novel.credit_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_txn_ref ON novel.credit_transactions(reference_type, reference_id)
  WHERE reference_type IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. usage_records — per-LLM-call token usage
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS novel.usage_records (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id          UUID REFERENCES novel.projects(id) ON DELETE CASCADE,
  session_id          UUID REFERENCES novel.sessions(id) ON DELETE SET NULL,
  agent_id            TEXT NOT NULL,
  model_id            TEXT NOT NULL,
  model_provider      TEXT NOT NULL,
  input_tokens        INT NOT NULL DEFAULT 0,
  output_tokens       INT NOT NULL DEFAULT 0,
  cache_read_tokens   INT NOT NULL DEFAULT 0,
  cache_write_tokens  INT NOT NULL DEFAULT 0,
  total_tokens        INT NOT NULL DEFAULT 0,
  cost_usd            NUMERIC(12,8) NOT NULL DEFAULT 0,
  credits_consumed    NUMERIC(12,2) NOT NULL DEFAULT 0,
  credit_rate_id      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_user ON novel.usage_records(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_project ON novel.usage_records(project_id);
CREATE INDEX IF NOT EXISTS idx_usage_created ON novel.usage_records(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. credit_rates — configurable pricing (credits per 1K tokens)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS novel.credit_rates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  model_pattern     TEXT NOT NULL,
  provider_pattern  TEXT,
  input_rate        NUMERIC(10,6) NOT NULL DEFAULT 0,
  output_rate       NUMERIC(10,6) NOT NULL DEFAULT 0,
  cache_read_rate   NUMERIC(10,6) NOT NULL DEFAULT 0,
  cache_write_rate  NUMERIC(10,6) NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  priority          INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_rates_active ON novel.credit_rates(is_active, priority DESC);

-- ---------------------------------------------------------------------------
-- 5. level_config — VIP level tiers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS novel.level_config (
  level               INT PRIMARY KEY,
  name                TEXT NOT NULL,
  min_total_granted   NUMERIC(16,2) NOT NULL DEFAULT 0,
  multiplier          NUMERIC(4,2) NOT NULL,
  allowed_models      TEXT NOT NULL DEFAULT 'free',
  features            JSONB NOT NULL DEFAULT '[]',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 6. Atomic deduction function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION novel.deduct_credits(
  p_user_id       UUID,
  p_amount        NUMERIC(16,2),
  p_reference_type TEXT,
  p_reference_id   TEXT,
  p_description    TEXT,
  p_metadata       JSONB DEFAULT '{}'
)
RETURNS TABLE(success BOOLEAN, new_balance NUMERIC(16,2))
LANGUAGE plpgsql AS $$
DECLARE
  v_balance NUMERIC(16,2);
BEGIN
  UPDATE novel.credit_balances
  SET balance = balance - p_amount,
      total_consumed = total_consumed + p_amount,
      updated_at = now()
  WHERE user_id = p_user_id
  RETURNING balance INTO v_balance;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0::NUMERIC(16,2);
    RETURN;
  END IF;

  IF v_balance < 0 THEN
    UPDATE novel.credit_balances
    SET balance = balance + p_amount,
        total_consumed = total_consumed - p_amount,
        updated_at = now()
    WHERE user_id = p_user_id;

    RETURN QUERY SELECT false, (v_balance + p_amount)::NUMERIC(16,2);
    RETURN;
  END IF;

  INSERT INTO novel.credit_transactions (user_id, type, amount, balance_after, description, reference_type, reference_id, metadata)
  VALUES (p_user_id, 'consume', -p_amount, v_balance, p_description, p_reference_type, p_reference_id, p_metadata);

  RETURN QUERY SELECT true, v_balance;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. recalc_user_level — auto-upgrade level based on total_granted
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION novel.recalc_user_level(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_granted NUMERIC(16,2);
  v_level INT;
  v_multiplier NUMERIC(4,2);
BEGIN
  SELECT total_granted INTO v_granted
  FROM novel.credit_balances WHERE user_id = p_user_id;

  IF NOT FOUND THEN RETURN; END IF;

  SELECT lc.level, lc.multiplier INTO v_level, v_multiplier
  FROM novel.level_config lc
  WHERE lc.min_total_granted <= v_granted
  ORDER BY lc.min_total_granted DESC
  LIMIT 1;

  UPDATE novel.credit_balances
  SET level = v_level,
      multiplier = v_multiplier,
      updated_at = now()
  WHERE user_id = p_user_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Triggers
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_credit_balances_updated ON novel.credit_balances;
CREATE TRIGGER trg_credit_balances_updated
  BEFORE UPDATE ON novel.credit_balances
  FOR EACH ROW EXECUTE FUNCTION novel.set_updated_at();

DROP TRIGGER IF EXISTS trg_credit_rates_updated ON novel.credit_rates;
CREATE TRIGGER trg_credit_rates_updated
  BEFORE UPDATE ON novel.credit_rates
  FOR EACH ROW EXECUTE FUNCTION novel.set_updated_at();

-- ---------------------------------------------------------------------------
-- 9. Seed level config
-- ---------------------------------------------------------------------------
INSERT INTO novel.level_config (level, name, min_total_granted, multiplier, allowed_models, features) VALUES
(0, '新用户',    0,      2.00, 'free',   '[]'),
(1, '普通会员',  100,    1.90, 'all',    '["skills"]'),
(2, '银卡会员',  500,    1.80, 'all',    '["skills"]'),
(3, '金卡会员',  2000,   1.70, 'all',    '["skills","mcp"]'),
(4, '铂金会员',  5000,   1.60, 'all',    '["skills","mcp","advanced_models"]'),
(5, '钻石会员',  10000,  1.50, 'all',    '["skills","mcp","advanced_models","priority"]')
ON CONFLICT (level) DO UPDATE SET
  name = EXCLUDED.name,
  min_total_granted = EXCLUDED.min_total_granted,
  multiplier = EXCLUDED.multiplier,
  allowed_models = EXCLUDED.allowed_models,
  features = EXCLUDED.features;

-- ---------------------------------------------------------------------------
-- 10. Seed model pricing (credits/RMB per 1K tokens)
-- Prices per 1M tokens (RMB) → divided by 1000 for per-1K rate
-- DeepSeek: direct pricing. Others via opencode.
-- ---------------------------------------------------------------------------
--
-- Replay guard (added when this file moved into the novel-vibe repo):
-- scripts/run-migrations.sh has no version ledger and re-applies every file on
-- every deploy. novel.credit_rates has NO unique constraint (only the surrogate
-- `id` primary key), so the `ON CONFLICT DO NOTHING` clauses below can never
-- actually conflict — an unguarded replay appends a second copy of the whole
-- catalog each time (measured on a clean DB: +51 rows per run). Seed the base
-- catalog only when it is empty; the first run inserts exactly the same rows as
-- this file did before the guard was added, including the pre-existing duplicate
-- 'Claude Sonnet 4' entry.
DO $seed_credit_rates$
BEGIN
  IF EXISTS (SELECT 1 FROM novel.credit_rates) THEN
    RETURN;
  END IF;

-- Free models (priority 100)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('Big Pickle (Free)', 'big-pickle', 'opencode', 0, 0, 0, 0, 100),
('Nemotron 3 Super (Free)', 'nemotron-3-super-free', 'opencode', 0, 0, 0, 0, 100)
ON CONFLICT DO NOTHING;

-- DeepSeek V4 Flash (input=0.200000, cache=1, output=2 per 1M RMB)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('DeepSeek V4 Flash', 'deepseek-v4-flash', 'deepseek',     0.000200, 0.020000, 0.010000, 0.010000, 50),
('DeepSeek V4 Flash (Free)', 'deepseek-v4-flash-free', 'opencode', 0, 0, 0, 0, 100)
ON CONFLICT DO NOTHING;

-- DeepSeek V4 Pro (input=0.250000, cache=3, output=6 per 1M RMB)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('DeepSeek V4 Pro', 'deepseek-v4-pro', 'deepseek',     0.000250, 0.060000, 0.030000, 0.030000, 50),
('DeepSeek V4 Pro', 'deepseek-v4-pro', 'opencode', 0.000250, 0.060000, 0.030000, 0.030000, 50)
ON CONFLICT DO NOTHING;

-- MiniMax (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('MiniMax M2.7', 'minimax-m2.7', 'opencode', 0.021000, 0.084000, 0.004200, 0.026250, 10),
('MiniMax M2.5', 'minimax-m2.5', 'opencode', 0.021000, 0.084000, 0.004200, 0.026250, 10)
ON CONFLICT DO NOTHING;

-- GLM (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('GLM 5.1', 'glm-5.1', 'opencode', 0.098000, 0.308000, 0.018200, 0, 10),
('GLM 5', 'glm-5', 'opencode', 0.070000, 0.224000, 0.014000, 0, 10)
ON CONFLICT DO NOTHING;

-- Kimi (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('Kimi K2.5', 'kimi-k2.5', 'opencode', 0.042000, 0.210000, 0.007000, 0, 10),
('Kimi K2.6', 'kimi-k2.6', 'opencode', 0.066500, 0.280000, 0.011200, 0, 10)
ON CONFLICT DO NOTHING;

-- Qwen (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('Qwen 3.6 Plus', 'qwen3.6-plus', 'opencode', 0.035000, 0.210000, 0.003500, 0.043750, 10),
('Qwen 3.5 Plus', 'qwen3.5-plus', 'opencode', 0.014000, 0.084000, 0.001400, 0.017500, 10)
ON CONFLICT DO NOTHING;

-- Grok (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('Grok Build 0.1', 'grok-build%', 'opencode', 0.070000, 0.140000, 0.014000, 0, 10)
ON CONFLICT DO NOTHING;

-- Claude Opus (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('Claude Opus 4.7', 'claude-opus-4-7', 'opencode', 0.350000, 1.750000, 0.035000, 0.437500, 20),
('Claude Opus 4.7', 'claude-opus-4.7', 'opencode', 0.350000, 1.750000, 0.035000, 0.437500, 20),
('Claude Opus 4.6', 'claude-opus-4-6', 'opencode', 0.350000, 1.750000, 0.035000, 0.437500, 20),
('Claude Opus 4.6', 'claude-opus-4.6', 'opencode', 0.350000, 1.750000, 0.035000, 0.437500, 20),
('Claude Opus 4.5', 'claude-opus-4-5', 'opencode', 0.350000, 1.750000, 0.035000, 0.437500, 20),
('Claude Opus 4.5', 'claude-opus-4.5', 'opencode', 0.350000, 1.750000, 0.035000, 0.437500, 20),
('Claude Opus 4.1', 'claude-opus-4-1', 'opencode', 1.050000, 5.250000, 0.105000, 1.312500, 20),
('Claude Opus 4.1', 'claude-opus-4.1', 'opencode', 1.050000, 5.250000, 0.105000, 1.312500, 20)
ON CONFLICT DO NOTHING;

-- Claude Sonnet (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('Claude Sonnet 4.6', 'claude-sonnet-4-6', 'opencode', 0.210000, 1.050000, 0.021000, 0.262500, 20),
('Claude Sonnet 4.6', 'claude-sonnet-4.6', 'opencode', 0.210000, 1.050000, 0.021000, 0.262500, 20),
('Claude Sonnet 4.5', 'claude-sonnet-4-5', 'opencode', 0.210000, 1.050000, 0.021000, 0.262500, 20),
('Claude Sonnet 4.5', 'claude-sonnet-4.5', 'opencode', 0.210000, 1.050000, 0.021000, 0.262500, 20),
('Claude Sonnet 4', 'claude-sonnet-4-%', 'opencode', 0.210000, 1.050000, 0.021000, 0.262500, 20),
('Claude Sonnet 4', 'claude-sonnet-4-%', 'opencode', 0.210000, 1.050000, 0.021000, 0.262500, 20)
ON CONFLICT DO NOTHING;

-- Claude Haiku (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('Claude Haiku 4.5', 'claude-haiku-4%', 'opencode', 0.070000, 0.350000, 0.007000, 0.087500, 20)
ON CONFLICT DO NOTHING;

-- Gemini (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('Gemini 3.5 Flash', 'gemini-3.5-flash%', 'opencode', 0.105000, 0.630000, 0.010500, 0, 10),
('Gemini 3.1 Pro', 'gemini-3.1-pro%', 'opencode', 0.140000, 0.840000, 0.014000, 0, 10),
('Gemini 3 Flash', 'gemini-3-flash%', 'opencode', 0.035000, 0.210000, 0.003500, 0, 10)
ON CONFLICT DO NOTHING;

-- GPT 55.000000 (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('GPT 5.5 Pro', 'gpt-5.5-pro', 'opencode', 2.100000, 12.600000, 2.100000, 0, 20),
('GPT 5.5', 'gpt-5.5', 'opencode', 0.350000, 2.100000, 0.035000, 0, 10)
ON CONFLICT DO NOTHING;

-- GPT 54.000000 (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('GPT 5.4 Pro', 'gpt-5.4-pro', 'opencode', 2.100000, 12.600000, 2.100000, 0, 20),
('GPT 5.4', 'gpt-5.4', 'opencode', 0.175000, 1.050000, 0.017500, 0, 10),
('GPT 5.4 Mini', 'gpt-5.4-mini', 'opencode', 0.052500, 0.315000, 0.005250, 0, 10),
('GPT 5.4 Nano', 'gpt-5.4-nano', 'opencode', 0.014000, 0.087500, 0.001400, 0, 10)
ON CONFLICT DO NOTHING;

-- GPT 53.000000 (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('GPT 5.3 Codex Spark', 'gpt-5.3-codex-spark', 'opencode', 0.122500, 0.980000, 0.012250, 0, 10),
('GPT 5.3 Codex', 'gpt-5.3-codex', 'opencode', 0.122500, 0.980000, 0.012250, 0, 10)
ON CONFLICT DO NOTHING;

-- GPT 52.000000 (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('GPT 5.2 Codex', 'gpt-5.2-codex', 'opencode', 0.122500, 0.980000, 0.012250, 0, 10),
('GPT 5.2', 'gpt-5.2', 'opencode', 0.122500, 0.980000, 0.012250, 0, 10)
ON CONFLICT DO NOTHING;

-- GPT 51.000000 (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('GPT 5.1 Codex Max', 'gpt-5.1-codex-max', 'opencode', 0.087500, 0.700000, 0.008750, 0, 10),
('GPT 5.1 Codex', 'gpt-5.1-codex-%', 'opencode', 0.074900, 0.595000, 0.007490, 0, 10),
('GPT 5.1 Codex Mini', 'gpt-5.1-codex-mini', 'opencode', 0.017500, 0.140000, 0.001750, 0, 10),
('GPT 5.1', 'gpt-5.1', 'opencode', 0.074900, 0.595000, 0.007490, 0, 10)
ON CONFLICT DO NOTHING;

-- GPT 5 (via opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority) VALUES
('GPT 5 Codex', 'gpt-5-codex', 'opencode', 0.074900, 0.595000, 0.007490, 0, 10),
('GPT 5', 'gpt-5', 'opencode', 0.074900, 0.595000, 0.007490, 0, 10),
('GPT 5 Nano', 'gpt-5-nano', 'opencode', 0.003500, 0.028000, 0.000350, 0, 10)
ON CONFLICT DO NOTHING;

-- Catch-all default (lowest priority, opencode)
INSERT INTO novel.credit_rates (name, model_pattern, provider_pattern, input_rate, output_rate, cache_read_rate, cache_write_rate, priority)
VALUES ('Default rate', '%', 'opencode', 0.070000, 0.350000, 0.007000, 0.043750, 0)
ON CONFLICT DO NOTHING;

END
$seed_credit_rates$;

-- ---------------------------------------------------------------------------
-- 11. Grants
-- ---------------------------------------------------------------------------
GRANT ALL ON ALL TABLES IN SCHEMA novel TO project_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA novel TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA novel TO anon;
GRANT EXECUTE ON FUNCTION novel.deduct_credits(UUID, NUMERIC, TEXT, TEXT, TEXT, JSONB) TO project_admin, authenticated;
GRANT EXECUTE ON FUNCTION novel.recalc_user_level(UUID) TO project_admin, authenticated;
