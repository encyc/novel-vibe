-- Migrated verbatim from the InsForge fork backend/src/infra/database/migrations/051_seed-storage-buckets.sql:
-- this is Novel Vibe application schema, so it belongs in this repository, not in the BaaS fork.
-- Prefixed 000* so run-migrations.sh applies it before 001_durable_sessions.sql.
-- Seed default storage buckets for Novel Vibe.
-- "novels" stores all Markdown documents (frontmatter + body).
-- "skills" stores installed agent skill packages.

INSERT INTO storage.buckets (name, public)
VALUES ('novels', false)
ON CONFLICT DO NOTHING;

INSERT INTO storage.buckets (name, public)
VALUES ('skills', false)
ON CONFLICT DO NOTHING;
