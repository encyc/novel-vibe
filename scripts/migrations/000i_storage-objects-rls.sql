-- Migrated verbatim from the InsForge fork backend/src/infra/database/migrations/052_storage-objects-rls.sql:
-- this is Novel Vibe application schema, so it belongs in this repository, not in the BaaS fork.
-- Prefixed 000* so run-migrations.sh applies it before 001_durable_sessions.sql.
-- Add RLS policies on storage.objects for authenticated users.
-- The project_admin role already has full access via project_admin_policy.
-- These policies let authenticated users manage their own objects.

-- Allow authenticated users to read their own objects.
DROP POLICY IF EXISTS storage_objects_owner_select ON storage.objects;
CREATE POLICY storage_objects_owner_select ON storage.objects
  FOR SELECT
  TO authenticated
  USING (uploaded_by = auth.jwt() ->> 'sub');

-- Allow authenticated users to insert objects (checked against the uploaded_by value set by the service).
DROP POLICY IF EXISTS storage_objects_owner_insert ON storage.objects;
CREATE POLICY storage_objects_owner_insert ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (uploaded_by = auth.jwt() ->> 'sub');

-- Allow authenticated users to update their own objects.
DROP POLICY IF EXISTS storage_objects_owner_update ON storage.objects;
CREATE POLICY storage_objects_owner_update ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (uploaded_by = auth.jwt() ->> 'sub');

-- Allow authenticated users to delete their own objects.
DROP POLICY IF EXISTS storage_objects_owner_delete ON storage.objects;
CREATE POLICY storage_objects_owner_delete ON storage.objects
  FOR DELETE
  TO authenticated
  USING (uploaded_by = auth.jwt() ->> 'sub');
