-- Migrated verbatim from the InsForge fork backend/src/infra/database/migrations/045_create-skills-tables.sql:
-- this is Novel Vibe application schema, so it belongs in this repository, not in the BaaS fork.
-- Prefixed 000* so run-migrations.sh applies it before 001_durable_sessions.sql.
-- Migration: Create skills management tables
-- skill_registry: Global skill catalog (cross-project)
-- workspace_skills: Per-workspace skill enable/disable toggle

CREATE TABLE IF NOT EXISTS public.skill_registry (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  storage_path TEXT NOT NULL,
  version      TEXT NOT NULL DEFAULT '1.0.0',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skill_registry_slug ON public.skill_registry(slug);

CREATE TABLE IF NOT EXISTS public.workspace_skills (
  workspace_id TEXT NOT NULL,
  skill_slug   TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, skill_slug)
);

CREATE INDEX IF NOT EXISTS idx_workspace_skills_ws ON public.workspace_skills(workspace_id);
