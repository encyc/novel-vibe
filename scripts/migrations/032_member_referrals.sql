-- Migration 032: verified-member referral campaign and atomic membership rewards.
BEGIN;

-- Referral rewards are membership entitlements, never Credit grants.
ALTER TABLE novel.membership_purchases DROP CONSTRAINT IF EXISTS membership_purchases_source_check;
ALTER TABLE novel.membership_purchases ADD CONSTRAINT membership_purchases_source_check
  CHECK (source IN ('purchase', 'gift', 'referral_reward'));

ALTER TABLE novel.registration_email_challenges ADD COLUMN IF NOT EXISTS invite_code TEXT;
ALTER TABLE novel.registration_email_challenges ADD COLUMN IF NOT EXISTS device_hash TEXT;
ALTER TABLE novel.registration_tickets ADD COLUMN IF NOT EXISTS invite_code TEXT;
ALTER TABLE novel.registration_tickets ADD COLUMN IF NOT EXISTS ip_hash TEXT;
ALTER TABLE novel.registration_tickets ADD COLUMN IF NOT EXISTS device_hash TEXT;
ALTER TABLE novel.registration_reservations ADD COLUMN IF NOT EXISTS ip_hash TEXT;
ALTER TABLE novel.registration_reservations ADD COLUMN IF NOT EXISTS device_hash TEXT;

CREATE TABLE IF NOT EXISTS novel.referral_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  binding_ends_at TIMESTAMPTZ NOT NULL,
  purchase_window_days INTEGER NOT NULL DEFAULT 30 CHECK (purchase_window_days > 0),
  reward_days INTEGER NOT NULL DEFAULT 10 CHECK (reward_days > 0),
  max_slots_per_inviter INTEGER NOT NULL DEFAULT 10 CHECK (max_slots_per_inviter > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS novel.referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES novel.referral_campaigns(id),
  user_id UUID NOT NULL,
  code TEXT NOT NULL CHECK (code = upper(code) AND length(code) = 8),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, user_id),
  UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS novel.referral_slot_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES novel.referral_campaigns(id),
  inviter_user_id UUID NOT NULL,
  registration_reservation_id UUID NOT NULL UNIQUE REFERENCES novel.registration_reservations(id) ON DELETE CASCADE,
  normalized_email TEXT NOT NULL,
  ip_hash TEXT,
  device_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS novel.referral_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES novel.referral_campaigns(id),
  inviter_user_id UUID NOT NULL,
  invitee_user_id UUID NOT NULL,
  invitee_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'risk_pending', 'successful', 'expired', 'rejected')),
  risk_reasons JSONB NOT NULL DEFAULT '[]',
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  purchase_deadline TIMESTAMPTZ NOT NULL,
  qualifying_purchase_id UUID REFERENCES novel.membership_purchases(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (inviter_user_id <> invitee_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_bindings_invitee_once
  ON novel.referral_bindings(invitee_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_bindings_purchase_once
  ON novel.referral_bindings(qualifying_purchase_id)
  WHERE qualifying_purchase_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_referral_bindings_inviter_status
  ON novel.referral_bindings(campaign_id, inviter_user_id, status);

CREATE TABLE IF NOT EXISTS novel.referral_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id UUID NOT NULL REFERENCES novel.referral_bindings(id),
  beneficiary_role TEXT NOT NULL CHECK (beneficiary_role IN ('inviter', 'invitee')),
  beneficiary_user_id UUID NOT NULL,
  membership_purchase_id UUID NOT NULL REFERENCES novel.membership_purchases(id),
  days INTEGER NOT NULL CHECK (days > 0),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (binding_id, beneficiary_role)
);

CREATE TABLE IF NOT EXISTS novel.referral_daily_metrics (
  campaign_id UUID NOT NULL REFERENCES novel.referral_campaigns(id),
  metric_date DATE NOT NULL,
  landing_count INTEGER NOT NULL DEFAULT 0,
  verified_email_count INTEGER NOT NULL DEFAULT 0,
  binding_count INTEGER NOT NULL DEFAULT 0,
  successful_count INTEGER NOT NULL DEFAULT 0,
  reward_days_total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, metric_date)
);

CREATE TABLE IF NOT EXISTS novel.referral_admin_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES novel.referral_campaigns(id),
  admin_user_id UUID NOT NULL,
  action TEXT NOT NULL,
  before_state JSONB NOT NULL DEFAULT '{}',
  after_state JSONB NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO novel.referral_campaigns
  (slug, binding_ends_at, purchase_window_days, reward_days, max_slots_per_inviter)
VALUES ('member-referral-2026', now(), 30, 10, 10)
ON CONFLICT (slug) DO NOTHING;

CREATE OR REPLACE FUNCTION novel.referral_user_is_active_member(p_user_id UUID, p_now TIMESTAMPTZ DEFAULT now())
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = novel, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM novel.membership_purchases
    WHERE user_id = p_user_id AND payment_status = 'completed' AND expires_at > p_now
  );
$$;

CREATE OR REPLACE FUNCTION novel.preview_referral_code(p_code TEXT)
RETURNS TABLE(valid BOOLEAN, code TEXT, reward_days INTEGER, purchase_window_days INTEGER,
  binding_ends_at TIMESTAMPTZ, unavailable_reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public, pg_temp AS $$
DECLARE c RECORD; used_slots INTEGER;
BEGIN
  SELECT rc.code, rc.user_id, campaign.* INTO c
  FROM novel.referral_codes rc JOIN novel.referral_campaigns campaign ON campaign.id = rc.campaign_id
  WHERE rc.code = upper(btrim(p_code));
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, upper(btrim(p_code)), 0, 0, NULL::TIMESTAMPTZ, 'invalid_code'::TEXT; RETURN;
  END IF;
  INSERT INTO novel.referral_daily_metrics(campaign_id, metric_date, landing_count)
  VALUES (c.id, (now() AT TIME ZONE 'UTC')::date, 1)
  ON CONFLICT (campaign_id, metric_date) DO UPDATE
    SET landing_count = novel.referral_daily_metrics.landing_count + 1;
  IF c.binding_ends_at <= now() THEN
    RETURN QUERY SELECT false, c.code, c.reward_days, c.purchase_window_days, c.binding_ends_at, 'campaign_closed'::TEXT; RETURN;
  END IF;
  IF NOT novel.referral_user_is_active_member(c.user_id) THEN
    RETURN QUERY SELECT false, c.code, c.reward_days, c.purchase_window_days, c.binding_ends_at, 'inviter_inactive'::TEXT; RETURN;
  END IF;
  SELECT
    (SELECT count(*) FROM novel.referral_slot_reservations s
      WHERE s.campaign_id = c.id AND s.inviter_user_id = c.user_id AND s.expires_at > now())
    + (SELECT count(*) FROM novel.referral_bindings b
      WHERE b.campaign_id = c.id AND b.inviter_user_id = c.user_id
        AND b.status IN ('pending', 'risk_pending', 'successful'))
  INTO used_slots;
  IF used_slots >= c.max_slots_per_inviter THEN
    RETURN QUERY SELECT false, c.code, c.reward_days, c.purchase_window_days, c.binding_ends_at, 'capacity_full'::TEXT; RETURN;
  END IF;
  RETURN QUERY SELECT true, c.code, c.reward_days, c.purchase_window_days, c.binding_ends_at, NULL::TEXT;
END;
$$;

-- Registration context starts at code send, preventing invitation swapping later.
DROP FUNCTION IF EXISTS novel.request_registration_email_code(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION novel.request_registration_email_code(
  p_email TEXT, p_code_hash TEXT, p_ip_hash TEXT, p_subject TEXT, p_text_body TEXT,
  p_html_body TEXT DEFAULT NULL, p_invite_code TEXT DEFAULT NULL, p_device_hash TEXT DEFAULT NULL
)
RETURNS TABLE(accepted BOOLEAN, retry_after_seconds INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public, pg_temp AS $$
DECLARE latest_sent_at TIMESTAMPTZ; email_day_count INTEGER; ip_hour_count INTEGER; ip_day_count INTEGER;
BEGIN
  IF p_email = '' OR p_code_hash = '' OR p_ip_hash = '' THEN
    RAISE EXCEPTION 'invalid_registration_code_request' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_email, 31001));
  SELECT max(last_sent_at) INTO latest_sent_at FROM novel.registration_email_challenges WHERE normalized_email = p_email;
  IF latest_sent_at IS NOT NULL AND latest_sent_at > now() - INTERVAL '60 seconds' THEN
    RAISE EXCEPTION 'registration_code_cooldown' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO email_day_count FROM novel.registration_email_challenges
    WHERE normalized_email = p_email AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  SELECT count(*) INTO ip_hour_count FROM novel.registration_email_challenges
    WHERE ip_hash = p_ip_hash AND created_at > now() - INTERVAL '1 hour';
  SELECT count(*) INTO ip_day_count FROM novel.registration_email_challenges
    WHERE ip_hash = p_ip_hash AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF email_day_count >= 10 OR ip_hour_count >= 20 OR ip_day_count >= 100 THEN
    RAISE EXCEPTION 'registration_code_rate_limited' USING ERRCODE = 'P0001';
  END IF;
  UPDATE novel.registration_email_challenges SET consumed_at = COALESCE(consumed_at, now())
    WHERE normalized_email = p_email AND consumed_at IS NULL;
  INSERT INTO novel.registration_email_challenges(
    normalized_email, code_hash, ip_hash, invite_code, device_hash, expires_at
  ) VALUES (p_email, p_code_hash, p_ip_hash, NULLIF(upper(btrim(p_invite_code)), ''), p_device_hash,
    now() + INTERVAL '10 minutes');
  INSERT INTO novel.system_email_outbox(scheduler_run_id, recipient, subject, text_body, html_body)
    VALUES (NULL, p_email, p_subject, p_text_body, p_html_body);
  RETURN QUERY SELECT true, 60;
END;
$$;

DROP FUNCTION IF EXISTS novel.verify_registration_email_code(TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION novel.verify_registration_email_code(
  p_email TEXT, p_code_hash TEXT, p_ticket_hash TEXT, p_invite_code TEXT DEFAULT NULL
)
RETURNS TABLE(status TEXT, ticket_id UUID, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public, pg_temp AS $$
DECLARE challenge novel.registration_email_challenges%ROWTYPE; created_ticket novel.registration_tickets%ROWTYPE;
BEGIN
  SELECT * INTO challenge FROM novel.registration_email_challenges
    WHERE normalized_email = p_email AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR challenge.expires_at <= now() THEN RETURN QUERY SELECT 'expired', NULL::UUID, NULL::TIMESTAMPTZ; RETURN; END IF;
  IF challenge.invite_code IS DISTINCT FROM NULLIF(upper(btrim(p_invite_code)), '') THEN
    RETURN QUERY SELECT 'invalid', NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
  END IF;
  IF challenge.failed_attempts >= 5 THEN RETURN QUERY SELECT 'attempts_exhausted', NULL::UUID, NULL::TIMESTAMPTZ; RETURN; END IF;
  IF challenge.code_hash <> p_code_hash THEN
    UPDATE novel.registration_email_challenges SET failed_attempts = failed_attempts + 1 WHERE id = challenge.id;
    RETURN QUERY SELECT CASE WHEN challenge.failed_attempts + 1 >= 5 THEN 'attempts_exhausted' ELSE 'invalid' END,
      NULL::UUID, NULL::TIMESTAMPTZ; RETURN;
  END IF;
  UPDATE novel.registration_email_challenges SET consumed_at = now() WHERE id = challenge.id;
  INSERT INTO novel.registration_tickets(normalized_email, ticket_hash, invite_code, ip_hash, device_hash, expires_at)
    VALUES (p_email, p_ticket_hash, challenge.invite_code, challenge.ip_hash, challenge.device_hash, now() + INTERVAL '15 minutes')
    RETURNING * INTO created_ticket;
  INSERT INTO novel.referral_daily_metrics(campaign_id, metric_date, verified_email_count)
    SELECT rc.campaign_id, (now() AT TIME ZONE 'UTC')::date, 1 FROM novel.referral_codes rc WHERE rc.code = challenge.invite_code
    ON CONFLICT (campaign_id, metric_date) DO UPDATE
      SET verified_email_count = novel.referral_daily_metrics.verified_email_count + 1;
  RETURN QUERY SELECT 'verified', created_ticket.id, created_ticket.expires_at;
END;
$$;

DROP FUNCTION IF EXISTS novel.reserve_registration_ticket(TEXT, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION novel.reserve_registration_ticket(
  p_email TEXT, p_ticket_hash TEXT, p_reservation_hash TEXT, p_invite_code TEXT DEFAULT NULL
)
RETURNS TABLE(reservation_id UUID, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public, pg_temp AS $$
DECLARE target_ticket novel.registration_tickets%ROWTYPE; created_reservation novel.registration_reservations%ROWTYPE;
  target_code RECORD; used_slots INTEGER;
BEGIN
  SELECT * INTO target_ticket FROM novel.registration_tickets WHERE ticket_hash = p_ticket_hash FOR UPDATE;
  IF NOT FOUND OR target_ticket.normalized_email <> p_email OR target_ticket.expires_at <= now()
    OR target_ticket.consumed_at IS NOT NULL OR target_ticket.reserved_at IS NOT NULL THEN
    RAISE EXCEPTION 'registration_ticket_invalid' USING ERRCODE = 'P0002';
  END IF;
  IF target_ticket.invite_code IS DISTINCT FROM NULLIF(upper(btrim(p_invite_code)), '') THEN
    RAISE EXCEPTION 'registration_invite_context_mismatch' USING ERRCODE = 'P0002';
  END IF;
  IF target_ticket.invite_code IS NOT NULL THEN
    SELECT rc.*, campaign.binding_ends_at, campaign.max_slots_per_inviter
      INTO target_code FROM novel.referral_codes rc
      JOIN novel.referral_campaigns campaign ON campaign.id = rc.campaign_id
      WHERE rc.code = target_ticket.invite_code;
    IF NOT FOUND THEN RAISE EXCEPTION 'referral_invalid_code' USING ERRCODE = 'P0002'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(target_code.campaign_id::TEXT || ':' || target_code.user_id::TEXT, 32001));
    IF target_code.binding_ends_at <= now() THEN RAISE EXCEPTION 'referral_campaign_closed' USING ERRCODE = 'P0002'; END IF;
    IF NOT novel.referral_user_is_active_member(target_code.user_id) THEN
      RAISE EXCEPTION 'referral_inviter_inactive' USING ERRCODE = 'P0002';
    END IF;
    IF EXISTS (SELECT 1 FROM auth.users u WHERE u.id = target_code.user_id AND lower(btrim(u.email)) = p_email) THEN
      RAISE EXCEPTION 'referral_self_invite' USING ERRCODE = 'P0002';
    END IF;
    SELECT
      (SELECT count(*) FROM novel.referral_slot_reservations s WHERE s.campaign_id = target_code.campaign_id
        AND s.inviter_user_id = target_code.user_id AND s.expires_at > now())
      + (SELECT count(*) FROM novel.referral_bindings b WHERE b.campaign_id = target_code.campaign_id
        AND b.inviter_user_id = target_code.user_id AND b.status IN ('pending', 'risk_pending', 'successful'))
      INTO used_slots;
    IF used_slots >= target_code.max_slots_per_inviter THEN RAISE EXCEPTION 'referral_capacity_full' USING ERRCODE = 'P0002'; END IF;
  END IF;
  UPDATE novel.registration_tickets SET reserved_at = now() WHERE id = target_ticket.id;
  INSERT INTO novel.registration_reservations(ticket_id, reservation_hash, normalized_email, invite_code, ip_hash, device_hash, expires_at)
    VALUES (target_ticket.id, p_reservation_hash, p_email, target_ticket.invite_code, target_ticket.ip_hash,
      target_ticket.device_hash, now() + INTERVAL '5 minutes') RETURNING * INTO created_reservation;
  IF target_ticket.invite_code IS NOT NULL THEN
    INSERT INTO novel.referral_slot_reservations(campaign_id, inviter_user_id, registration_reservation_id,
      normalized_email, ip_hash, device_hash, expires_at)
    VALUES (target_code.campaign_id, target_code.user_id, created_reservation.id, p_email,
      target_ticket.ip_hash, target_ticket.device_hash, created_reservation.expires_at);
  END IF;
  RETURN QUERY SELECT created_reservation.id, created_reservation.expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION novel.generate_referral_code()
RETURNS TEXT LANGUAGE plpgsql VOLATILE AS $$
DECLARE alphabet TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; result TEXT := '';
BEGIN
  FOR i IN 1..8 LOOP result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::INTEGER, 1); END LOOP;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION novel.ensure_referral_code(p_user_id UUID, p_campaign_id UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public, pg_temp AS $$
DECLARE result TEXT;
BEGIN
  SELECT code INTO result FROM novel.referral_codes WHERE campaign_id = p_campaign_id AND user_id = p_user_id;
  WHILE result IS NULL LOOP
    result := novel.generate_referral_code();
    BEGIN
      INSERT INTO novel.referral_codes(campaign_id, user_id, code) VALUES (p_campaign_id, p_user_id, result);
    EXCEPTION WHEN unique_violation THEN
      SELECT code INTO result FROM novel.referral_codes WHERE campaign_id = p_campaign_id AND user_id = p_user_id;
    END;
  END LOOP;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION novel.finalize_registration_reservation(
  p_reservation_hash TEXT, p_user_id UUID, p_email TEXT
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, auth, public, pg_temp AS $$
DECLARE target novel.registration_reservations%ROWTYPE; slot RECORD; campaign RECORD;
  risk JSONB := '[]'::JSONB; same_device_count INTEGER; same_ip_count INTEGER;
BEGIN
  SELECT * INTO target FROM novel.registration_reservations WHERE reservation_hash = p_reservation_hash FOR UPDATE;
  IF NOT FOUND OR target.normalized_email <> p_email THEN RAISE EXCEPTION 'registration_identity_mismatch' USING ERRCODE = '42501'; END IF;
  IF target.finalized_at IS NOT NULL THEN RETURN target.finalized_user_id = p_user_id; END IF;
  IF target.expires_at <= now() THEN RAISE EXCEPTION 'registration_reservation_expired' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM novel.referral_bindings WHERE invitee_user_id = p_user_id) THEN
    RAISE EXCEPTION 'referral_binding_immutable' USING ERRCODE = '23505';
  END IF;
  SELECT s.*, c.purchase_window_days INTO slot FROM novel.referral_slot_reservations s
    JOIN novel.referral_campaigns c ON c.id = s.campaign_id WHERE s.registration_reservation_id = target.id FOR UPDATE OF s;
  IF FOUND THEN
    IF slot.inviter_user_id = p_user_id THEN RAISE EXCEPTION 'referral_self_invite' USING ERRCODE = '23514'; END IF;
    IF target.device_hash IS NOT NULL AND target.ip_hash IS NOT NULL AND EXISTS (
      SELECT 1 FROM auth.users u JOIN novel.registration_reservations rr ON rr.finalized_user_id = u.id
      WHERE u.id = slot.inviter_user_id AND rr.ip_hash = target.ip_hash AND rr.device_hash = target.device_hash
    ) THEN risk := risk || '["shared_ip_and_device"]'::JSONB; END IF;
    SELECT count(*) INTO same_device_count FROM novel.referral_bindings b
      JOIN novel.registration_reservations rr ON rr.finalized_user_id = b.invitee_user_id
      WHERE b.inviter_user_id = slot.inviter_user_id AND rr.device_hash = target.device_hash
        AND b.bound_at > now() - INTERVAL '24 hours';
    IF target.device_hash IS NOT NULL AND same_device_count >= 2 THEN risk := risk || '["device_velocity"]'::JSONB; END IF;
    SELECT count(*) INTO same_ip_count FROM novel.referral_bindings b
      JOIN novel.registration_reservations rr ON rr.finalized_user_id = b.invitee_user_id
      WHERE b.inviter_user_id = slot.inviter_user_id AND rr.ip_hash = target.ip_hash
        AND b.bound_at > now() - INTERVAL '24 hours';
    IF target.ip_hash IS NOT NULL AND same_ip_count >= 4 THEN risk := risk || '["ip_velocity"]'::JSONB; END IF;
    INSERT INTO novel.referral_bindings(campaign_id, inviter_user_id, invitee_user_id, invitee_email,
      status, risk_reasons, purchase_deadline)
    VALUES (slot.campaign_id, slot.inviter_user_id, p_user_id, p_email,
      CASE WHEN jsonb_array_length(risk) > 0 THEN 'risk_pending' ELSE 'pending' END,
      risk, now() + make_interval(days => slot.purchase_window_days));
    DELETE FROM novel.referral_slot_reservations WHERE registration_reservation_id = target.id;
    INSERT INTO novel.referral_daily_metrics(campaign_id, metric_date, binding_count)
      VALUES (slot.campaign_id, (now() AT TIME ZONE 'UTC')::date, 1)
      ON CONFLICT (campaign_id, metric_date) DO UPDATE SET binding_count = novel.referral_daily_metrics.binding_count + 1;
    PERFORM novel.ensure_referral_code(p_user_id, slot.campaign_id);
  ELSE
    SELECT * INTO campaign FROM novel.referral_campaigns ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN PERFORM novel.ensure_referral_code(p_user_id, campaign.id); END IF;
  END IF;
  UPDATE novel.registration_reservations SET finalized_user_id = p_user_id, finalized_at = now() WHERE id = target.id;
  UPDATE novel.registration_tickets SET consumed_at = now() WHERE id = target.ticket_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION novel.reconcile_registration_reservations(
  p_now TIMESTAMPTZ DEFAULT now(), p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(finalized_count INTEGER, expired_count INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, auth, public, pg_temp AS $$
DECLARE finalized_total INTEGER := 0; expired_total INTEGER := 0; candidate RECORD; auth_user RECORD;
BEGIN
  FOR candidate IN
    SELECT reservation.* FROM novel.registration_reservations reservation
    WHERE reservation.finalized_at IS NULL ORDER BY reservation.created_at
    FOR UPDATE SKIP LOCKED LIMIT greatest(p_limit, 0)
  LOOP
    SELECT users.id, lower(btrim(users.email)) AS normalized_email INTO auth_user
    FROM auth.users users
    WHERE lower(btrim(users.email)) = candidate.normalized_email
      AND users.created_at >= candidate.created_at - INTERVAL '5 seconds'
    ORDER BY users.created_at DESC LIMIT 1;
    IF FOUND THEN
      PERFORM novel.finalize_registration_reservation(candidate.reservation_hash, auth_user.id, auth_user.normalized_email);
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

CREATE OR REPLACE FUNCTION novel.get_referral_dashboard(p_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public, pg_temp AS $$
DECLARE campaign RECORD; code_value TEXT; successful INTEGER; pending INTEGER; result JSONB;
BEGIN
  SELECT * INTO campaign FROM novel.referral_campaigns ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN '{}'::JSONB; END IF;
  code_value := novel.ensure_referral_code(p_user_id, campaign.id);
  SELECT count(*) FILTER (WHERE status = 'successful'),
    count(*) FILTER (WHERE status IN ('pending', 'risk_pending'))
    INTO successful, pending FROM novel.referral_bindings
    WHERE campaign_id = campaign.id AND inviter_user_id = p_user_id;
  SELECT jsonb_build_object(
    'code', code_value,
    'can_invite', campaign.binding_ends_at > now() AND novel.referral_user_is_active_member(p_user_id)
      AND successful + pending < campaign.max_slots_per_inviter,
    'campaign', jsonb_build_object('binding_ends_at', campaign.binding_ends_at, 'reward_days', campaign.reward_days,
      'max_slots', campaign.max_slots_per_inviter),
    'counts', jsonb_build_object('successful', successful, 'pending', pending,
      'remaining', greatest(0, campaign.max_slots_per_inviter - successful - pending)),
    'invitations', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'email', b.invitee_email,
      'bound_at', b.bound_at, 'purchase_deadline', b.purchase_deadline, 'status', b.status) ORDER BY b.bound_at DESC)
      FROM novel.referral_bindings b WHERE b.campaign_id = campaign.id AND b.inviter_user_id = p_user_id), '[]'::JSONB),
    'invitee_binding', (SELECT jsonb_build_object('status', b.status, 'purchase_deadline', b.purchase_deadline)
      FROM novel.referral_bindings b WHERE b.invitee_user_id = p_user_id),
    'rewards', COALESCE((SELECT jsonb_agg(jsonb_build_object('role', r.beneficiary_role, 'days', r.days,
      'granted_at', r.granted_at, 'expires_at', r.expires_at) ORDER BY r.granted_at DESC)
      FROM novel.referral_rewards r WHERE r.beneficiary_user_id = p_user_id), '[]'::JSONB)
  ) INTO result;
  RETURN result;
END;
$$;

DROP FUNCTION IF EXISTS novel.complete_membership_purchase(TEXT, TEXT);
CREATE FUNCTION novel.complete_membership_purchase(p_out_trade_no TEXT, p_payment_id TEXT)
RETURNS TABLE(payment_status TEXT, expires_at TIMESTAMPTZ, bonus_credited NUMERIC,
  referral_status TEXT, referral_reward_days INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public, pg_temp AS $$
DECLARE purchase novel.membership_purchases%ROWTYPE; binding novel.referral_bindings%ROWTYPE;
  campaign novel.referral_campaigns%ROWTYPE; monthly_plan novel.membership_plans%ROWTYPE;
  current_max TIMESTAMPTZ; new_expires TIMESTAMPTZ; balance NUMERIC(16,2); bonus NUMERIC(16,2);
  prior_paid_count INTEGER; beneficiary RECORD; reward_expires TIMESTAMPTZ; reward_purchase_id UUID;
BEGIN
  SELECT * INTO purchase FROM novel.membership_purchases WHERE out_trade_no = p_out_trade_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase not found' USING ERRCODE = 'P0002'; END IF;
  IF purchase.payment_status = 'completed' THEN
    SELECT b.status, c.reward_days INTO referral_status, referral_reward_days
      FROM novel.referral_bindings b JOIN novel.referral_campaigns c ON c.id = b.campaign_id
      WHERE b.qualifying_purchase_id = purchase.id;
    RETURN QUERY SELECT 'completed', purchase.expires_at, 0::NUMERIC, referral_status, referral_reward_days; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(purchase.user_id::TEXT, 32002));
  SELECT max(mp.expires_at) INTO current_max FROM novel.membership_purchases mp
    WHERE mp.user_id = purchase.user_id AND mp.payment_status = 'completed';
  new_expires := greatest(now(), COALESCE(current_max, now())) + make_interval(days => purchase.duration_days_snapshot);
  UPDATE novel.membership_purchases SET expires_at = new_expires, payment_status = 'completed', payment_id = p_payment_id,
    completed_at = now() WHERE id = purchase.id;
  bonus := purchase.bonus_credits_snapshot;
  IF bonus > 0 THEN
    INSERT INTO novel.credit_balances(user_id, balance, total_granted) VALUES (purchase.user_id, bonus, bonus)
    ON CONFLICT (user_id) DO UPDATE SET balance = novel.credit_balances.balance + EXCLUDED.balance,
      total_granted = novel.credit_balances.total_granted + EXCLUDED.total_granted, updated_at = now()
    RETURNING novel.credit_balances.balance INTO balance;
    INSERT INTO novel.credit_transactions(user_id, type, amount, balance_after, description, reference_type, reference_id, metadata)
    VALUES (purchase.user_id, 'topup', bonus, balance, COALESCE(purchase.plan_name_snapshot, 'Membership bonus'),
      'membership_purchase', purchase.out_trade_no, jsonb_build_object('payment_id', p_payment_id))
    ON CONFLICT (reference_type, reference_id) WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL DO NOTHING;
  END IF;
  SELECT * INTO binding FROM novel.referral_bindings b
    WHERE b.invitee_user_id = purchase.user_id AND b.status IN ('pending', 'risk_pending') FOR UPDATE;
  referral_status := NULL; referral_reward_days := 0;
  IF FOUND THEN
    referral_status := binding.status;
    IF binding.status = 'risk_pending' THEN
      SELECT count(*) INTO prior_paid_count FROM novel.membership_purchases mp
        WHERE mp.user_id = purchase.user_id AND mp.source = 'purchase'
          AND mp.payment_status = 'completed' AND mp.id <> purchase.id;
      SELECT * INTO monthly_plan FROM novel.membership_plans WHERE slug = 'monthly';
      IF now() <= binding.purchase_deadline AND prior_paid_count = 0 AND purchase.source = 'purchase'
        AND purchase.plan_id = monthly_plan.id AND purchase.price_cents = monthly_plan.price_cents THEN
        UPDATE novel.referral_bindings SET qualifying_purchase_id = purchase.id, updated_at = now()
          WHERE id = binding.id AND qualifying_purchase_id IS NULL;
      END IF;
    END IF;
    IF binding.status = 'pending' THEN
      SELECT count(*) INTO prior_paid_count FROM novel.membership_purchases mp
        WHERE mp.user_id = purchase.user_id AND mp.source = 'purchase' AND mp.payment_status = 'completed' AND mp.id <> purchase.id;
      SELECT * INTO monthly_plan FROM novel.membership_plans WHERE slug = 'monthly';
      IF now() <= binding.purchase_deadline AND prior_paid_count = 0 AND purchase.source = 'purchase'
        AND purchase.plan_id = monthly_plan.id AND purchase.price_cents = monthly_plan.price_cents THEN
        SELECT * INTO campaign FROM novel.referral_campaigns WHERE id = binding.campaign_id;
        FOR beneficiary IN SELECT binding.inviter_user_id AS user_id, 'inviter'::TEXT AS role
          UNION ALL SELECT binding.invitee_user_id, 'invitee'::TEXT LOOP
          SELECT max(mp.expires_at) INTO current_max FROM novel.membership_purchases mp
            WHERE mp.user_id = beneficiary.user_id AND mp.payment_status = 'completed';
          reward_expires := greatest(now(), COALESCE(current_max, now())) + make_interval(days => campaign.reward_days);
          INSERT INTO novel.membership_purchases(user_id, out_trade_no, plan_id, plan_name_snapshot, price_cents,
            duration_days_snapshot, bonus_credits_snapshot, features_snapshot, payment_provider, payment_id,
            payment_status, source, expires_at, completed_at)
          VALUES (beneficiary.user_id, 'RR-' || binding.id::TEXT || '-' || beneficiary.role, purchase.plan_id,
            purchase.plan_name_snapshot, 0, campaign.reward_days, 0::NUMERIC, purchase.features_snapshot,
            'referral', p_payment_id, 'completed', 'referral_reward', reward_expires, now())
          RETURNING id INTO reward_purchase_id;
          INSERT INTO novel.referral_rewards(binding_id, beneficiary_role, beneficiary_user_id,
            membership_purchase_id, days, expires_at)
          VALUES (binding.id, beneficiary.role, beneficiary.user_id, reward_purchase_id, campaign.reward_days, reward_expires);
          INSERT INTO novel.system_email_outbox(scheduler_run_id, recipient, subject, text_body)
            SELECT NULL, u.email, '[Novel Vibe] 邀请奖励已到账',
              '邀请活动奖励已到账：会员有效期增加 ' || campaign.reward_days || ' 天。'
            FROM auth.users u WHERE u.id = beneficiary.user_id;
        END LOOP;
        UPDATE novel.referral_bindings SET status = 'successful', qualifying_purchase_id = purchase.id,
          resolved_at = now(), updated_at = now() WHERE id = binding.id;
        INSERT INTO novel.referral_daily_metrics(campaign_id, metric_date, successful_count, reward_days_total)
          VALUES (campaign.id, (now() AT TIME ZONE 'UTC')::date, 1, campaign.reward_days * 2)
          ON CONFLICT (campaign_id, metric_date) DO UPDATE SET
            successful_count = novel.referral_daily_metrics.successful_count + 1,
            reward_days_total = novel.referral_daily_metrics.reward_days_total + EXCLUDED.reward_days_total;
        referral_status := 'successful'; referral_reward_days := campaign.reward_days;
      ELSIF now() > binding.purchase_deadline OR prior_paid_count > 0 THEN
        UPDATE novel.referral_bindings SET status = 'expired', resolved_at = now(), updated_at = now() WHERE id = binding.id;
        referral_status := 'expired';
      END IF;
    END IF;
  END IF;
  RETURN QUERY SELECT 'completed', new_expires, bonus, referral_status, referral_reward_days;
END;
$$;

CREATE OR REPLACE FUNCTION novel.update_referral_campaign(
  p_binding_ends_at TIMESTAMPTZ, p_admin_user_id UUID, p_reason TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public, pg_temp AS $$
DECLARE target novel.referral_campaigns%ROWTYPE; before_state JSONB; after_state JSONB;
BEGIN
  IF p_binding_ends_at IS NULL OR btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'invalid_campaign_update' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('referral-campaign-update', 32003));
  SELECT * INTO target FROM novel.referral_campaigns ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'referral_campaign_missing' USING ERRCODE = 'P0002'; END IF;
  before_state := jsonb_build_object('binding_ends_at', target.binding_ends_at);
  UPDATE novel.referral_campaigns SET binding_ends_at = p_binding_ends_at, updated_at = now()
    WHERE id = target.id RETURNING jsonb_build_object(
      'id', id, 'slug', slug, 'binding_ends_at', binding_ends_at,
      'purchase_window_days', purchase_window_days, 'reward_days', reward_days,
      'max_slots_per_inviter', max_slots_per_inviter
    ) INTO after_state;
  INSERT INTO novel.referral_admin_audit(campaign_id, admin_user_id, action, before_state, after_state, reason)
    VALUES (target.id, p_admin_user_id, 'update_deadline', before_state, after_state, btrim(p_reason));
  RETURN after_state;
END;
$$;

CREATE OR REPLACE FUNCTION novel.get_referral_admin_metrics()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = novel, public, pg_temp AS $$
DECLARE campaign novel.referral_campaigns%ROWTYPE;
BEGIN
  SELECT * INTO campaign FROM novel.referral_campaigns ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN '{}'::JSONB; END IF;
  RETURN jsonb_build_object(
    'campaign', jsonb_build_object('id', campaign.id, 'slug', campaign.slug,
      'binding_ends_at', campaign.binding_ends_at, 'purchase_window_days', campaign.purchase_window_days,
      'reward_days', campaign.reward_days, 'max_slots_per_inviter', campaign.max_slots_per_inviter),
    'totals', jsonb_build_object(
      'landings', COALESCE((SELECT sum(landing_count) FROM novel.referral_daily_metrics WHERE campaign_id = campaign.id), 0),
      'verified_emails', COALESCE((SELECT sum(verified_email_count) FROM novel.referral_daily_metrics WHERE campaign_id = campaign.id), 0),
      'bindings', COALESCE((SELECT count(*) FROM novel.referral_bindings WHERE campaign_id = campaign.id), 0),
      'pending', COALESCE((SELECT count(*) FROM novel.referral_bindings WHERE campaign_id = campaign.id AND status = 'pending'), 0),
      'risk_pending', COALESCE((SELECT count(*) FROM novel.referral_bindings WHERE campaign_id = campaign.id AND status = 'risk_pending'), 0),
      'expired', COALESCE((SELECT count(*) FROM novel.referral_bindings WHERE campaign_id = campaign.id AND status = 'expired'), 0),
      'successful', COALESCE((SELECT count(*) FROM novel.referral_bindings WHERE campaign_id = campaign.id AND status = 'successful'), 0),
      'reward_days', COALESCE((SELECT sum(days) FROM novel.referral_rewards r
        JOIN novel.referral_bindings b ON b.id = r.binding_id WHERE b.campaign_id = campaign.id), 0)
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION novel.list_referral_admin_bindings(
  p_search TEXT DEFAULT NULL, p_cursor TIMESTAMPTZ DEFAULT NULL, p_limit INTEGER DEFAULT 50
)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = novel, auth, public, pg_temp AS $$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', rows.id, 'inviter_user_id', rows.inviter_user_id, 'invitee_user_id', rows.invitee_user_id,
      'invitee_email', rows.invitee_email, 'status', rows.status, 'risk_reasons', rows.risk_reasons,
      'bound_at', rows.bound_at, 'purchase_deadline', rows.purchase_deadline,
      'qualifying_purchase_id', rows.qualifying_purchase_id
    ) ORDER BY rows.bound_at DESC)
    FROM (
      SELECT b.* FROM novel.referral_bindings b
      LEFT JOIN auth.users inviter ON inviter.id = b.inviter_user_id
      WHERE (p_cursor IS NULL OR b.bound_at < p_cursor)
        AND (NULLIF(btrim(p_search), '') IS NULL OR b.invitee_email ILIKE '%' || btrim(p_search) || '%'
          OR inviter.email ILIKE '%' || btrim(p_search) || '%')
      ORDER BY b.bound_at DESC LIMIT least(greatest(p_limit, 1), 100)
    ) rows
  ), '[]'::JSONB);
END;
$$;

CREATE OR REPLACE FUNCTION novel.review_referral_binding(
  p_binding_id UUID, p_decision TEXT, p_admin_user_id UUID, p_reason TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, auth, public, pg_temp AS $$
DECLARE binding novel.referral_bindings%ROWTYPE; purchase novel.membership_purchases%ROWTYPE;
  campaign novel.referral_campaigns%ROWTYPE; beneficiary RECORD; current_max TIMESTAMPTZ;
  reward_expires TIMESTAMPTZ; reward_purchase_id UUID; before_state JSONB;
BEGIN
  IF p_decision NOT IN ('approve', 'reject') OR btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'invalid_referral_review' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO binding FROM novel.referral_bindings WHERE id = p_binding_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'referral_binding_missing' USING ERRCODE = 'P0002'; END IF;
  IF binding.status IN ('successful', 'rejected') THEN
    RETURN jsonb_build_object('id', binding.id, 'status', binding.status);
  END IF;
  IF binding.status <> 'risk_pending' THEN RAISE EXCEPTION 'referral_review_not_pending' USING ERRCODE = 'P0001'; END IF;
  before_state := to_jsonb(binding);
  IF p_decision = 'reject' THEN
    UPDATE novel.referral_bindings SET status = 'rejected', resolved_at = now(), updated_at = now()
      WHERE id = binding.id;
  ELSE
    IF binding.qualifying_purchase_id IS NULL THEN
      RAISE EXCEPTION 'referral_qualifying_purchase_missing' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO purchase FROM novel.membership_purchases WHERE id = binding.qualifying_purchase_id;
    SELECT * INTO campaign FROM novel.referral_campaigns WHERE id = binding.campaign_id;
    FOR beneficiary IN SELECT binding.inviter_user_id AS user_id, 'inviter'::TEXT AS role
      UNION ALL SELECT binding.invitee_user_id, 'invitee'::TEXT LOOP
      SELECT max(mp.expires_at) INTO current_max FROM novel.membership_purchases mp
        WHERE mp.user_id = beneficiary.user_id AND mp.payment_status = 'completed';
      reward_expires := greatest(now(), COALESCE(current_max, now())) + make_interval(days => campaign.reward_days);
      INSERT INTO novel.membership_purchases(user_id, out_trade_no, plan_id, plan_name_snapshot, price_cents,
        duration_days_snapshot, bonus_credits_snapshot, features_snapshot, payment_provider, payment_id,
        payment_status, source, expires_at, completed_at)
      VALUES (beneficiary.user_id, 'RR-' || binding.id::TEXT || '-' || beneficiary.role, purchase.plan_id,
        purchase.plan_name_snapshot, 0, campaign.reward_days, 0::NUMERIC, purchase.features_snapshot,
        'referral', purchase.payment_id, 'completed', 'referral_reward', reward_expires, now())
      ON CONFLICT (out_trade_no) DO UPDATE SET out_trade_no = EXCLUDED.out_trade_no
      RETURNING id, expires_at INTO reward_purchase_id, reward_expires;
      INSERT INTO novel.referral_rewards(binding_id, beneficiary_role, beneficiary_user_id,
        membership_purchase_id, days, expires_at)
      VALUES (binding.id, beneficiary.role, beneficiary.user_id, reward_purchase_id, campaign.reward_days, reward_expires)
      ON CONFLICT (binding_id, beneficiary_role) DO NOTHING;
    END LOOP;
    UPDATE novel.referral_bindings SET status = 'successful', resolved_at = now(), updated_at = now()
      WHERE id = binding.id;
  END IF;
  INSERT INTO novel.referral_admin_audit(campaign_id, admin_user_id, action, before_state, after_state, reason)
    SELECT binding.campaign_id, p_admin_user_id, p_decision, before_state, to_jsonb(b), btrim(p_reason)
    FROM novel.referral_bindings b WHERE b.id = binding.id;
  RETURN (SELECT jsonb_build_object('id', b.id, 'status', b.status) FROM novel.referral_bindings b WHERE b.id = binding.id);
END;
$$;

CREATE OR REPLACE FUNCTION novel.expire_referral_bindings(p_now TIMESTAMPTZ DEFAULT now(), p_limit INTEGER DEFAULT 500)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = novel, public, pg_temp AS $$
DECLARE expired_count INTEGER;
BEGIN
  WITH candidates AS (
    SELECT id FROM novel.referral_bindings WHERE status = 'pending' AND purchase_deadline < p_now
    ORDER BY purchase_deadline FOR UPDATE SKIP LOCKED LIMIT greatest(p_limit, 0)
  )
  UPDATE novel.referral_bindings b SET status = 'expired', resolved_at = p_now, updated_at = p_now
    FROM candidates WHERE b.id = candidates.id;
  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$;

ALTER TABLE novel.referral_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.referral_slot_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.referral_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.referral_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.referral_daily_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.referral_admin_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON novel.referral_campaigns FROM PUBLIC, authenticated, anon;
REVOKE ALL ON novel.referral_codes FROM PUBLIC, authenticated, anon;
REVOKE ALL ON novel.referral_slot_reservations FROM PUBLIC, authenticated, anon;
REVOKE ALL ON novel.referral_bindings FROM PUBLIC, authenticated, anon;
REVOKE ALL ON novel.referral_rewards FROM PUBLIC, authenticated, anon;
REVOKE ALL ON novel.referral_daily_metrics FROM PUBLIC, authenticated, anon;
REVOKE ALL ON novel.referral_admin_audit FROM PUBLIC, authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.referral_campaigns TO project_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.referral_codes TO project_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.referral_slot_reservations TO project_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.referral_bindings TO project_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.referral_rewards TO project_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.referral_daily_metrics TO project_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.referral_admin_audit TO project_admin;

REVOKE ALL ON FUNCTION novel.preview_referral_code(TEXT) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.get_referral_dashboard(UUID) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.expire_referral_bindings(TIMESTAMPTZ, INTEGER) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.complete_membership_purchase(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION novel.update_referral_campaign(TIMESTAMPTZ, UUID, TEXT) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.get_referral_admin_metrics() FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.list_referral_admin_bindings(TEXT, TIMESTAMPTZ, INTEGER) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.review_referral_binding(UUID, TEXT, UUID, TEXT) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.request_registration_email_code(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.verify_registration_email_code(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.reserve_registration_ticket(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.finalize_registration_reservation(TEXT, UUID, TEXT) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION novel.preview_referral_code(TEXT) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.get_referral_dashboard(UUID) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.expire_referral_bindings(TIMESTAMPTZ, INTEGER) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.complete_membership_purchase(TEXT, TEXT) TO postgres, project_admin;
GRANT EXECUTE ON FUNCTION novel.update_referral_campaign(TIMESTAMPTZ, UUID, TEXT) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.get_referral_admin_metrics() TO project_admin;
GRANT EXECUTE ON FUNCTION novel.list_referral_admin_bindings(TEXT, TIMESTAMPTZ, INTEGER) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.review_referral_binding(UUID, TEXT, UUID, TEXT) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.request_registration_email_code(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.verify_registration_email_code(TEXT, TEXT, TEXT, TEXT) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.reserve_registration_ticket(TEXT, TEXT, TEXT, TEXT) TO project_admin;
GRANT EXECUTE ON FUNCTION novel.finalize_registration_reservation(TEXT, UUID, TEXT) TO project_admin;

COMMIT;
