-- Migrated verbatim from the InsForge fork backend/src/infra/database/migrations/053_skill-slug-per-user-namespace.sql:
-- this is Novel Vibe application schema, so it belongs in this repository, not in the BaaS fork.
-- Prefixed 000* so run-migrations.sh applies it before 001_durable_sessions.sql.
-- Migration: per-user skill slug namespace
--
-- skill_registry.slug was globally UNIQUE (added in 045), which blocks a
-- multi-tenant SaaS use case: two users cannot each install the same
-- open-source skill (e.g. both install "writing-style") because the second
-- insert violates the unique constraint.
--
-- Drop the global uniqueness and replace it with per-owner uniqueness:
--   * each non-null user has unique slugs among their own skills
--   * built-in skills (user_id IS NULL) remain unique among themselves
-- Storage object isolation is already enforced by RLS (uploaded_by = sub);
-- this migration only fixes the catalog-level namespace.

ALTER TABLE public.skill_registry
  DROP CONSTRAINT IF EXISTS skill_registry_slug_key;

CREATE UNIQUE INDEX IF NOT EXISTS skill_registry_user_slug_key
  ON public.skill_registry (user_id, slug)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS skill_registry_builtin_slug_key
  ON public.skill_registry (slug)
  WHERE user_id IS NULL;
