-- TrialMatch India — Migration 023
-- Run AFTER 022_fix_match_accuracy_criteria.sql
--
-- TOTP-based MFA for privileged roles (owner, admin) — see lib/mfa.ts for
-- the full design rationale. This project's own Tier 4 disclosure named
-- "MFA for privileged roles" as a real, open gap.
--
-- mfa_secret_encrypted stores the TOTP secret encrypted at rest
-- (AES-256-GCM, application-layer — see lib/mfa.ts's encryptSecret/
-- decryptSecret) — never plaintext. mfa_last_time_step is what makes
-- replay protection actually work across requests: otplib's
-- afterTimeStep needs somewhere durable to read the previously-consumed
-- time step from, and a single login session can span many separate API
-- calls. mfa_backup_codes stores SHA-256 hashes only (see lib/mfa.ts's
-- hashBackupCode) — the plaintext codes are shown to the user exactly
-- once, at enrollment, and never stored.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_enabled            boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS mfa_secret_encrypted    text,
  ADD COLUMN IF NOT EXISTS mfa_backup_codes        text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS mfa_last_time_step      bigint,
  ADD COLUMN IF NOT EXISTS mfa_enrolled_at         timestamptz;

-- Pending-enrollment secrets (generated but not yet confirmed with a
-- valid code — see pages/api/mfa/setup.ts) are stored in this same
-- mfa_secret_encrypted column before mfa_enabled flips to true; there is
-- deliberately no separate "pending secret" column. A half-finished
-- enrollment simply overwrites itself if the user starts over, and
-- mfa_enabled staying false is what determines whether a stored secret
-- is "confirmed" or "someone started enrolling and never finished" —
-- both cases behave identically (no MFA is actually enforced) until
-- mfa_enabled is explicitly set true by successful confirmation.

-- Verify
SELECT column_name FROM information_schema.columns
WHERE table_name = 'users' AND column_name LIKE 'mfa_%'
ORDER BY column_name;
-- Expected: 5 rows

SELECT 'Migration 023 complete' AS status;
