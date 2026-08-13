-- TrialMatch India — Migration 016
-- Run AFTER 015_fidelius_keys.sql
--
-- Fixes a severe, deterministic bug in 011_audit_log.sql: it declares
-- `CREATE TABLE IF NOT EXISTS audit_log (...)` with a rich forensic schema
-- (session_id, entity_type, before_state, after_state, ip_address, outcome,
-- etc.) — but schema.sql ALWAYS creates a minimal 8-column audit_log first
-- (id, org_id, user_id, action, entity, entity_id, metadata, created_at),
-- and schema.sql always runs before 011 in the documented deploy order.
-- `IF NOT EXISTS` means 011's richer CREATE TABLE silently does nothing —
-- on every deployment, not just existing ones.
--
-- lib/audit.ts — the real, currently-running application code that logs
-- every meaningful action platform-wide (patient creation, matches, PDF
-- generation, consent, billing, everything) — inserts into session_id,
-- entity_type, before_state, after_state, ip_address, and outcome on every
-- single call. None of those columns exist on the real table. Since
-- lib/audit.ts writes are fire-and-forget (by design — audit failures
-- shouldn't block real actions), this fails completely silently: every
-- audit_log insert has been erroring, console.error'd, and discarded. The
-- audit trail this project's own migration comments describe as required
-- for DPDP Act 2023 / ICH GCP E6(R2) / ISO 27001 has effectively been
-- empty since 011 was written.
--
-- Fix: ALTER TABLE ADD COLUMN IF NOT EXISTS for every column lib/audit.ts
-- actually writes to, rather than a CREATE TABLE that can silently no-op.
-- Non-destructive — the existing `entity` column (schema.sql's original,
-- narrower field) is left in place rather than dropped; entity_type is
-- added as the new column the application actually uses.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS session_id    text,
  ADD COLUMN IF NOT EXISTS entity_type   text,
  ADD COLUMN IF NOT EXISTS before_state  jsonb,
  ADD COLUMN IF NOT EXISTS after_state   jsonb,
  ADD COLUMN IF NOT EXISTS ip_address    inet,
  ADD COLUMN IF NOT EXISTS user_agent    text,
  ADD COLUMN IF NOT EXISTS request_id    text,
  ADD COLUMN IF NOT EXISTS outcome       text DEFAULT 'success',
  ADD COLUMN IF NOT EXISTS error_code    text,
  ADD COLUMN IF NOT EXISTS error_message text;

-- Re-add the CHECK constraint on outcome (can't be part of ADD COLUMN
-- when the column already has rows, but audit_log is either empty or was
-- only ever populated by schema.sql's pre-011 code path, which never set
-- outcome — so backfill existing rows to the default before constraining).
UPDATE audit_log SET outcome = 'success' WHERE outcome IS NULL;

ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_outcome_check;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_outcome_check CHECK (outcome IN ('success', 'failure', 'partial'));

-- The index 011 intended on entity_type/entity_id — also silently never
-- created for the same reason (CREATE INDEX IF NOT EXISTS referencing a
-- column that, until the ALTER above, didn't exist would itself have
-- errored and been skipped by the same deploy run).
CREATE INDEX IF NOT EXISTS idx_audit_entity_type ON audit_log (entity_type, entity_id);

-- Sanity check — confirms every column lib/audit.ts writes to now exists.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'audit_log'
  AND column_name IN (
    'session_id','entity_type','entity_id','before_state','after_state',
    'ip_address','user_agent','request_id','outcome','error_code','error_message'
  )
ORDER BY column_name;
-- Expected: 11 rows. If fewer, something above did not apply.
