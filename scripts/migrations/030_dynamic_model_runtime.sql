BEGIN;

CREATE TABLE IF NOT EXISTS novel.model_runtime_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  model_id TEXT NOT NULL CHECK (length(btrim(model_id)) > 0),
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  api TEXT NOT NULL CHECK (api IN (
    'anthropic-messages',
    'google-generative-ai',
    'openai-responses',
    'openai-completions'
  )),
  base_url TEXT NOT NULL CHECK (length(btrim(base_url)) > 0),
  context_window INTEGER NOT NULL CHECK (context_window > 0),
  max_tokens INTEGER NOT NULL CHECK (max_tokens > 0),
  reasoning BOOLEAN NOT NULL DEFAULT false,
  input_modalities TEXT[] NOT NULL DEFAULT ARRAY['text']::TEXT[],
  source TEXT NOT NULL CHECK (source IN ('pi-ai', 'opencode-dynamic')),
  runtime_fingerprint TEXT NOT NULL CHECK (length(btrim(runtime_fingerprint)) > 0),
  source_hashes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'retired')),
  disabled_reason TEXT,
  disabled_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, model_id)
);

CREATE INDEX IF NOT EXISTS idx_model_runtime_catalog_status
  ON novel.model_runtime_catalog(provider, status, model_id);

CREATE TABLE IF NOT EXISTS novel.model_runtime_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_model_id UUID NOT NULL
    REFERENCES novel.model_runtime_catalog(id) ON DELETE CASCADE,
  runtime_fingerprint TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (length(btrim(classification)) > 0),
  error_code TEXT,
  error_summary TEXT NOT NULL,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_model_runtime_incidents_runtime
  ON novel.model_runtime_incidents(runtime_model_id, created_at DESC);

CREATE OR REPLACE FUNCTION novel.disable_dynamic_model(
  p_provider TEXT,
  p_model_id TEXT,
  p_runtime_fingerprint TEXT,
  p_classification TEXT,
  p_error_code TEXT DEFAULT NULL,
  p_error_summary TEXT DEFAULT '',
  p_request_id TEXT DEFAULT NULL,
  p_recipient TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = novel, pg_temp
AS $function$
DECLARE
  v_runtime_id UUID;
  v_error_summary TEXT := left(coalesce(p_error_summary, ''), 1000);
BEGIN
  UPDATE novel.model_runtime_catalog AS runtime
  SET status = 'disabled',
      disabled_reason = p_classification,
      disabled_at = now(),
      updated_at = now()
  WHERE runtime.provider = p_provider
    AND runtime.model_id = p_model_id
    AND runtime.runtime_fingerprint = p_runtime_fingerprint
    AND runtime.status = 'active'
  RETURNING runtime.id INTO v_runtime_id;

  IF v_runtime_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO novel.model_runtime_incidents (
    runtime_model_id,
    runtime_fingerprint,
    classification,
    error_code,
    error_summary,
    request_id
  ) VALUES (
    v_runtime_id,
    p_runtime_fingerprint,
    p_classification,
    p_error_code,
    v_error_summary,
    p_request_id
  );

  UPDATE novel.credit_rates AS rate
  SET is_active = false,
      updated_at = now()
  WHERE rate.provider_pattern = p_provider
    AND rate.model_pattern = p_model_id
    AND rate.is_active = true;

  IF length(btrim(coalesce(p_recipient, ''))) > 0 THEN
    INSERT INTO novel.system_email_outbox (
      recipient,
      subject,
      text_body
    ) VALUES (
      p_recipient,
      '[Novel Vibe] Dynamic model disabled: ' || p_model_id,
      concat(
        'Provider: ', p_provider, E'\n',
        'Model: ', p_model_id, E'\n',
        'Classification: ', p_classification, E'\n',
        'Error code: ', coalesce(p_error_code, 'unknown'), E'\n',
        'Request ID: ', coalesce(p_request_id, 'unknown'), E'\n',
        'Summary: ', v_error_summary
      )
    );
  END IF;

  RETURN true;
END;
$function$;

ALTER TABLE novel.model_runtime_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE novel.model_runtime_incidents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON novel.model_runtime_catalog FROM PUBLIC, authenticated, anon;
REVOKE ALL ON novel.model_runtime_incidents FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION novel.disable_dynamic_model(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, authenticated, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON novel.model_runtime_catalog TO project_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.model_runtime_incidents TO project_admin;
GRANT EXECUTE ON FUNCTION novel.disable_dynamic_model(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO project_admin;

COMMIT;
