-- Migrated verbatim from the InsForge fork backend/src/infra/database/migrations/044_create-novel-vibe-schema.sql:
-- this is Novel Vibe application schema, so it belongs in this repository, not in the BaaS fork.
-- Prefixed 000* so run-migrations.sh applies it before 001_durable_sessions.sql.
-- Migration 044: Create Novel Vibe tables
-- Lightweight index tables for multi-agent novel generation project.
-- Content lives in InsForge Storage (S3) as Markdown files with YAML frontmatter.
-- DB stores only parsed metadata for querying and statistics.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS novel;

-- ---------------------------------------------------------------------------
-- projects: Novel projects (top-level entity)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS novel.projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  genre         TEXT,
  synopsis      TEXT,
  status        TEXT NOT NULL DEFAULT 'planning',
  storage_path  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON novel.projects(owner_id);

-- ---------------------------------------------------------------------------
-- document_index: Parsed YAML frontmatter metadata from Markdown files
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS novel.document_index (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES novel.projects(id) ON DELETE CASCADE,
  doc_path      TEXT NOT NULL,
  doc_type      TEXT NOT NULL,
  name          TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  chapter_num   INT,
  volume_num    INT,
  meta          JSONB NOT NULL DEFAULT '{}',
  word_count    INT,
  checksum      TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, doc_path)
);

CREATE INDEX IF NOT EXISTS idx_doc_type    ON novel.document_index(project_id, doc_type);
CREATE INDEX IF NOT EXISTS idx_doc_status  ON novel.document_index(project_id, status);
CREATE INDEX IF NOT EXISTS idx_doc_chapter ON novel.document_index(project_id, chapter_num)
  WHERE chapter_num IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_doc_meta    ON novel.document_index USING gin(meta);

-- ---------------------------------------------------------------------------
-- agent_tasks: Track tasks assigned to sub-agents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS novel.agent_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES novel.projects(id) ON DELETE CASCADE,
  session_id      TEXT,
  agent           TEXT NOT NULL,
  parent_task_id  UUID REFERENCES novel.agent_tasks(id),
  task_type       TEXT NOT NULL,
  description     TEXT,
  input_refs      JSONB NOT NULL DEFAULT '[]',
  output_path     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  reviewed_by     UUID REFERENCES auth.users(id),
  review_note     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON novel.agent_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON novel.agent_tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_agent   ON novel.agent_tasks(project_id, agent);

-- ---------------------------------------------------------------------------
-- foreshadow_index: Structured foreshadowing tracker
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS novel.foreshadow_index (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES novel.projects(id) ON DELETE CASCADE,
  foreshadow_id     TEXT NOT NULL,
  doc_path          TEXT NOT NULL,
  description       TEXT,
  importance        INT NOT NULL DEFAULT 5,
  plant_chapter     INT,
  planned_resolve   INT,
  actual_resolve    INT,
  status            TEXT NOT NULL DEFAULT 'planned',
  UNIQUE(project_id, foreshadow_id)
);

CREATE INDEX IF NOT EXISTS idx_fs_status ON novel.foreshadow_index(project_id, status);
CREATE INDEX IF NOT EXISTS idx_fs_plant  ON novel.foreshadow_index(project_id, plant_chapter);

-- ---------------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION novel.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_projects_updated ON novel.projects;

CREATE TRIGGER trg_projects_updated
  BEFORE UPDATE ON novel.projects
  FOR EACH ROW EXECUTE FUNCTION novel.set_updated_at();

DROP TRIGGER IF EXISTS trg_document_index_updated ON novel.document_index;

CREATE TRIGGER trg_document_index_updated
  BEFORE UPDATE ON novel.document_index
  FOR EACH ROW EXECUTE FUNCTION novel.set_updated_at();

-- ---------------------------------------------------------------------------
-- Grant access to authenticated users (RLS will be added later)
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA novel TO authenticated, anon, project_admin;
GRANT ALL ON ALL TABLES IN SCHEMA novel TO project_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA novel TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA novel TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA novel TO authenticated, anon, project_admin;
