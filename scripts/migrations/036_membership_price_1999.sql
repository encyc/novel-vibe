-- Migration 036: monthly plan price 9.90 -> 19.99 CNY.
-- Must stay idempotent AND run after 010 on full replay: 010's seed upsert
-- resets price_cents to 990 every run, this UPDATE pins the new price back.

BEGIN;

UPDATE novel.membership_plans
SET price_cents = 1990, updated_at = now()
WHERE slug = 'monthly' AND price_cents = 990;

COMMIT;
