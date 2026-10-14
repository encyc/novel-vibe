BEGIN;

-- Profiles reuse public.users (nickname/avatar_url). Existing ownership policy:
-- public.users FOR UPDATE TO authenticated USING (uid() = id).

ALTER TABLE novel.credit_purchases
  ADD COLUMN IF NOT EXISTS package_id UUID REFERENCES novel.credit_packages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS package_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS bonus_credits_snapshot NUMERIC(16,2) NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_transactions_reference_unique
  ON novel.credit_transactions(reference_type, reference_id)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_type_created
  ON novel.credit_transactions(user_id, type, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_records_user_created
  ON novel.usage_records(user_id, created_at DESC);

INSERT INTO storage.buckets (name, public)
VALUES ('avatars', true)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE novel.credit_purchases ENABLE ROW LEVEL SECURITY;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'credit_purchases_owner_select'
      AND polrelid = 'novel.credit_purchases'::regclass
  ) THEN
    CREATE POLICY credit_purchases_owner_select ON novel.credit_purchases
      FOR SELECT TO authenticated
      USING (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;

REVOKE INSERT, UPDATE, DELETE ON novel.credit_purchases FROM authenticated;
GRANT SELECT ON novel.credit_purchases TO authenticated;

CREATE OR REPLACE FUNCTION novel.list_credit_transactions_cursor(
  p_user_id UUID,
  p_type TEXT,
  p_before_created_at TIMESTAMPTZ DEFAULT NULL,
  p_before_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 21
)
RETURNS SETOF novel.credit_transactions
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = novel, public
AS $$
BEGIN
  -- SECURITY: SECURITY DEFINER bypasses RLS — verify the caller is querying their own data.
  IF p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT transaction.*
  FROM novel.credit_transactions AS transaction
  WHERE transaction.user_id = p_user_id
    AND transaction.type = p_type
    AND (
      p_before_created_at IS NULL
      OR (transaction.created_at, transaction.id) < (p_before_created_at, p_before_id)
    )
  ORDER BY transaction.created_at DESC, transaction.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 101);
END;
$$;

DROP FUNCTION IF EXISTS novel.credit_activity_by_day(UUID, INTEGER, TEXT);

CREATE OR REPLACE FUNCTION novel.credit_activity_by_day(
  p_user_id UUID,
  p_year INTEGER,
  p_timezone TEXT
)
RETURNS TABLE(activity_date DATE, credits_consumed NUMERIC(16,2), total_tokens BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = novel, public
AS $$
BEGIN
  -- SECURITY: SECURITY DEFINER bypasses RLS — verify the caller is querying their own data.
  IF p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    (record.created_at AT TIME ZONE p_timezone)::date AS activity_date,
    SUM(record.credits_consumed)::NUMERIC(16,2) AS credits_consumed,
    SUM(record.total_tokens) AS total_tokens
  FROM novel.usage_records AS record
  WHERE record.user_id = p_user_id
    AND EXTRACT(YEAR FROM record.created_at AT TIME ZONE p_timezone)::integer = p_year
  GROUP BY 1
  ORDER BY 1;
END;
$$;

CREATE OR REPLACE FUNCTION novel.complete_credit_purchase(
  p_out_trade_no TEXT,
  p_payment_id TEXT
)
RETURNS TABLE(payment_status TEXT, new_balance NUMERIC(16,2))
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = novel, public
AS $$
DECLARE
  purchase novel.credit_purchases%ROWTYPE;
  credited NUMERIC(16,2);
  balance_value NUMERIC(16,2);
BEGIN
  SELECT * INTO purchase
  FROM novel.credit_purchases
  WHERE out_trade_no = p_out_trade_no
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase not found' USING ERRCODE = 'P0002';
  END IF;

  IF purchase.payment_status = 'completed' THEN
    SELECT balance INTO balance_value
    FROM novel.credit_balances WHERE user_id = purchase.user_id;
    RETURN QUERY SELECT 'completed'::TEXT, COALESCE(balance_value, 0)::NUMERIC(16,2);
    RETURN;
  END IF;

  credited := purchase.credits + purchase.bonus_credits_snapshot;
  INSERT INTO novel.credit_balances (user_id, balance, total_granted)
  VALUES (purchase.user_id, credited, credited)
  ON CONFLICT (user_id) DO UPDATE
  SET balance = novel.credit_balances.balance + EXCLUDED.balance,
      total_granted = novel.credit_balances.total_granted + EXCLUDED.total_granted,
      updated_at = now()
  RETURNING balance INTO balance_value;

  INSERT INTO novel.credit_transactions (
    user_id, type, amount, balance_after, description,
    reference_type, reference_id, metadata
  ) VALUES (
    purchase.user_id, 'topup', credited, balance_value,
    COALESCE(purchase.package_name_snapshot, 'Credit recharge'),
    'credit_purchase', purchase.out_trade_no,
    jsonb_build_object('payment_id', p_payment_id)
  )
  ON CONFLICT (reference_type, reference_id)
    WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL
  DO NOTHING;

  UPDATE novel.credit_purchases
  SET payment_status = 'completed', payment_id = p_payment_id, completed_at = now()
  WHERE id = purchase.id;

  RETURN QUERY SELECT 'completed'::TEXT, balance_value;
END;
$$;

REVOKE ALL ON FUNCTION novel.list_credit_transactions_cursor(UUID, TEXT, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION novel.credit_activity_by_day(UUID, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION novel.complete_credit_purchase(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION novel.list_credit_transactions_cursor(UUID, TEXT, TIMESTAMPTZ, UUID, INTEGER) TO authenticated, postgres;
GRANT EXECUTE ON FUNCTION novel.credit_activity_by_day(UUID, INTEGER, TEXT) TO authenticated, postgres;
GRANT EXECUTE ON FUNCTION novel.complete_credit_purchase(TEXT, TEXT) TO postgres;

COMMIT;
