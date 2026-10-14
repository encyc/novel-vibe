BEGIN;
UPDATE novel.membership_plans SET features = features - 'byok', updated_at = now() WHERE slug = 'monthly';
COMMIT;
