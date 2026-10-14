BEGIN;

-- (a) Allow 'evolution' as a skill_drafts source so the Chief Editor can create
-- evolution drafts (original = currently installed content, candidate = improved).
ALTER TABLE public.skill_drafts
  DROP CONSTRAINT IF EXISTS skill_drafts_source_check1;
ALTER TABLE public.skill_drafts
  DROP CONSTRAINT IF EXISTS skill_drafts_source_check;
ALTER TABLE public.skill_drafts
  ADD CONSTRAINT skill_drafts_source_check
  CHECK (source IN ('upload', 'paste', 'skill_creator', 'evolution'));

-- (b) Skill version history: every evolution / revert / install snapshots the
-- previously-active content so it can be rolled back. One row per snapshot.
CREATE TABLE IF NOT EXISTS public.skill_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID NOT NULL REFERENCES public.skill_registry(id) ON DELETE CASCADE,
  version_number INT NOT NULL CHECK (version_number > 0),
  content_hash TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  active_review_id UUID REFERENCES public.skill_reviews(id) ON DELETE SET NULL,
  snapshot_reason TEXT NOT NULL DEFAULT 'evolution'
    CHECK (snapshot_reason IN ('evolution', 'revert', 'install')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_skill_versions_skill
  ON public.skill_versions(skill_id, version_number DESC);

-- (c) RLS: a user may only see / write versions of skills they own.
ALTER TABLE public.skill_versions ENABLE ROW LEVEL SECURITY;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_versions_owner_select' AND polrelid = 'public.skill_versions'::regclass) THEN
    CREATE POLICY skill_versions_owner_select ON public.skill_versions FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.skill_registry r
        WHERE r.id = skill_versions.skill_id AND r.user_id = auth.uid()::text
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_versions_owner_insert' AND polrelid = 'public.skill_versions'::regclass) THEN
    CREATE POLICY skill_versions_owner_insert ON public.skill_versions FOR INSERT TO authenticated
      WITH CHECK (EXISTS (
        SELECT 1 FROM public.skill_registry r
        WHERE r.id = skill_versions.skill_id AND r.user_id = auth.uid()::text
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_versions_owner_update' AND polrelid = 'public.skill_versions'::regclass) THEN
    CREATE POLICY skill_versions_owner_update ON public.skill_versions FOR UPDATE TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.skill_registry r
        WHERE r.id = skill_versions.skill_id AND r.user_id = auth.uid()::text
      ))
      WITH CHECK (EXISTS (
        SELECT 1 FROM public.skill_registry r
        WHERE r.id = skill_versions.skill_id AND r.user_id = auth.uid()::text
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'skill_versions_owner_delete' AND polrelid = 'public.skill_versions'::regclass) THEN
    CREATE POLICY skill_versions_owner_delete ON public.skill_versions FOR DELETE TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.skill_registry r
        WHERE r.id = skill_versions.skill_id AND r.user_id = auth.uid()::text
      ));
  END IF;
END
$migration$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.skill_versions TO authenticated;

COMMIT;
