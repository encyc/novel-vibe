-- Migrated verbatim from the InsForge fork backend/src/infra/database/migrations/047_create-novel-sessions.sql:
-- this is Novel Vibe application schema, so it belongs in this repository, not in the BaaS fork.
-- Prefixed 000* so run-migrations.sh applies it before 001_durable_sessions.sql.
-- Migration 047: Create Novel Vibe sessions tables
-- Lightweight session & message tables for the agent web UI.
-- Stored in novel schema alongside other novel-vibe tables.

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS novel.sessions (
  id              UUID PRIMARY KEY,
  project_id      UUID NOT NULL REFERENCES novel.projects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  messages        JSONB NOT NULL DEFAULT '[]',
  is_processing   BOOLEAN NOT NULL DEFAULT false,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON novel.sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_last_msg ON novel.sessions(last_message_at DESC);

-- ---------------------------------------------------------------------------
-- session_messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS novel.session_messages (
  id          UUID PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES novel.sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     JSONB NOT NULL DEFAULT '[]',
  model       TEXT,
  timestamp   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_msgs_session ON novel.session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_session_msgs_timestamp ON novel.session_messages(session_id, timestamp);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
GRANT ALL ON ALL TABLES IN SCHEMA novel TO project_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA novel TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA novel TO anon;
