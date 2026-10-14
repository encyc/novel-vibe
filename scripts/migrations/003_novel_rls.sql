BEGIN;

ALTER TABLE novel.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.document_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.foreshadow_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.session_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.session_agent_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.memory_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.memory_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.project_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.usage_records ENABLE ROW LEVEL SECURITY;

DO $migration$
DECLARE
  operation TEXT;
  policy_name TEXT;
BEGIN
  FOREACH operation IN ARRAY ARRAY['select', 'insert', 'update', 'delete'] LOOP
    policy_name := 'projects_owner_' || operation;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy
      WHERE polname = policy_name AND polrelid = 'novel.projects'::regclass
    ) THEN
      IF operation = 'select' THEN
        EXECUTE 'CREATE POLICY projects_owner_select ON novel.projects FOR SELECT TO authenticated
          USING (owner_id = NULLIF((SELECT auth.jwt() ->> ''sub''), '''')::uuid)';
      ELSIF operation = 'insert' THEN
        EXECUTE 'CREATE POLICY projects_owner_insert ON novel.projects FOR INSERT TO authenticated
          WITH CHECK (owner_id = NULLIF((SELECT auth.jwt() ->> ''sub''), '''')::uuid)';
      ELSIF operation = 'update' THEN
        EXECUTE 'CREATE POLICY projects_owner_update ON novel.projects FOR UPDATE TO authenticated
          USING (owner_id = NULLIF((SELECT auth.jwt() ->> ''sub''), '''')::uuid)
          WITH CHECK (owner_id = NULLIF((SELECT auth.jwt() ->> ''sub''), '''')::uuid)';
      ELSE
        EXECUTE 'CREATE POLICY projects_owner_delete ON novel.projects FOR DELETE TO authenticated
          USING (owner_id = NULLIF((SELECT auth.jwt() ->> ''sub''), '''')::uuid)';
      END IF;
    END IF;
  END LOOP;
END
$migration$;

-- Compatibility boundary while callers migrate from workspace_skills to
-- project_skills. Remove this block together with the legacy table.
DO $migration$
DECLARE
  operation TEXT;
  policy_name TEXT;
  predicate TEXT := 'CASE
    WHEN workspace_id::text ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'' THEN EXISTS (
      SELECT 1 FROM novel.projects p
      WHERE p.id = workspace_id::uuid
        AND p.owner_id = NULLIF((SELECT auth.jwt() ->> ''sub''), '''')::uuid
    )
    ELSE false
  END';
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'workspace_skills'
  ) THEN
    ALTER TABLE public.workspace_skills ENABLE ROW LEVEL SECURITY;
    FOREACH operation IN ARRAY ARRAY['select', 'insert', 'update', 'delete'] LOOP
      policy_name := 'workspace_skills_owner_' || operation;
      IF NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polname = policy_name AND polrelid = 'public.workspace_skills'::regclass
      ) THEN
        IF operation = 'select' THEN
          EXECUTE format('CREATE POLICY %I ON public.workspace_skills FOR SELECT TO authenticated USING (%s)', policy_name, predicate);
        ELSIF operation = 'insert' THEN
          EXECUTE format('CREATE POLICY %I ON public.workspace_skills FOR INSERT TO authenticated WITH CHECK (%s)', policy_name, predicate);
        ELSIF operation = 'update' THEN
          EXECUTE format('CREATE POLICY %I ON public.workspace_skills FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', policy_name, predicate, predicate);
        ELSE
          EXECUTE format('CREATE POLICY %I ON public.workspace_skills FOR DELETE TO authenticated USING (%s)', policy_name, predicate);
        END IF;
      END IF;
    END LOOP;
  END IF;
END
$migration$;

DO $migration$
DECLARE
  target_table TEXT;
  operation TEXT;
  policy_name TEXT;
  predicate TEXT := 'EXISTS (
    SELECT 1 FROM novel.projects p
    WHERE p.id = project_id
      AND p.owner_id = NULLIF((SELECT auth.jwt() ->> ''sub''), '''')::uuid
  )';
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'document_index', 'agent_tasks', 'foreshadow_index', 'sessions'
  ] LOOP
    FOREACH operation IN ARRAY ARRAY['select', 'insert', 'update', 'delete'] LOOP
      policy_name := target_table || '_owner_' || operation;
      IF NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polname = policy_name
          AND polrelid = format('novel.%I', target_table)::regclass
      ) THEN
        IF operation = 'select' THEN
          EXECUTE format(
            'CREATE POLICY %I ON novel.%I FOR SELECT TO authenticated USING (%s)',
            policy_name, target_table, predicate
          );
        ELSIF operation = 'insert' THEN
          EXECUTE format(
            'CREATE POLICY %I ON novel.%I FOR INSERT TO authenticated WITH CHECK (%s)',
            policy_name, target_table, predicate
          );
        ELSIF operation = 'update' THEN
          EXECUTE format(
            'CREATE POLICY %I ON novel.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',
            policy_name, target_table, predicate, predicate
          );
        ELSE
          EXECUTE format(
            'CREATE POLICY %I ON novel.%I FOR DELETE TO authenticated USING (%s)',
            policy_name, target_table, predicate
          );
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END
$migration$;

DO $migration$
DECLARE
  target_table TEXT;
  operation TEXT;
  policy_name TEXT;
  predicate TEXT := 'EXISTS (
    SELECT 1
    FROM novel.sessions s
    JOIN novel.projects p ON p.id = s.project_id
    WHERE s.id = session_id
      AND p.owner_id = NULLIF((SELECT auth.jwt() ->> ''sub''), '''')::uuid
  )';
BEGIN
  FOREACH target_table IN ARRAY ARRAY['session_messages', 'session_agent_state'] LOOP
    FOREACH operation IN ARRAY ARRAY['select', 'insert', 'update', 'delete'] LOOP
      policy_name := target_table || '_owner_' || operation;
      IF NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polname = policy_name
          AND polrelid = format('novel.%I', target_table)::regclass
      ) THEN
        IF operation = 'select' THEN
          EXECUTE format(
            'CREATE POLICY %I ON novel.%I FOR SELECT TO authenticated USING (%s)',
            policy_name, target_table, predicate
          );
        ELSIF operation = 'insert' THEN
          EXECUTE format(
            'CREATE POLICY %I ON novel.%I FOR INSERT TO authenticated WITH CHECK (%s)',
            policy_name, target_table, predicate
          );
        ELSIF operation = 'update' THEN
          EXECUTE format(
            'CREATE POLICY %I ON novel.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',
            policy_name, target_table, predicate, predicate
          );
        ELSE
          EXECUTE format(
            'CREATE POLICY %I ON novel.%I FOR DELETE TO authenticated USING (%s)',
            policy_name, target_table, predicate
          );
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END
$migration$;

DO $migration$
DECLARE
  operation TEXT;
  policy_name TEXT;
  predicate TEXT := 'EXISTS (
    SELECT 1 FROM novel.projects p
    WHERE p.id = project_id
      AND p.owner_id = NULLIF((SELECT auth.jwt() ->> ''sub''), '''')::uuid
  )';
BEGIN
  FOREACH operation IN ARRAY ARRAY['select', 'insert', 'update', 'delete'] LOOP
    policy_name := 'project_skills_owner_' || operation;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy
      WHERE polname = policy_name AND polrelid = 'public.project_skills'::regclass
    ) THEN
      IF operation = 'select' THEN
        EXECUTE format('CREATE POLICY %I ON public.project_skills FOR SELECT TO authenticated USING (%s)', policy_name, predicate);
      ELSIF operation = 'insert' THEN
        EXECUTE format('CREATE POLICY %I ON public.project_skills FOR INSERT TO authenticated WITH CHECK (%s)', policy_name, predicate);
      ELSIF operation = 'update' THEN
        EXECUTE format('CREATE POLICY %I ON public.project_skills FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', policy_name, predicate, predicate);
      ELSE
        EXECUTE format('CREATE POLICY %I ON public.project_skills FOR DELETE TO authenticated USING (%s)', policy_name, predicate);
      END IF;
    END IF;
  END LOOP;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'memory_jobs_owner_select' AND polrelid = 'novel.memory_jobs'::regclass
  ) THEN
    CREATE POLICY memory_jobs_owner_select ON novel.memory_jobs
      FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1 FROM novel.projects p
        WHERE p.id = project_id
          AND p.owner_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
      ));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'memory_jobs_owner_insert' AND polrelid = 'novel.memory_jobs'::regclass
  ) THEN
    CREATE POLICY memory_jobs_owner_insert ON novel.memory_jobs
      FOR INSERT TO authenticated
      WITH CHECK (EXISTS (
        SELECT 1 FROM novel.projects p
        WHERE p.id = project_id
          AND p.owner_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'memory_exclusions_owner_select' AND polrelid = 'novel.memory_exclusions'::regclass
  ) THEN
    CREATE POLICY memory_exclusions_owner_select ON novel.memory_exclusions
      FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1 FROM novel.projects p
        WHERE p.id = project_id
          AND p.owner_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
      ));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'memory_exclusions_owner_insert' AND polrelid = 'novel.memory_exclusions'::regclass
  ) THEN
    CREATE POLICY memory_exclusions_owner_insert ON novel.memory_exclusions
      FOR INSERT TO authenticated
      WITH CHECK (EXISTS (
        SELECT 1 FROM novel.projects p
        WHERE p.id = project_id
          AND p.owner_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'project_deletion_jobs_owner_select'
      AND polrelid = 'novel.project_deletion_jobs'::regclass
  ) THEN
    CREATE POLICY project_deletion_jobs_owner_select ON novel.project_deletion_jobs
      FOR SELECT TO authenticated
      USING (requested_by = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;

DO $migration$
DECLARE
  target_table TEXT;
  policy_name TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['credit_balances', 'credit_transactions', 'usage_records'] LOOP
    policy_name := target_table || '_owner_select';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy
      WHERE polname = policy_name
        AND polrelid = format('novel.%I', target_table)::regclass
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON novel.%I FOR SELECT TO authenticated
         USING (user_id = NULLIF((SELECT auth.jwt() ->> ''sub''), '''')::uuid)',
        policy_name, target_table
      );
    END IF;
  END LOOP;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'document_index_owner_select' AND polrelid = 'novel.document_index'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'session_messages_owner_insert' AND polrelid = 'novel.session_messages'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'project_skills_owner_update' AND polrelid = 'public.project_skills'::regclass)
     OR (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workspace_skills')
         AND NOT EXISTS (
           SELECT 1 FROM pg_policy p
           JOIN pg_class c ON p.polrelid = c.oid
           JOIN pg_namespace n ON c.relnamespace = n.oid
           WHERE p.polname = 'workspace_skills_owner_select'
             AND n.nspname = 'public'
             AND c.relname = 'workspace_skills'
         ))
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'credit_balances_owner_select' AND polrelid = 'novel.credit_balances'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'credit_transactions_owner_select' AND polrelid = 'novel.credit_transactions'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'usage_records_owner_select' AND polrelid = 'novel.usage_records'::regclass) THEN
    RAISE EXCEPTION 'Novel Vibe ownership policies were not installed completely';
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION novel.prepare_session_memory_delete(p_session_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, novel
AS $function$
DECLARE
  caller_id UUID;
BEGIN
  caller_id := NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid;
  IF caller_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM novel.sessions s
    JOIN novel.projects p ON p.id = s.project_id
    WHERE s.id = p_session_id AND p.owner_id = caller_id
  ) THEN
    RAISE EXCEPTION 'Session does not belong to authenticated user'
      USING ERRCODE = '42501';
  END IF;

  UPDATE novel.memory_jobs
  SET status = 'cancelled', updated_at = now()
  WHERE session_id = p_session_id AND status IN ('pending', 'failed');

  RETURN NOT EXISTS (
    SELECT 1 FROM novel.memory_jobs
    WHERE session_id = p_session_id AND status = 'running'
  );
END
$function$;

REVOKE EXECUTE ON FUNCTION novel.claim_memory_jobs(TIMESTAMPTZ, INTEGER) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION novel.claim_memory_jobs(TIMESTAMPTZ, INTEGER) TO project_admin;
REVOKE EXECUTE ON FUNCTION novel.prepare_session_memory_delete(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION novel.prepare_session_memory_delete(UUID) TO authenticated, project_admin;

REVOKE UPDATE, DELETE ON novel.memory_jobs FROM authenticated;
REVOKE UPDATE, DELETE ON novel.memory_exclusions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON novel.project_deletion_jobs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON novel.credit_balances FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON novel.credit_transactions FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON novel.usage_records FROM authenticated, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  novel.projects,
  novel.document_index,
  novel.agent_tasks,
  novel.foreshadow_index,
  novel.sessions,
  novel.session_messages,
  novel.session_agent_state
TO authenticated;
GRANT SELECT, INSERT ON novel.memory_jobs, novel.memory_exclusions TO authenticated;
GRANT SELECT ON novel.project_deletion_jobs TO authenticated;
GRANT SELECT ON novel.credit_balances, novel.credit_transactions, novel.usage_records TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_skills TO authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workspace_skills') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_skills TO authenticated';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated, anon;

COMMIT;
