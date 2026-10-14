BEGIN;

-- Legacy table: per-workspace skill enable/disable state. Drop+recreate to
-- ensure workspace_id is TEXT (matching what migration 002/003 assume).
-- CASCADE drops dependent RLS policies and grants — we recreate them
-- immediately below so the table is never exposed without protection.
DROP TABLE IF EXISTS public.workspace_skills CASCADE;
CREATE TABLE public.workspace_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  skill_slug TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, skill_slug)
);

ALTER TABLE public.workspace_skills ENABLE ROW LEVEL SECURITY;

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
  FOREACH operation IN ARRAY ARRAY['select', 'insert', 'update', 'delete'] LOOP
    policy_name := 'workspace_skills_owner_' || operation;
    IF operation = 'select' THEN
      EXECUTE format('CREATE POLICY %I ON public.workspace_skills FOR SELECT TO authenticated USING (%s)', policy_name, predicate);
    ELSIF operation = 'insert' THEN
      EXECUTE format('CREATE POLICY %I ON public.workspace_skills FOR INSERT TO authenticated WITH CHECK (%s)', policy_name, predicate);
    ELSIF operation = 'update' THEN
      EXECUTE format('CREATE POLICY %I ON public.workspace_skills FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', policy_name, predicate, predicate);
    ELSE
      EXECUTE format('CREATE POLICY %I ON public.workspace_skills FOR DELETE TO authenticated USING (%s)', policy_name, predicate);
    END IF;
  END LOOP;
END
$migration$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_skills TO authenticated;

CREATE TABLE IF NOT EXISTS public.skill_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('upload', 'paste', 'skill_creator')),
  original_content TEXT NOT NULL,
  candidate_content TEXT NOT NULL,
  selected_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'reviewing', 'revision_required', 'awaiting_confirmation',
    'rejected', 'cancelled', 'installed'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  session_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_skill_drafts_owner_status
  ON public.skill_drafts(user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.skill_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID NOT NULL REFERENCES public.skill_drafts(id) ON DELETE CASCADE,
  draft_version INTEGER NOT NULL CHECK (draft_version > 0),
  verdict TEXT NOT NULL CHECK (verdict IN ('approved', 'revision_required', 'rejected', 'failed')),
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  original_hash TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  reviewer_provider TEXT,
  reviewer_model TEXT,
  prompt_version TEXT NOT NULL,
  failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (draft_id, draft_version)
);

CREATE INDEX IF NOT EXISTS idx_skill_reviews_draft_created
  ON public.skill_reviews(draft_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.skill_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  storage_path TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  user_id TEXT,
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('built-in', 'user')),
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_registry_slug_source_user
  ON public.skill_registry(slug, source, COALESCE(user_id, 'built-in'::text));

ALTER TABLE public.skill_registry
  ADD COLUMN IF NOT EXISTS active_review_id UUID REFERENCES public.skill_reviews(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS approved_content_hash TEXT,
  ADD COLUMN IF NOT EXISTS review_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS confirmation_key TEXT,
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'review_required'
    CHECK (review_status IN ('approved', 'review_required', 'quarantined'));

CREATE TABLE IF NOT EXISTS public.skill_roles (
  skill_id UUID NOT NULL REFERENCES public.skill_registry(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN (
    'chief_editor', 'worldbuilder', 'character_designer',
    'outliner', 'director', 'writer'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, role)
);

CREATE UNIQUE INDEX IF NOT EXISTS skill_registry_confirmation_key
  ON public.skill_registry(user_id, confirmation_key)
  WHERE user_id IS NOT NULL AND confirmation_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_skill_roles_role ON public.skill_roles(role, skill_id);
CREATE INDEX IF NOT EXISTS idx_workspace_skills_enabled
  ON public.workspace_skills(workspace_id, enabled, skill_slug);

CREATE OR REPLACE FUNCTION public.skill_reviews_are_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Skill reviews are immutable';
END;
$$;

DROP TRIGGER IF EXISTS skill_reviews_are_immutable ON public.skill_reviews;
CREATE TRIGGER skill_reviews_are_immutable
  BEFORE UPDATE ON public.skill_reviews
  FOR EACH ROW EXECUTE FUNCTION public.skill_reviews_are_immutable();

ALTER TABLE public.skill_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skill_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skill_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skill_registry ENABLE ROW LEVEL SECURITY;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_drafts_owner_select' AND polrelid = 'public.skill_drafts'::regclass) THEN
    CREATE POLICY skill_drafts_owner_select ON public.skill_drafts FOR SELECT TO authenticated
      USING (user_id = auth.uid()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_drafts_owner_insert' AND polrelid = 'public.skill_drafts'::regclass) THEN
    CREATE POLICY skill_drafts_owner_insert ON public.skill_drafts FOR INSERT TO authenticated
      WITH CHECK (user_id = auth.uid()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_drafts_owner_update' AND polrelid = 'public.skill_drafts'::regclass) THEN
    CREATE POLICY skill_drafts_owner_update ON public.skill_drafts FOR UPDATE TO authenticated
      USING (user_id = auth.uid()::text) WITH CHECK (user_id = auth.uid()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_drafts_owner_delete' AND polrelid = 'public.skill_drafts'::regclass) THEN
    CREATE POLICY skill_drafts_owner_delete ON public.skill_drafts FOR DELETE TO authenticated
      USING (user_id = auth.uid()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_reviews_owner_select' AND polrelid = 'public.skill_reviews'::regclass) THEN
    CREATE POLICY skill_reviews_owner_select ON public.skill_reviews FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.skill_drafts d
        WHERE d.id = draft_id AND d.user_id = auth.uid()::text
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_reviews_owner_insert' AND polrelid = 'public.skill_reviews'::regclass) THEN
    CREATE POLICY skill_reviews_owner_insert ON public.skill_reviews FOR INSERT TO authenticated
      WITH CHECK (EXISTS (
        SELECT 1 FROM public.skill_drafts d
        WHERE d.id = draft_id AND d.user_id = auth.uid()::text
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_roles_owner_select' AND polrelid = 'public.skill_roles'::regclass) THEN
    CREATE POLICY skill_roles_owner_select ON public.skill_roles FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.skill_registry s
        WHERE s.id = skill_id AND (s.user_id = auth.uid()::text OR s.user_id IS NULL)
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_roles_owner_insert' AND polrelid = 'public.skill_roles'::regclass) THEN
    CREATE POLICY skill_roles_owner_insert ON public.skill_roles FOR INSERT TO authenticated
      WITH CHECK (EXISTS (
        SELECT 1 FROM public.skill_registry s
        WHERE s.id = skill_id AND s.user_id = auth.uid()::text
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_roles_owner_delete' AND polrelid = 'public.skill_roles'::regclass) THEN
    CREATE POLICY skill_roles_owner_delete ON public.skill_roles FOR DELETE TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.skill_registry s
        WHERE s.id = skill_id AND s.user_id = auth.uid()::text
      ));
  END IF;

  -- skill_registry: built-in skills (user_id IS NULL) visible to all; user skills only to owner
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_registry_select' AND polrelid = 'public.skill_registry'::regclass) THEN
    CREATE POLICY skill_registry_select ON public.skill_registry FOR SELECT TO authenticated
      USING (user_id IS NULL OR user_id = auth.uid()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_registry_insert' AND polrelid = 'public.skill_registry'::regclass) THEN
    CREATE POLICY skill_registry_insert ON public.skill_registry FOR INSERT TO authenticated
      WITH CHECK (user_id = auth.uid()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_registry_update' AND polrelid = 'public.skill_registry'::regclass) THEN
    CREATE POLICY skill_registry_update ON public.skill_registry FOR UPDATE TO authenticated
      USING (user_id = auth.uid()::text) WITH CHECK (user_id = auth.uid()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_registry_delete' AND polrelid = 'public.skill_registry'::regclass) THEN
    CREATE POLICY skill_registry_delete ON public.skill_registry FOR DELETE TO authenticated
      USING (user_id = auth.uid()::text);
  END IF;
END
$migration$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.skill_drafts TO authenticated;
GRANT SELECT, INSERT ON public.skill_reviews TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.skill_roles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.skill_registry TO authenticated;
GRANT SELECT ON public.skill_registry TO anon;

COMMIT;
