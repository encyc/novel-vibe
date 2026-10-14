-- Migrated verbatim from the InsForge fork backend/src/infra/database/migrations/049_create-credit-purchases.sql:
-- this is Novel Vibe application schema, so it belongs in this repository, not in the BaaS fork.
-- Prefixed 000* so run-migrations.sh applies it before 001_durable_sessions.sql.
-- Credit purchases table for tracking Z-Pay payment orders.
-- Each row represents a single recharge attempt (pending → completed).

CREATE TABLE IF NOT EXISTS novel.credit_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  out_trade_no TEXT NOT NULL UNIQUE,
  credits NUMERIC NOT NULL,
  price_cents INTEGER NOT NULL,
  payment_provider TEXT NOT NULL DEFAULT 'zpay',
  payment_id TEXT,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_credit_purchases_user ON novel.credit_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_purchases_trade_no ON novel.credit_purchases(out_trade_no);
