-- Migrated verbatim from the InsForge fork backend/src/infra/database/migrations/050_create-credit-packages.sql:
-- this is Novel Vibe application schema, so it belongs in this repository, not in the BaaS fork.
-- Prefixed 000* so run-migrations.sh applies it before 001_durable_sessions.sql.
-- Credit recharge packages.
-- Each row defines a purchasable package with price, credits, and optional bonus.

CREATE TABLE IF NOT EXISTS novel.credit_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL,
  credits NUMERIC NOT NULL DEFAULT 0,
  bonus_credits NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_featured BOOLEAN NOT NULL DEFAULT false,
  valid_from TIMESTAMPTZ DEFAULT now(),
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credit_packages_name_key UNIQUE (name)
);

-- Seed initial packages (idempotent upsert)
INSERT INTO novel.credit_packages (name, description, price_cents, credits, bonus_credits, display_order, is_active, is_featured) VALUES
  ('尝鲜包', '体验一下灵器 AI',    100,   10,   0, 1, true, false),
  ('基础包', '日常创作必备',       2000,  200,  50, 2, true, false),
  ('日常包', '高频创作首选',       5000,  500, 150, 3, true, true),
  ('进阶包', '专业写手推荐',      10000, 1000, 400, 4, true, false)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  price_cents = EXCLUDED.price_cents,
  credits = EXCLUDED.credits,
  bonus_credits = EXCLUDED.bonus_credits,
  display_order = EXCLUDED.display_order,
  is_active = EXCLUDED.is_active,
  is_featured = EXCLUDED.is_featured,
  updated_at = now();
