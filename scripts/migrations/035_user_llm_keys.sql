-- Migration 035: BYOK (bring your own key) per-user LLM API keys.
-- Plaintext keys never leave the request lifecycle: rows store AES-256-GCM
-- ciphertext produced by lib/crypto.ts. Browser-authenticated callers may
-- read owner-safe metadata only; every mutation uses the trusted system
-- DbClient with explicit owner predicates.

BEGIN;

CREATE TABLE IF NOT EXISTS novel.user_llm_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  provider      TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  key_last4     TEXT NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_llm_keys_active_provider
  ON novel.user_llm_keys(user_id, provider)
  WHERE revoked_at IS NULL;

ALTER TABLE novel.user_llm_keys ENABLE ROW LEVEL SECURITY;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'user_llm_keys_owner_select'
      AND polrelid = 'novel.user_llm_keys'::regclass
  ) THEN
    CREATE POLICY user_llm_keys_owner_select ON novel.user_llm_keys
      FOR SELECT TO authenticated
      USING (user_id = NULLIF((SELECT auth.jwt() ->> 'sub'), '')::uuid);
  END IF;
END
$migration$;

-- RLS-readable columns exclude encrypted_key on purpose: the ciphertext is
-- only ever touched by the system client (writes via the key service,
-- decryption in the chat pre-flight).
REVOKE ALL ON novel.user_llm_keys FROM PUBLIC;
REVOKE ALL ON novel.user_llm_keys FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON novel.user_llm_keys FROM authenticated;
GRANT SELECT (id, user_id, provider, key_last4, revoked_at, created_at, updated_at)
  ON novel.user_llm_keys TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON novel.user_llm_keys TO postgres;

COMMIT;
