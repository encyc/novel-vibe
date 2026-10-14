BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('prompt', 'builtin_skill')),
  resource_key TEXT NOT NULL CHECK (resource_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  active_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resource_type, resource_key)
);

CREATE TABLE IF NOT EXISTS public.agent_resource_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL REFERENCES public.agent_resources(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  storage_path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  change_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resource_id, version_number)
);

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_resources_active_version_fk') THEN
    ALTER TABLE public.agent_resources
      ADD CONSTRAINT agent_resources_active_version_fk
      FOREIGN KEY (active_version_id) REFERENCES public.agent_resource_versions(id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION public.check_agent_resource_active_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.agent_resource_versions v
    WHERE v.id = NEW.active_version_id AND v.resource_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'active version must belong to the same resource';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_resources_active_version_owner ON public.agent_resources;
CREATE CONSTRAINT TRIGGER agent_resources_active_version_owner
AFTER INSERT OR UPDATE OF active_version_id ON public.agent_resources
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.check_agent_resource_active_version();

CREATE OR REPLACE FUNCTION public.publish_agent_resource_version(
  p_resource_type TEXT,
  p_resource_key TEXT,
  p_version_number INTEGER,
  p_storage_path TEXT,
  p_content_hash TEXT,
  p_change_note TEXT DEFAULT NULL
) RETURNS SETOF public.agent_resource_versions
LANGUAGE plpgsql AS $$
DECLARE
  resource_row public.agent_resources%ROWTYPE;
  version_row public.agent_resource_versions%ROWTYPE;
  expected_version INTEGER;
BEGIN
  IF p_resource_type NOT IN ('prompt', 'builtin_skill') THEN RAISE EXCEPTION 'invalid resource type'; END IF;
  IF p_resource_key !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' THEN RAISE EXCEPTION 'invalid resource key'; END IF;
  IF p_version_number <= 0 THEN RAISE EXCEPTION 'invalid version number'; END IF;
  IF p_content_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid content hash'; END IF;

  INSERT INTO public.agent_resources (resource_type, resource_key)
  VALUES (p_resource_type, p_resource_key)
  ON CONFLICT (resource_type, resource_key) DO NOTHING;

  SELECT * INTO resource_row FROM public.agent_resources
  WHERE resource_type = p_resource_type AND resource_key = p_resource_key
  FOR UPDATE;

  SELECT * INTO version_row FROM public.agent_resource_versions
  WHERE resource_id = resource_row.id AND version_number = p_version_number;
  IF FOUND THEN
    IF version_row.storage_path = p_storage_path AND version_row.content_hash = p_content_hash THEN
      RETURN NEXT version_row;
      RETURN;
    END IF;
    RAISE EXCEPTION 'version number already contains different content';
  END IF;

  SELECT COALESCE(MAX(version_number), 0) + 1 INTO expected_version
  FROM public.agent_resource_versions WHERE resource_id = resource_row.id;
  IF p_version_number <> expected_version THEN
    RAISE EXCEPTION 'expected version %, got %', expected_version, p_version_number;
  END IF;

  INSERT INTO public.agent_resource_versions (
    resource_id, version_number, storage_path, content_hash, change_note
  ) VALUES (
    resource_row.id, p_version_number, p_storage_path, p_content_hash, p_change_note
  ) RETURNING * INTO version_row;

  UPDATE public.agent_resources SET active_version_id = version_row.id, updated_at = now()
  WHERE id = resource_row.id;
  RETURN NEXT version_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.activate_agent_resource_version(
  p_resource_type TEXT,
  p_resource_key TEXT,
  p_version_number INTEGER
) RETURNS SETOF public.agent_resource_versions
LANGUAGE plpgsql AS $$
DECLARE
  resource_row public.agent_resources%ROWTYPE;
  version_row public.agent_resource_versions%ROWTYPE;
BEGIN
  SELECT * INTO resource_row FROM public.agent_resources
  WHERE resource_type = p_resource_type AND resource_key = p_resource_key
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent resource not found'; END IF;

  SELECT * INTO version_row FROM public.agent_resource_versions
  WHERE resource_id = resource_row.id AND version_number = p_version_number;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent resource version not found'; END IF;

  UPDATE public.agent_resources SET active_version_id = version_row.id, updated_at = now()
  WHERE id = resource_row.id;
  RETURN NEXT version_row;
END;
$$;

ALTER TABLE public.agent_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_resource_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_resources FROM PUBLIC;
REVOKE ALL ON public.agent_resource_versions FROM PUBLIC;
REVOKE ALL ON public.agent_resources FROM anon, authenticated;
REVOKE ALL ON public.agent_resource_versions FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_agent_resource_version(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.activate_agent_resource_version(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

COMMIT;
