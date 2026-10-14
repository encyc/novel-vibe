BEGIN;

CREATE OR REPLACE FUNCTION novel.freeze_project_for_deletion(p_job_id UUID, p_project_id UUID, p_now TIMESTAMPTZ DEFAULT now())
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, novel AS $function$
BEGIN
  PERFORM 1 FROM novel.projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM novel.project_deletion_jobs WHERE id = p_job_id AND project_id = p_project_id AND stage = 'pending'
  ) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM novel.memory_jobs WHERE project_id = p_project_id AND status = 'running') THEN RETURN false; END IF;
  UPDATE novel.memory_jobs SET status = 'cancelled', updated_at = p_now
    WHERE project_id = p_project_id AND status IN ('pending', 'failed');
  UPDATE novel.projects SET purge_after = NULL WHERE id = p_project_id;
  RETURN true;
END $function$;

CREATE OR REPLACE FUNCTION novel.claim_project_deletion_jobs(p_now TIMESTAMPTZ, p_limit INTEGER)
RETURNS SETOF novel.project_deletion_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, novel AS $function$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT id FROM novel.project_deletion_jobs
    WHERE stage NOT IN ('complete') AND next_attempt_at <= p_now
    ORDER BY next_attempt_at, created_at, id
    FOR UPDATE SKIP LOCKED LIMIT p_limit
  )
  UPDATE novel.project_deletion_jobs jobs
  SET stage = COALESCE(jobs.resume_stage, jobs.stage), resume_stage = NULL,
      attempts = jobs.attempts + 1, next_attempt_at = p_now + INTERVAL '5 minutes', updated_at = p_now
  FROM claimed WHERE jobs.id = claimed.id RETURNING jobs.*;
END $function$;

CREATE OR REPLACE FUNCTION novel.purge_project_database(p_job_id UUID, p_project_id UUID, p_now TIMESTAMPTZ DEFAULT now())
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, novel, public AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM novel.project_deletion_jobs WHERE id = p_job_id AND project_id = p_project_id AND stage = 'deleting_database') THEN
    RAISE EXCEPTION 'Deletion job is not ready for database purge';
  END IF;
  DELETE FROM novel.projects WHERE id = p_project_id;
  UPDATE novel.project_deletion_jobs SET stage = 'complete', resume_stage = NULL, last_error = NULL, updated_at = p_now WHERE id = p_job_id;
END $function$;

REVOKE EXECUTE ON FUNCTION novel.claim_project_deletion_jobs(TIMESTAMPTZ, INTEGER) FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION novel.freeze_project_for_deletion(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION novel.purge_project_database(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION novel.claim_project_deletion_jobs(TIMESTAMPTZ, INTEGER) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.freeze_project_for_deletion(UUID, UUID, TIMESTAMPTZ) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.purge_project_database(UUID, UUID, TIMESTAMPTZ) TO project_admin;

COMMIT;
