BEGIN;

CREATE OR REPLACE FUNCTION novel.transition_project_lifecycle(
  p_project_id UUID,
  p_command TEXT,
  p_now TIMESTAMPTZ DEFAULT now(),
  p_trash_days INTEGER DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
AS $function$
DECLARE
  target novel.projects%ROWTYPE;
  blocking_session_id UUID;
  restored_status TEXT;
BEGIN
  SELECT * INTO target
  FROM novel.projects
  WHERE id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  SELECT id INTO blocking_session_id
  FROM novel.sessions
  WHERE project_id = p_project_id
    AND processing_lease_id IS NOT NULL
    AND (
      processing_started_at IS NULL
      OR processing_started_at >= p_now - INTERVAL '15 minutes'
    )
  ORDER BY processing_started_at DESC NULLS FIRST, id
  LIMIT 1;

  IF blocking_session_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'busy',
      'sessionId', blocking_session_id
    );
  END IF;

  IF p_command = 'archive' THEN
    IF target.lifecycle_status = 'archived' THEN
      RETURN jsonb_build_object('outcome', 'ok', 'project', to_jsonb(target));
    END IF;
    IF target.lifecycle_status <> 'active' THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'from', target.lifecycle_status, 'command', p_command);
    END IF;
    UPDATE novel.projects
    SET lifecycle_status = 'archived',
        archived_at = p_now,
        last_activity_at = p_now
    WHERE id = p_project_id
    RETURNING * INTO target;

  ELSIF p_command = 'trash' THEN
    IF target.lifecycle_status = 'trash' THEN
      RETURN jsonb_build_object('outcome', 'ok', 'project', to_jsonb(target));
    END IF;
    UPDATE novel.projects
    SET lifecycle_status = 'trash',
        pre_trash_status = target.lifecycle_status,
        deleted_at = p_now,
        purge_after = p_now + make_interval(days => GREATEST(p_trash_days, 1)),
        last_activity_at = p_now
    WHERE id = p_project_id
    RETURNING * INTO target;

  ELSIF p_command = 'restore' THEN
    IF target.lifecycle_status = 'active' THEN
      RETURN jsonb_build_object('outcome', 'ok', 'project', to_jsonb(target));
    END IF;
    IF target.lifecycle_status = 'trash' AND EXISTS (
      SELECT 1 FROM novel.project_deletion_jobs
      WHERE project_id = p_project_id
        AND (
          stage IN ('excluding_memory', 'deleting_storage', 'deleting_database', 'complete')
          OR (stage = 'failed' AND resume_stage IN ('excluding_memory', 'deleting_storage', 'deleting_database'))
        )
    ) THEN
      RETURN jsonb_build_object('outcome', 'purge_in_progress');
    END IF;

    restored_status := CASE
      WHEN target.lifecycle_status = 'archived' THEN 'active'
      ELSE COALESCE(target.pre_trash_status, 'active')
    END;
    UPDATE novel.projects
    SET lifecycle_status = restored_status,
        pre_trash_status = NULL,
        archived_at = CASE WHEN restored_status = 'archived' THEN COALESCE(archived_at, p_now) ELSE NULL END,
        deleted_at = NULL,
        purge_after = NULL,
        last_activity_at = p_now
    WHERE id = p_project_id
    RETURNING * INTO target;

  ELSE
    RETURN jsonb_build_object('outcome', 'invalid', 'from', target.lifecycle_status, 'command', p_command);
  END IF;

  RETURN jsonb_build_object('outcome', 'ok', 'project', to_jsonb(target));
END
$function$;

REVOKE EXECUTE ON FUNCTION novel.transition_project_lifecycle(UUID, TEXT, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION novel.transition_project_lifecycle(UUID, TEXT, TIMESTAMPTZ, INTEGER)
  TO authenticated, project_admin;

COMMIT;
