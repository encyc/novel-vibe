BEGIN;

CREATE TABLE IF NOT EXISTS novel.continuity_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES novel.projects(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL CHECK (chapter_number > 0),
  chapter_path TEXT NOT NULL CHECK (chapter_path <> ''),
  confirmed_hash TEXT NOT NULL CHECK (confirmed_hash <> ''),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (project_id, chapter_path, confirmed_hash)
);

CREATE INDEX IF NOT EXISTS idx_continuity_jobs_due
  ON novel.continuity_jobs(next_attempt_at, created_at)
  WHERE status IN ('pending', 'running');

CREATE OR REPLACE FUNCTION novel.claim_continuity_jobs(
  p_now TIMESTAMPTZ,
  p_limit INTEGER,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS SETOF novel.continuity_jobs
LANGUAGE sql
SECURITY DEFINER
SET search_path = novel, pg_temp
AS $function$
  WITH candidates AS (
    SELECT job.id
    FROM novel.continuity_jobs AS job
    WHERE job.next_attempt_at <= p_now
      AND (
        job.status = 'pending'
        OR (job.status = 'running' AND job.lease_expires_at <= p_now)
      )
    ORDER BY job.next_attempt_at, job.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(p_limit, 0)
  )
  UPDATE novel.continuity_jobs AS job
  SET status = 'running',
      attempts = job.attempts + 1,
      lease_id = gen_random_uuid(),
      lease_expires_at = p_now + make_interval(secs => GREATEST(p_lease_seconds, 1)),
      updated_at = p_now
  FROM candidates
  WHERE job.id = candidates.id
  RETURNING job.*;
$function$;

ALTER TABLE novel.continuity_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS continuity_jobs_owner_select ON novel.continuity_jobs;
CREATE POLICY continuity_jobs_owner_select ON novel.continuity_jobs
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM novel.projects p
    WHERE p.id = project_id AND p.owner_id = auth.uid()
  ));

DROP POLICY IF EXISTS continuity_jobs_owner_insert ON novel.continuity_jobs;
CREATE POLICY continuity_jobs_owner_insert ON novel.continuity_jobs
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM novel.projects p
    WHERE p.id = project_id AND p.owner_id = auth.uid() AND p.lifecycle_status = 'active'
  ));

REVOKE ALL ON novel.continuity_jobs FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION novel.claim_continuity_jobs(TIMESTAMPTZ, INTEGER, INTEGER)
  FROM PUBLIC, authenticated, anon;
GRANT SELECT, INSERT ON novel.continuity_jobs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.continuity_jobs TO project_admin;
GRANT EXECUTE ON FUNCTION novel.claim_continuity_jobs(TIMESTAMPTZ, INTEGER, INTEGER)
  TO project_admin;

COMMIT;
