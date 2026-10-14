BEGIN;
UPDATE novel.membership_plans SET price_cents = 990, updated_at = now() WHERE slug = 'monthly' AND price_cents = 1990;
COMMIT;
