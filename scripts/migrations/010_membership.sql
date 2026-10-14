-- Migration 010: Monthly card membership system.
-- Tables: membership_plans (catalog), membership_purchases (orders).
-- Functions: complete_membership_purchase, get_active_membership.
-- Orthogonal to credit_balances and level_config.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. membership_plans — purchasable membership tiers (catalog)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS novel.membership_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  price_cents     INTEGER NOT NULL,
  duration_days   INTEGER NOT NULL,
  bonus_credits   NUMERIC(16,2) NOT NULL DEFAULT 0,
  features        JSONB NOT NULL DEFAULT '[]',
  currency        TEXT NOT NULL DEFAULT 'CNY',
  display_order   INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  is_featured     BOOLEAN NOT NULL DEFAULT false,
  valid_from      TIMESTAMPTZ DEFAULT now(),
  valid_until     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. membership_purchases — Z-Pay orders, all entitlement fields snapshotted
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS novel.membership_purchases (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL,
  out_trade_no             TEXT NOT NULL UNIQUE,
  plan_id                  UUID REFERENCES novel.membership_plans(id) ON DELETE SET NULL,
  plan_name_snapshot       TEXT NOT NULL,
  price_cents              INTEGER NOT NULL,
  duration_days_snapshot   INTEGER NOT NULL,
  bonus_credits_snapshot   NUMERIC(16,2) NOT NULL DEFAULT 0,
  features_snapshot        JSONB NOT NULL DEFAULT '[]',
  payment_provider         TEXT NOT NULL DEFAULT 'zpay',
  payment_id               TEXT,
  payment_status           TEXT NOT NULL DEFAULT 'pending',
  source                   TEXT NOT NULL DEFAULT 'purchase' CHECK (source IN ('purchase', 'gift')),
  expires_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_membership_purchases_user ON novel.membership_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_membership_purchases_trade_no ON novel.membership_purchases(out_trade_no);
CREATE INDEX IF NOT EXISTS idx_membership_purchases_status_expiry
  ON novel.membership_purchases(user_id, payment_status, expires_at DESC);

-- source column distinguishes purchase vs admin gift; added after initial deploy
ALTER TABLE novel.membership_purchases ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'purchase';
-- Re-validate constraint in case column existed but without the CHECK
DO $$ BEGIN
  ALTER TABLE novel.membership_purchases ADD CONSTRAINT membership_purchases_source_check
    CHECK (source IN ('purchase', 'gift')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE novel.membership_purchases VALIDATE CONSTRAINT membership_purchases_source_check;

-- ---------------------------------------------------------------------------
-- 3. RLS — owner can only SELECT their own purchases
-- ---------------------------------------------------------------------------
ALTER TABLE novel.membership_purchases ENABLE ROW LEVEL SECURITY;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'membership_purchases_owner_select'
      AND polrelid = 'novel.membership_purchases'::regclass
  ) THEN
    CREATE POLICY membership_purchases_owner_select ON novel.membership_purchases
      FOR SELECT TO authenticated
      USING (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;

REVOKE INSERT, UPDATE, DELETE ON novel.membership_purchases FROM authenticated;
GRANT SELECT ON novel.membership_purchases TO authenticated;
GRANT SELECT ON novel.membership_plans TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. complete_membership_purchase — atomic, idempotent, stacking expiry
-- Migrations replay in numeric order on every deploy, and 032 replaces this
-- function with a wider return row (referral columns). CREATE OR REPLACE
-- cannot change a return type, so drop first; 032 then reinstalls its version.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS novel.complete_membership_purchase(TEXT, TEXT);
CREATE OR REPLACE FUNCTION novel.complete_membership_purchase(
  p_out_trade_no TEXT,
  p_payment_id   TEXT
)
RETURNS TABLE(payment_status TEXT, expires_at TIMESTAMPTZ, bonus_credited NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = novel, public
AS $$
DECLARE
  purchase novel.membership_purchases%ROWTYPE;
  v_current_max TIMESTAMPTZ;
  v_new_expires TIMESTAMPTZ;
  v_balance NUMERIC(16,2);
  v_bonus NUMERIC(16,2);
BEGIN
  SELECT * INTO purchase
  FROM novel.membership_purchases
  WHERE out_trade_no = p_out_trade_no
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase not found' USING ERRCODE = 'P0002';
  END IF;

  -- Idempotent: already completed orders return their existing state.
  IF purchase.payment_status = 'completed' THEN
    RETURN QUERY SELECT 'completed'::TEXT, purchase.expires_at, 0::NUMERIC;
    RETURN;
  END IF;

  -- Stacking expiry: new_expires = max(now(), current_max_completed) + duration
  SELECT max(mp.expires_at) INTO v_current_max
  FROM novel.membership_purchases mp
  WHERE mp.user_id = purchase.user_id AND mp.payment_status = 'completed';

  v_new_expires := greatest(now(), COALESCE(v_current_max, now()))
    + (purchase.duration_days_snapshot || ' days')::interval;

  UPDATE novel.membership_purchases
  SET expires_at = v_new_expires,
      payment_status = 'completed',
      payment_id = p_payment_id,
      completed_at = now()
  WHERE id = purchase.id;

  -- Bonus credits reuse the credit_balances / credit_transactions ledger.
  -- The existing idx_credit_transactions_reference_unique makes this idempotent.
  v_bonus := purchase.bonus_credits_snapshot;
  IF v_bonus > 0 THEN
    INSERT INTO novel.credit_balances (user_id, balance, total_granted)
    VALUES (purchase.user_id, v_bonus, v_bonus)
    ON CONFLICT (user_id) DO UPDATE
    SET balance = novel.credit_balances.balance + EXCLUDED.balance,
        total_granted = novel.credit_balances.total_granted + EXCLUDED.total_granted,
        updated_at = now()
    RETURNING balance INTO v_balance;

    INSERT INTO novel.credit_transactions (
      user_id, type, amount, balance_after, description,
      reference_type, reference_id, metadata
    ) VALUES (
      purchase.user_id, 'topup', v_bonus, v_balance,
      COALESCE(purchase.plan_name_snapshot, 'Membership bonus'),
      'membership_purchase', purchase.out_trade_no,
      jsonb_build_object('payment_id', p_payment_id)
    )
    ON CONFLICT (reference_type, reference_id)
      WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL
    DO NOTHING;
  END IF;

  RETURN QUERY SELECT 'completed'::TEXT, v_new_expires, v_bonus;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. get_active_membership — caller-scoped current status
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION novel.get_active_membership(p_user_id UUID)
RETURNS TABLE(
  plan_name TEXT,
  features JSONB,
  expires_at TIMESTAMPTZ,
  active BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = novel, public
AS $$
DECLARE
  latest_row RECORD;
BEGIN
  IF p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  SELECT mp.plan_name_snapshot, mp.features_snapshot, mp.expires_at
  INTO latest_row
  FROM novel.membership_purchases mp
  WHERE mp.user_id = p_user_id AND mp.payment_status = 'completed'
  ORDER BY mp.expires_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::TEXT, '[]'::JSONB, NULL::TIMESTAMPTZ, false;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    latest_row.plan_name_snapshot,
    latest_row.features_snapshot,
    latest_row.expires_at,
    (latest_row.expires_at > now()) AS active;
END;
$$;

REVOKE ALL ON FUNCTION novel.complete_membership_purchase(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION novel.get_active_membership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION novel.complete_membership_purchase(TEXT, TEXT) TO postgres;
GRANT EXECUTE ON FUNCTION novel.get_active_membership(UUID) TO authenticated, postgres;

-- ---------------------------------------------------------------------------
-- 6. Triggers + seed
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_membership_plans_updated ON novel.membership_plans;
CREATE TRIGGER trg_membership_plans_updated
  BEFORE UPDATE ON novel.membership_plans
  FOR EACH ROW EXECUTE FUNCTION novel.set_updated_at();

INSERT INTO novel.membership_plans
  (slug, name, description, price_cents, duration_days, bonus_credits, features, display_order, is_active, is_featured)
VALUES
  ('monthly', '月卡会员', '解锁无限项目 + 全文导出，并赠送 100 Credits', 990, 30, 100,
   '["unlimited_projects","export"]', 1, true, true)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_cents = EXCLUDED.price_cents,
  duration_days = EXCLUDED.duration_days,
  bonus_credits = EXCLUDED.bonus_credits,
  features = EXCLUDED.features,
  display_order = EXCLUDED.display_order,
  is_active = EXCLUDED.is_active,
  is_featured = EXCLUDED.is_featured,
  updated_at = now();

COMMIT;
