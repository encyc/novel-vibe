-- Migration 034: three new membership entitlements (continuity, premium_models,
-- community_badge) plus a batch RPC for resolving membership badges in community
-- listings. Follows the migration-020 precedent: active completed purchases
-- gain the new features automatically via snapshot backfill.

BEGIN;

-- 1. Extend the monthly plan with the new feature keys.
--    `jsonb - text` strips any existing occurrence, so the append is idempotent.
UPDATE novel.membership_plans
SET features = (features - 'continuity' - 'premium_models' - 'community_badge')
              || '["continuity", "premium_models", "community_badge"]'::jsonb,
    updated_at = now()
WHERE slug = 'monthly';

-- 2. Backfill active completed orders so existing members gain the new benefits.
UPDATE novel.membership_purchases
SET features_snapshot = (features_snapshot - 'continuity' - 'premium_models' - 'community_badge')
                       || '["continuity", "premium_models", "community_badge"]'::jsonb
WHERE payment_status = 'completed'
  AND expires_at > now();

-- 3. Batch membership resolution for community author badges.
--    get_active_membership is caller-scoped (auth.uid()), so listings that
--    render many authors need a SECURITY DEFINER set-membership lookup.
CREATE OR REPLACE FUNCTION novel.get_active_membership_user_ids(p_user_ids UUID[])
RETURNS TABLE(user_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = novel, public, pg_temp
AS $$
  SELECT DISTINCT mp.user_id
  FROM novel.membership_purchases mp
  WHERE mp.payment_status = 'completed'
    AND mp.expires_at > now()
    AND mp.user_id = ANY(p_user_ids);
$$;

REVOKE ALL ON FUNCTION novel.get_active_membership_user_ids(UUID[]) FROM PUBLIC;
-- anon needs EXECUTE: community badges render on public listing pages served
-- through DbClient.forAnon (no Authorization header → PostgREST anon role).
GRANT EXECUTE ON FUNCTION novel.get_active_membership_user_ids(UUID[]) TO anon, authenticated, project_admin, postgres;

COMMIT;
