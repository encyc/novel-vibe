-- Migration 031: verified email registration challenges and recoverable signup reservations.

BEGIN;

CREATE TABLE IF NOT EXISTS novel.registration_email_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_registration_challenges_email
  ON novel.registration_email_challenges(normalized_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_registration_challenges_ip
  ON novel.registration_email_challenges(ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS novel.registration_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_email TEXT NOT NULL,
  ticket_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  reserved_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS novel.registration_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL UNIQUE REFERENCES novel.registration_tickets(id) ON DELETE CASCADE,
  reservation_hash TEXT NOT NULL UNIQUE,
  normalized_email TEXT NOT NULL,
  invite_code TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  finalized_user_id UUID,
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_registration_reservations_reconcile
  ON novel.registration_reservations(created_at)
  WHERE finalized_at IS NULL;

CREATE OR REPLACE FUNCTION novel.request_registration_email_code(
  p_email TEXT,
  p_code_hash TEXT,
  p_ip_hash TEXT,
  p_subject TEXT,
  p_text_body TEXT,
  p_html_body TEXT DEFAULT NULL
)
RETURNS TABLE(accepted BOOLEAN, retry_after_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = novel, public, pg_temp
AS $$
DECLARE
  latest_sent_at TIMESTAMPTZ;
  email_day_count INTEGER;
  ip_hour_count INTEGER;
  ip_day_count INTEGER;
BEGIN
  IF p_email = '' OR p_code_hash = '' OR p_ip_hash = '' THEN
    RAISE EXCEPTION 'invalid_registration_code_request' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_email, 31001));
  SELECT max(last_sent_at) INTO latest_sent_at
  FROM novel.registration_email_challenges
  WHERE normalized_email = p_email;
  IF latest_sent_at IS NOT NULL AND latest_sent_at > now() - INTERVAL '60 seconds' THEN
    RAISE EXCEPTION 'registration_code_cooldown' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO email_day_count
  FROM novel.registration_email_challenges
  WHERE normalized_email = p_email AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  SELECT count(*) INTO ip_hour_count
  FROM novel.registration_email_challenges
  WHERE ip_hash = p_ip_hash AND created_at > now() - INTERVAL '1 hour';
  SELECT count(*) INTO ip_day_count
  FROM novel.registration_email_challenges
  WHERE ip_hash = p_ip_hash AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  IF email_day_count >= 10 OR ip_hour_count >= 20 OR ip_day_count >= 100 THEN
    RAISE EXCEPTION 'registration_code_rate_limited' USING ERRCODE = 'P0001';
  END IF;

  UPDATE novel.registration_email_challenges
  SET consumed_at = COALESCE(consumed_at, now())
  WHERE normalized_email = p_email AND consumed_at IS NULL;

  INSERT INTO novel.registration_email_challenges(
    normalized_email, code_hash, ip_hash, expires_at
  ) VALUES (p_email, p_code_hash, p_ip_hash, now() + INTERVAL '10 minutes');

  INSERT INTO novel.system_email_outbox(
    scheduler_run_id, recipient, subject, text_body, html_body
  ) VALUES (NULL, p_email, p_subject, p_text_body, p_html_body);

  RETURN QUERY SELECT true, 60;
END;
$$;

CREATE OR REPLACE FUNCTION novel.verify_registration_email_code(
  p_email TEXT,
  p_code_hash TEXT,
  p_ticket_hash TEXT
)
RETURNS TABLE(status TEXT, ticket_id UUID, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = novel, public, pg_temp
AS $$
DECLARE
  challenge novel.registration_email_challenges%ROWTYPE;
  created_ticket novel.registration_tickets%ROWTYPE;
BEGIN
  SELECT * INTO challenge
  FROM novel.registration_email_challenges
  WHERE normalized_email = p_email AND consumed_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND OR challenge.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  IF challenge.failed_attempts >= 5 THEN
    RETURN QUERY SELECT 'attempts_exhausted'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  IF challenge.code_hash <> p_code_hash THEN
    UPDATE novel.registration_email_challenges
    SET failed_attempts = failed_attempts + 1
    WHERE id = challenge.id;
    IF challenge.failed_attempts + 1 >= 5 THEN
      RETURN QUERY SELECT 'attempts_exhausted'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'invalid'::TEXT, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  UPDATE novel.registration_email_challenges SET consumed_at = now() WHERE id = challenge.id;
  INSERT INTO novel.registration_tickets(normalized_email, ticket_hash, expires_at)
  VALUES (p_email, p_ticket_hash, now() + INTERVAL '15 minutes')
  RETURNING * INTO created_ticket;
  RETURN QUERY SELECT 'verified'::TEXT, created_ticket.id, created_ticket.expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION novel.reserve_registration_ticket(
  p_email TEXT,
  p_ticket_hash TEXT,
  p_reservation_hash TEXT,
  p_invite_code TEXT DEFAULT NULL
)
RETURNS TABLE(reservation_id UUID, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = novel, public, pg_temp
AS $$
DECLARE
  target_ticket novel.registration_tickets%ROWTYPE;
  created_reservation novel.registration_reservations%ROWTYPE;
BEGIN
  SELECT * INTO target_ticket
  FROM novel.registration_tickets
  WHERE ticket_hash = p_ticket_hash
  FOR UPDATE;
  IF NOT FOUND OR target_ticket.normalized_email <> p_email OR target_ticket.expires_at <= now()
     OR target_ticket.consumed_at IS NOT NULL OR target_ticket.reserved_at IS NOT NULL THEN
    RAISE EXCEPTION 'registration_ticket_invalid' USING ERRCODE = 'P0002';
  END IF;
  UPDATE novel.registration_tickets SET reserved_at = now() WHERE id = target_ticket.id;
  INSERT INTO novel.registration_reservations(
    ticket_id, reservation_hash, normalized_email, invite_code, expires_at
  ) VALUES (
    target_ticket.id, p_reservation_hash, p_email, NULLIF(upper(btrim(p_invite_code)), ''),
    now() + INTERVAL '5 minutes'
  ) RETURNING * INTO created_reservation;
  RETURN QUERY SELECT created_reservation.id, created_reservation.expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION novel.release_registration_reservation(p_reservation_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = novel, public, pg_temp
AS $$
DECLARE
  target novel.registration_reservations%ROWTYPE;
BEGIN
  SELECT * INTO target FROM novel.registration_reservations
  WHERE reservation_hash = p_reservation_hash FOR UPDATE;
  IF NOT FOUND OR target.finalized_at IS NOT NULL THEN RETURN false; END IF;
  UPDATE novel.registration_tickets SET reserved_at = NULL WHERE id = target.ticket_id;
  DELETE FROM novel.registration_reservations WHERE id = target.id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION novel.finalize_registration_reservation(
  p_reservation_hash TEXT,
  p_user_id UUID,
  p_email TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = novel, public, pg_temp
AS $$
DECLARE
  target novel.registration_reservations%ROWTYPE;
BEGIN
  SELECT * INTO target FROM novel.registration_reservations
  WHERE reservation_hash = p_reservation_hash FOR UPDATE;
  IF NOT FOUND OR target.normalized_email <> p_email THEN
    RAISE EXCEPTION 'registration_identity_mismatch' USING ERRCODE = '42501';
  END IF;
  IF target.finalized_at IS NOT NULL THEN RETURN target.finalized_user_id = p_user_id; END IF;
  IF target.expires_at <= now() THEN
    RAISE EXCEPTION 'registration_reservation_expired' USING ERRCODE = 'P0002';
  END IF;
  UPDATE novel.registration_reservations
  SET finalized_user_id = p_user_id, finalized_at = now()
  WHERE id = target.id;
  UPDATE novel.registration_tickets SET consumed_at = now() WHERE id = target.ticket_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION novel.reconcile_registration_reservations(
  p_now TIMESTAMPTZ DEFAULT now(),
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(finalized_count INTEGER, expired_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = novel, auth, public, pg_temp
AS $$
DECLARE
  finalized_total INTEGER := 0;
  expired_total INTEGER := 0;
  candidate RECORD;
  auth_user RECORD;
BEGIN
  FOR candidate IN
    SELECT reservation.*
    FROM novel.registration_reservations reservation
    WHERE reservation.finalized_at IS NULL
    ORDER BY reservation.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(p_limit, 0)
  LOOP
    SELECT users.id, lower(btrim(users.email)) AS normalized_email
    INTO auth_user
    FROM auth.users users
    WHERE lower(btrim(users.email)) = candidate.normalized_email
      AND users.created_at >= candidate.created_at - INTERVAL '5 seconds'
    ORDER BY users.created_at DESC
    LIMIT 1;
    IF FOUND THEN
      UPDATE novel.registration_reservations
      SET finalized_user_id = auth_user.id, finalized_at = p_now
      WHERE id = candidate.id;
      UPDATE novel.registration_tickets SET consumed_at = p_now WHERE id = candidate.ticket_id;
      finalized_total := finalized_total + 1;
    ELSIF candidate.expires_at <= p_now THEN
      UPDATE novel.registration_tickets SET reserved_at = NULL WHERE id = candidate.ticket_id;
      DELETE FROM novel.registration_reservations WHERE id = candidate.id;
      expired_total := expired_total + 1;
    END IF;
  END LOOP;
  RETURN QUERY SELECT finalized_total, expired_total;
END;
$$;

ALTER TABLE novel.registration_email_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.registration_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.registration_reservations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON novel.registration_email_challenges FROM PUBLIC, authenticated, anon;
REVOKE ALL ON novel.registration_tickets FROM PUBLIC, authenticated, anon;
REVOKE ALL ON novel.registration_reservations FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.request_registration_email_code(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.verify_registration_email_code(TEXT, TEXT, TEXT) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.reserve_registration_ticket(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.release_registration_reservation(TEXT) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.finalize_registration_reservation(TEXT, UUID, TEXT) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.reconcile_registration_reservations(TIMESTAMPTZ, INTEGER) FROM PUBLIC, authenticated, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON novel.registration_email_challenges TO project_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.registration_tickets TO project_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.registration_reservations TO project_admin;
GRANT EXECUTE ON FUNCTION novel.request_registration_email_code(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.verify_registration_email_code(TEXT, TEXT, TEXT) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.reserve_registration_ticket(TEXT, TEXT, TEXT, TEXT) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.release_registration_reservation(TEXT) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.finalize_registration_reservation(TEXT, UUID, TEXT) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.reconcile_registration_reservations(TIMESTAMPTZ, INTEGER) TO project_admin;

COMMIT;
