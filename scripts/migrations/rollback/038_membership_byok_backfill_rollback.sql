BEGIN;
UPDATE novel.membership_purchases
SET features_snapshot = features_snapshot - 'byok'
WHERE payment_status = 'completed' AND expires_at > now();
COMMIT;
