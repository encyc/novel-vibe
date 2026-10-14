BEGIN;

ALTER TABLE novel.projects
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS writing_stage TEXT,
  ADD COLUMN IF NOT EXISTS pre_trash_status TEXT,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'novel' AND table_name = 'projects' AND column_name = 'status'
  ) THEN
    UPDATE novel.projects
    SET writing_stage = CASE
      WHEN status IN ('planning', 'drafting', 'revising', 'completed') THEN status
      ELSE 'planning'
    END
    WHERE writing_stage IS NULL;
  ELSE
    UPDATE novel.projects SET writing_stage = 'planning' WHERE writing_stage IS NULL;
  END IF;
END
$migration$;

ALTER TABLE novel.projects
  ALTER COLUMN writing_stage SET DEFAULT 'planning',
  ALTER COLUMN writing_stage SET NOT NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'projects_lifecycle_status_check'
      AND conrelid = 'novel.projects'::regclass
  ) THEN
    ALTER TABLE novel.projects ADD CONSTRAINT projects_lifecycle_status_check
      CHECK (lifecycle_status IN ('active', 'archived', 'trash'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'projects_writing_stage_check'
      AND conrelid = 'novel.projects'::regclass
  ) THEN
    ALTER TABLE novel.projects ADD CONSTRAINT projects_writing_stage_check
      CHECK (writing_stage IN ('planning', 'drafting', 'revising', 'completed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'projects_pre_trash_status_check'
      AND conrelid = 'novel.projects'::regclass
  ) THEN
    ALTER TABLE novel.projects ADD CONSTRAINT projects_pre_trash_status_check
      CHECK (pre_trash_status IS NULL OR pre_trash_status IN ('active', 'archived'));
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS idx_projects_owner_lifecycle_activity
  ON novel.projects(owner_id, lifecycle_status, last_activity_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_projects_purge_after
  ON novel.projects(purge_after)
  WHERE lifecycle_status = 'trash';

ALTER TABLE novel.sessions
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_lifecycle_status_check'
      AND conrelid = 'novel.sessions'::regclass
  ) THEN
    ALTER TABLE novel.sessions ADD CONSTRAINT sessions_lifecycle_status_check
      CHECK (lifecycle_status IN ('active', 'archived'));
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS idx_sessions_project_lifecycle_message
  ON novel.sessions(project_id, lifecycle_status, last_message_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.project_skills (
  project_id UUID NOT NULL REFERENCES novel.projects(id) ON DELETE CASCADE,
  skill_slug TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, skill_slug)
);

CREATE INDEX IF NOT EXISTS idx_project_skills_project
  ON public.project_skills(project_id);

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'workspace_skills'
  ) THEN
    INSERT INTO public.project_skills (project_id, skill_slug, enabled, created_at)
    SELECT workspace_id::uuid, skill_slug, enabled, created_at
    FROM public.workspace_skills
    WHERE workspace_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND EXISTS (
        SELECT 1 FROM novel.projects WHERE id = workspace_id::uuid
      )
    ON CONFLICT (project_id, skill_slug) DO NOTHING;
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS novel.project_deletion_jobs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'pending'
    CHECK (stage IN (
      'pending', 'excluding_memory', 'deleting_storage',
      'deleting_database', 'complete', 'failed'
    )),
  resume_stage TEXT CHECK (resume_stage IS NULL OR resume_stage IN (
    'pending', 'excluding_memory', 'deleting_storage', 'deleting_database'
  )),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_deletion_jobs_claim
  ON novel.project_deletion_jobs(stage, next_attempt_at, created_at, id)
  WHERE stage IN ('pending', 'failed');

DO $migration$
DECLARE
  current_delete_rule TEXT;
BEGIN
  SELECT rc.delete_rule INTO current_delete_rule
  FROM information_schema.referential_constraints rc
  WHERE rc.constraint_schema = 'novel'
    AND rc.constraint_name = 'usage_records_project_id_fkey';

  IF current_delete_rule IS DISTINCT FROM 'SET NULL' THEN
    ALTER TABLE novel.usage_records DROP CONSTRAINT IF EXISTS usage_records_project_id_fkey;
    ALTER TABLE novel.usage_records ADD CONSTRAINT usage_records_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES novel.projects(id) ON DELETE SET NULL;
  END IF;
END
$migration$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_skills TO authenticated;
GRANT ALL ON public.project_skills TO project_admin;
GRANT SELECT ON novel.project_deletion_jobs TO authenticated;
GRANT ALL ON novel.project_deletion_jobs TO project_admin;

COMMIT;
