BEGIN;

CREATE TABLE IF NOT EXISTS novel.scheduler_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name TEXT NOT NULL CHECK (length(btrim(job_name)) > 0),
  schedule_date DATE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scheduled', 'catchup', 'retry', 'manual')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'dry_run')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  models_source_hash TEXT,
  pricing_source_hash TEXT,
  parser_version TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduler_runs_unique_success
  ON novel.scheduler_runs(job_name, schedule_date)
  WHERE status = 'succeeded' AND schedule_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scheduler_runs_due_retry
  ON novel.scheduler_runs(job_name, next_retry_at)
  WHERE status = 'failed' AND next_retry_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS novel.system_email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduler_run_id UUID REFERENCES novel.scheduler_runs(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL CHECK (length(btrim(recipient)) > 0),
  subject TEXT NOT NULL CHECK (length(btrim(subject)) > 0),
  text_body TEXT NOT NULL,
  html_body TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_email_outbox_due
  ON novel.system_email_outbox(next_attempt_at, created_at)
  WHERE status IN ('pending', 'sending');

CREATE OR REPLACE FUNCTION novel.claim_system_email_outbox(
  p_limit INTEGER,
  p_lease_id UUID,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS SETOF novel.system_email_outbox
LANGUAGE sql
SECURITY DEFINER
SET search_path = novel, pg_temp
AS $function$
  WITH candidates AS (
    SELECT outbox.id
    FROM novel.system_email_outbox AS outbox
    WHERE outbox.next_attempt_at <= now()
      AND (
        outbox.status = 'pending'
        OR (
          outbox.status = 'sending'
          AND outbox.lease_expires_at <= now()
        )
      )
    ORDER BY outbox.next_attempt_at, outbox.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(p_limit, 0)
  )
  UPDATE novel.system_email_outbox AS outbox
  SET status = 'sending',
      attempt_count = outbox.attempt_count + 1,
      lease_id = p_lease_id,
      lease_expires_at = now() + make_interval(secs => GREATEST(p_lease_seconds, 1)),
      updated_at = now()
  FROM candidates
  WHERE outbox.id = candidates.id
  RETURNING outbox.*;
$function$;

ALTER TABLE novel.scheduler_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.system_email_outbox ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON novel.scheduler_runs FROM PUBLIC, authenticated, anon;
REVOKE ALL ON novel.system_email_outbox FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.claim_system_email_outbox(INTEGER, UUID, INTEGER)
  FROM PUBLIC, authenticated, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON novel.scheduler_runs TO project_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.system_email_outbox TO project_admin;
GRANT EXECUTE ON FUNCTION novel.claim_system_email_outbox(INTEGER, UUID, INTEGER)
  TO project_admin;

COMMIT;
