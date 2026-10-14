BEGIN;

UPDATE novel.referral_campaigns
SET binding_ends_at = TIMESTAMPTZ '2026-12-31 23:59:59+08:00',
    updated_at = now()
WHERE slug = 'member-referral-2026'
  AND binding_ends_at IS DISTINCT FROM TIMESTAMPTZ '2026-12-31 23:59:59+08:00';

COMMIT;
