-- Migration 037: grant the `byok` entitlement to the monthly plan.
-- Same replay caveat as 036: 010 resets features, this re-appends.

BEGIN;

UPDATE novel.membership_plans
SET features = features || '["byok"]'::jsonb, updated_at = now()
WHERE slug = 'monthly' AND NOT features ? 'byok';

-- Purchases made before this migration keep their feature snapshot; active
-- members get the entitlement on next purchase/renewal per product decision.

COMMIT;
