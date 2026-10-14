-- Migration 039: make the pricing configuration readable by the roles the
-- Agent Server actually uses, and restore the interaction read privilege.
--
-- Three defects, all a table-privilege / RLS-policy mismatch. Privileges and
-- policies are both required: the GRANT decides whether a role may touch the
-- table at all, the policy decides which rows it sees. A missing policy is
-- worse than a missing grant because it fails silently (zero rows) instead of
-- with a 403.
--
-- 024 revoked ALL privileges on novel.credit_rate_time_windows from
-- authenticated/anon and granted them only to project_admin, but the Agent
-- Server reads pricing over PostgREST with the *user* JWT (authenticated
-- role). Every pricing refresh failed with
-- `403 permission denied for table credit_rate_time_windows`, degrading
-- peak/off-peak pricing to the stale cached snapshot.
--
-- 028 granted SELECT on novel.credit_rate_context_tiers to authenticated/anon
-- but never added an RLS policy for them, so those roles read zero rows:
-- context-tier pricing was silently ignored, with no error in the log.
--
-- 023 created a `FOR SELECT TO authenticated` policy on
-- novel.session_interactions but never issued the matching GRANT SELECT, so
-- every session message listing failed with
-- `403 permission denied for table session_interactions`.
--
-- Pricing is global platform configuration with no user data, exactly like
-- novel.credit_rates, which authenticated/anon may already read. The
-- statements are idempotent (the migration runner re-applies every file).

BEGIN;

-- ── Pricing configuration: readable by the same roles as credit_rates ──

GRANT SELECT ON novel.credit_rate_time_windows TO authenticated, anon;

DROP POLICY IF EXISTS credit_rate_time_windows_read ON novel.credit_rate_time_windows;
CREATE POLICY credit_rate_time_windows_read ON novel.credit_rate_time_windows
  FOR SELECT TO authenticated, anon USING (true);

DROP POLICY IF EXISTS credit_rate_context_tiers_read ON novel.credit_rate_context_tiers;
CREATE POLICY credit_rate_context_tiers_read ON novel.credit_rate_context_tiers
  FOR SELECT TO authenticated, anon USING (true);

-- ── Session interactions: owner-scoped policy exists; anon stays out ──

GRANT SELECT ON novel.session_interactions TO authenticated;

COMMIT;
