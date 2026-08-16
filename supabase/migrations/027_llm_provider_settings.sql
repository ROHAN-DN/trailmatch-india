-- TrialMatch India — Migration 027
-- Run AFTER 026_rematch_runs_rls_fix.sql
--
-- Adds per-organization AI provider configuration. Previously the
-- matching engine was hardcoded to a single, platform-wide Anthropic
-- API key — meaning every org sharing this deployment was forced onto
-- the same vendor with no way to opt into a different one, which was
-- architecturally inconsistent with every other org-level setting this
-- schema already has (billing, branding, notification preferences).
--
-- llm_api_key_encrypted follows the exact same AES-256-GCM pattern as
-- users.mfa_secret_encrypted (see migration 023 and lib/mfa.ts), but
-- with its OWN separate encryption key (LLM_CREDENTIAL_ENCRYPTION_KEY,
-- not MFA_ENCRYPTION_KEY) — a compromised AI provider key and a
-- compromised MFA secret are different blast radii, and should never
-- share a key.
--
-- An org with llm_provider IS NULL (the default) simply uses the
-- platform-wide default provider (env vars) — nothing breaks for any
-- existing org that never configures this.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS llm_provider           text
    CHECK (llm_provider IS NULL OR llm_provider IN ('anthropic', 'openai', 'google', 'openai_compatible')),
  ADD COLUMN IF NOT EXISTS llm_api_key_encrypted   text,
  ADD COLUMN IF NOT EXISTS llm_model               text,
  ADD COLUMN IF NOT EXISTS llm_base_url            text,
  ADD COLUMN IF NOT EXISTS llm_configured_at       timestamptz,
  ADD COLUMN IF NOT EXISTS llm_configured_by       uuid REFERENCES users(id);

-- openai_compatible specifically requires a base URL (it's what makes
-- the endpoint identifiable at all) — every other provider has a known,
-- fixed endpoint and doesn't need one.
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_llm_openai_compatible_needs_base_url;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_llm_openai_compatible_needs_base_url
  CHECK (llm_provider IS DISTINCT FROM 'openai_compatible' OR llm_base_url IS NOT NULL);

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'organizations'
  AND column_name LIKE 'llm_%'
ORDER BY column_name;
-- Expected: 6 rows

SELECT 'Migration 027 complete' AS status;
