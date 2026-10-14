-- Migration 038: backfill the `byok` entitlement into ACTIVE membership
-- purchases. 037 only updated the plan catalog; snapshots are frozen at
-- purchase time, so existing members would not see BYOK until renewal.
-- Precedent: 034 backfilled its new entitlements the same way.

BEGIN;

UPDATE novel.membership_purchases
SET features_snapshot = features_snapshot || '["byok"]'::jsonb
WHERE payment_status = 'completed'
  AND expires_at > now()
  AND NOT features_snapshot ? 'byok';

COMMIT;
