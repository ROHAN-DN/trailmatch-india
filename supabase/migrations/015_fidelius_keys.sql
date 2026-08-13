-- TrialMatch India — Migration 015
-- Run AFTER 014_security_fixes.sql
--
-- Adds columns to store the ephemeral Fidelius (ABDM ECDH) key material
-- generated per session in lib/abdm-client.ts's requestHealthInfo(). This
-- is required for the real decryption implemented in lib/fidelius.ts —
-- decrypting the HIP's callback needs OUR private key and nonce again,
-- which must be persisted somewhere between the request and the callback.
--
-- Previously there was no such storage because the old ECDH implementation
-- was a placeholder that didn't do real key exchange at all.
--
-- These columns hold key material scoped to a single, short-lived
-- (10-minute expiry per abdm_sessions.expires_at) ABDM consent session —
-- not a long-term credential. Still sensitive: RLS on abdm_sessions
-- (already enabled in schema.sql) restricts read access to users in the
-- same org.

alter table abdm_sessions
  add column if not exists fidelius_private_key text,
  add column if not exists fidelius_public_key_x509 text,
  add column if not exists fidelius_nonce text;

comment on column abdm_sessions.fidelius_private_key is
  'Base64 ephemeral Curve25519 private key generated for this session (lib/fidelius.ts). '
  'Never reused across sessions. Needed to decrypt the HIP''s callback response.';
comment on column abdm_sessions.fidelius_public_key_x509 is
  'Base64 X.509-wrapped public key sent to ABDM in the health-information request. '
  'Stored for audit/debugging; not needed for decryption (only the private key + nonce are).';
comment on column abdm_sessions.fidelius_nonce is
  'Base64, 32 random bytes generated for this session. Combined with the HIP''s own '
  'nonce (from the callback payload) to derive the AES-GCM salt/IV — see lib/fidelius.ts.';

-- Sanity check
SELECT column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_name = 'abdm_sessions' AND column_name LIKE 'fidelius_%';
