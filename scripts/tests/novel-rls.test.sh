#!/usr/bin/env bash
set -euo pipefail

container=$(docker ps --filter label=com.docker.compose.service=postgres --format '{{.Names}}' | head -1)
[[ -n "$container" ]] || { echo "No running Compose postgres service found." >&2; exit 1; }

required_tables=(
  agent_tasks document_index foreshadow_index memory_exclusions memory_jobs
  project_deletion_jobs projects session_agent_state session_messages sessions
)

for table in "${required_tables[@]}"; do
  enabled=$(docker exec "$container" psql -U postgres -d insforge -Atc \
    "SELECT rowsecurity FROM pg_tables WHERE schemaname='novel' AND tablename='$table'")
  [[ "$enabled" == "t" ]] || { echo "RLS is not enabled on novel.$table" >&2; exit 1; }
done

project_skills_rls=$(docker exec "$container" psql -U postgres -d insforge -Atc \
  "SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='project_skills'")
[[ "$project_skills_rls" == "t" ]] || { echo "RLS is not enabled on public.project_skills" >&2; exit 1; }

workspace_skills_rls=$(docker exec "$container" psql -U postgres -d insforge -Atc \
  "SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='workspace_skills'")
[[ "$workspace_skills_rls" == "t" ]] || { echo "RLS is not enabled on compatibility table public.workspace_skills" >&2; exit 1; }

docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d insforge <<'SQL'
BEGIN;

INSERT INTO auth.users (id, email, is_project_admin, is_anonymous)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'rls-alice@example.com', false, false),
  ('22222222-2222-4222-8222-222222222222', 'rls-bob@example.com', false, false)
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;

INSERT INTO novel.projects (id, owner_id, title, storage_path)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'Alice Project', 'novels/rls-alice'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'Bob Project', 'novels/rls-bob')
ON CONFLICT (id) DO NOTHING;

INSERT INTO novel.sessions (id, project_id, title)
VALUES
  ('a1111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Alice Session'),
  ('b2222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Bob Session')
ON CONFLICT (id) DO NOTHING;

INSERT INTO novel.session_messages (id, session_id, role, content, timestamp, turn_id, display)
VALUES
  ('a3333333-3333-4333-8333-333333333333', 'a1111111-1111-4111-8111-111111111111', 'user', '[]', 1, 'a4444444-4444-4444-8444-444444444444', true),
  ('b3333333-3333-4333-8333-333333333333', 'b2222222-2222-4222-8222-222222222222', 'user', '[]', 1, 'b4444444-4444-4444-8444-444444444444', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO novel.session_agent_state (session_id, agent_id, summary)
VALUES
  ('a1111111-1111-4111-8111-111111111111', 'chief_editor', 'alice'),
  ('b2222222-2222-4222-8222-222222222222', 'chief_editor', 'bob')
ON CONFLICT (session_id, agent_id) DO NOTHING;

INSERT INTO novel.credit_balances (user_id, balance)
VALUES
  ('11111111-1111-4111-8111-111111111111', 10),
  ('22222222-2222-4222-8222-222222222222', 20)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO novel.credit_transactions (user_id, type, amount, balance_after)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'grant', 10, 10),
  ('22222222-2222-4222-8222-222222222222', 'grant', 20, 20);

INSERT INTO novel.usage_records (user_id, project_id, session_id, agent_id, model_id, model_provider)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a1111111-1111-4111-8111-111111111111', 'chief_editor', 'test', 'test'),
  ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b2222222-2222-4222-8222-222222222222', 'chief_editor', 'test', 'test');

INSERT INTO public.workspace_skills (workspace_id, skill_slug, enabled)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'rls-alice-skill', true),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'rls-bob-skill', true)
ON CONFLICT (workspace_id, skill_slug) DO NOTHING;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);

DO $test$
BEGIN
  IF (SELECT count(*) FROM novel.projects) <> 1 THEN
    RAISE EXCEPTION 'Alice must see exactly one project';
  END IF;
  IF (SELECT count(*) FROM novel.sessions) <> 1
     OR (SELECT count(*) FROM novel.session_messages) <> 1
     OR (SELECT count(*) FROM novel.session_agent_state) <> 1 THEN
    RAISE EXCEPTION 'Alice indirect Session rows are not isolated';
  END IF;
  IF (SELECT count(*) FROM novel.credit_balances) <> 1
     OR (SELECT count(*) FROM novel.credit_transactions) <> 1
     OR (SELECT count(*) FROM novel.usage_records) <> 1 THEN
    RAISE EXCEPTION 'Alice credit reads are not isolated';
  END IF;
  IF (SELECT count(*) FROM public.workspace_skills) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.workspace_skills WHERE skill_slug = 'rls-alice-skill') THEN
    RAISE EXCEPTION 'Alice legacy workspace skill rows are not isolated';
  END IF;

  INSERT INTO novel.projects (id, owner_id, title, storage_path)
  VALUES ('a5555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', 'Alice Temporary', 'novels/rls-alice-temp');
  UPDATE novel.projects SET title = 'Alice Updated' WHERE id = 'a5555555-5555-4555-8555-555555555555';
  DELETE FROM novel.projects WHERE id = 'a5555555-5555-4555-8555-555555555555';

  INSERT INTO novel.document_index (project_id, doc_path, doc_type)
  VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'rls/test.md', 'character');
  UPDATE novel.document_index SET name = 'Alice Doc'
  WHERE project_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND doc_path = 'rls/test.md';
  DELETE FROM novel.document_index
  WHERE project_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND doc_path = 'rls/test.md';

  BEGIN
    INSERT INTO novel.document_index (project_id, doc_path, doc_type)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'rls/forbidden.md', 'character');
    RAISE EXCEPTION 'Alice inserted a row into Bob project';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.workspace_skills (workspace_id, skill_slug, enabled)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'rls-forbidden-skill', true);
    RAISE EXCEPTION 'Alice inserted a legacy skill binding into Bob project';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    UPDATE novel.credit_balances SET balance = 999
    WHERE user_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'Alice mutated credit balance';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$test$;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
DO $test$
BEGIN
  IF (SELECT count(*) FROM novel.projects) <> 1
     OR NOT EXISTS (SELECT 1 FROM novel.projects WHERE title = 'Bob Project') THEN
    RAISE EXCEPTION 'Bob project visibility is incorrect';
  END IF;
  IF (SELECT count(*) FROM public.workspace_skills) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.workspace_skills WHERE skill_slug = 'rls-bob-skill') THEN
    RAISE EXCEPTION 'Bob legacy workspace skill visibility is incorrect';
  END IF;
END
$test$;

RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $test$
BEGIN
  IF EXISTS (SELECT 1 FROM novel.projects)
     OR EXISTS (SELECT 1 FROM novel.sessions)
     OR EXISTS (SELECT 1 FROM novel.credit_balances) THEN
    RAISE EXCEPTION 'Anonymous role can see private rows';
  END IF;
END
$test$;

RESET ROLE;
SET LOCAL ROLE project_admin;
DO $test$
BEGIN
  IF (SELECT count(*) FROM novel.projects) < 2 THEN
    RAISE EXCEPTION 'project_admin cannot bypass tenant policies';
  END IF;
END
$test$;

RESET ROLE;
ROLLBACK;
SQL

echo "Novel Vibe RLS matrix passed"
