-- Migration 020: make web search a monthly membership entitlement.

BEGIN;

UPDATE novel.membership_plans
SET features = CASE
      WHEN features @> '["web_search"]'::jsonb THEN features
      ELSE features || '["web_search"]'::jsonb
    END,
    updated_at = now()
WHERE slug = 'monthly';

UPDATE novel.membership_purchases
SET features_snapshot = features_snapshot || '["web_search"]'::jsonb
WHERE payment_status = 'completed'
  AND expires_at > now()
  AND NOT (features_snapshot @> '["web_search"]'::jsonb);

COMMIT;
