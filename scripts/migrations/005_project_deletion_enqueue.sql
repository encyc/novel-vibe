BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_deletion_jobs_active_project
  ON novel.project_deletion_jobs(project_id)
  WHERE stage <> 'complete';

CREATE OR REPLACE FUNCTION novel.enqueue_project_deletion(
  p_project_id UUID,
  p_requested_by UUID,
  p_job_id UUID,
  p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, novel
AS $function$
DECLARE
  target novel.projects%ROWTYPE;
  blocking_session_id UUID;
  existing_job_id UUID;
BEGIN
  SELECT * INTO target
  FROM novel.projects
  WHERE id = p_project_id AND owner_id = p_requested_by
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  SELECT id INTO blocking_session_id
  FROM novel.sessions
  WHERE project_id = p_project_id
    AND processing_lease_id IS NOT NULL
    AND (processing_started_at IS NULL OR processing_started_at >= p_now - INTERVAL '15 minutes')
  ORDER BY processing_started_at DESC NULLS FIRST, id
  LIMIT 1;

  IF blocking_session_id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'busy', 'sessionId', blocking_session_id);
  END IF;

  IF target.lifecycle_status <> 'trash' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'from', target.lifecycle_status);
  END IF;

  SELECT id INTO existing_job_id
  FROM novel.project_deletion_jobs
  WHERE project_id = p_project_id AND stage <> 'complete'
  ORDER BY created_at, id
  LIMIT 1;
  IF existing_job_id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'ok', 'jobId', existing_job_id);
  END IF;

  INSERT INTO novel.project_deletion_jobs (
    id, project_id, requested_by, stage, next_attempt_at, created_at, updated_at
  ) VALUES (
    p_job_id, p_project_id, p_requested_by, 'pending', p_now, p_now, p_now
  );

  RETURN jsonb_build_object('outcome', 'ok', 'jobId', p_job_id);
END
$function$;

REVOKE EXECUTE ON FUNCTION novel.enqueue_project_deletion(UUID, UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION novel.enqueue_project_deletion(UUID, UUID, UUID, TIMESTAMPTZ) TO project_admin;

COMMIT;
