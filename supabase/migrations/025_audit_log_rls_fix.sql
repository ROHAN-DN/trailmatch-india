-- TrialMatch India — Migration 025
-- Run AFTER 024_failure_prediction.sql
--
-- Two real, independently-confirmed things, found by actually running
-- the full 001→024 migration chain against a fresh Postgres database
-- rather than assuming it worked — not carried over from any prior
-- session's notes:
--
-- 1) RLS CONFLICT ON audit_log (the one that matters everywhere,
--    fresh deploy or existing one). schema.sql creates a broad
--    `org_isolation_audit` policy (FOR ALL — SELECT/INSERT/UPDATE/DELETE)
--    granting access to any member of a matching org. Migration 011
--    later defines a much narrower, intentional design for this specific
--    table — admins/owners only for SELECT, service_role only for
--    INSERT, nobody for UPDATE/DELETE — because audit_log is meant to
--    be a tamper-proof, immutable trail (its own header comment cites
--    DPDP Act 2023, ICH GCP E6(R2), and ISO 27001 for exactly this
--    property). Postgres RLS policies are permissive by default — they
--    OR together — so the old broad policy was never actually
--    superseded by the new narrow ones; it just sat alongside them,
--    silently granting every org member SELECT on the full audit log
--    (not just admins/owners), and — since no DB rule blocks INSERT the
--    way the rules below block UPDATE/DELETE — the ability to insert
--    fabricated audit rows directly, which is precisely what this
--    table's own design intends to prevent. This migration removes
--    that one policy from audit_log specifically. It is NOT touched on
--    any other table — org_isolation_* on patients, organizations, etc.
--    is the correct, intended access model there; audit_log is the one
--    table whose own design doc promises something stricter.
--
-- 2) SAFETY NET for anyone who ran the pre-fix version of 011_audit_log.sql
--    against a real project before this build. That version hard-errored
--    partway through (on a column that didn't exist yet), which aborted
--    the rest of the script in the same run — meaning RLS was never
--    enabled on audit_log, its two intended policies and two
--    tamper-prevention rules were never created, and consent_records
--    (the DPDP Act §6 consent-tracking table) never existed at all.
--    Migration 016 patched the missing columns; migration 021 patched
--    the missing view; nothing until now patched the rest. Everything
--    below is written idempotently (DROP...IF EXISTS + CREATE, IF NOT
--    EXISTS) so it's a safe no-op on a database where 011 already ran
--    cleanly (i.e. anyone deploying fresh with this build), and a real
--    fix for anyone who deployed before it.

-- ── Fix 1: remove the overly-broad policy from audit_log specifically ──
DROP POLICY IF EXISTS "org_isolation_audit" ON audit_log;

-- ── Fix 2: idempotent safety net — audit_log RLS + policies + rules ────
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_admins_read_audit" ON audit_log;
CREATE POLICY "org_admins_read_audit"
  ON audit_log FOR SELECT
  USING (
    org_id = (
      SELECT org_id FROM users
      WHERE id = auth.uid() AND role IN ('admin', 'owner')
    )
    OR auth.role() = 'service_role'
  );

DROP POLICY IF EXISTS "service_role_insert_audit" ON audit_log;
CREATE POLICY "service_role_insert_audit"
  ON audit_log FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

-- No UPDATE or DELETE policies — intentionally absent, same as 011.

CREATE OR REPLACE RULE no_delete_audit AS ON DELETE TO audit_log
  DO INSTEAD NOTHING;

CREATE OR REPLACE RULE no_update_audit AS ON UPDATE TO audit_log
  DO INSTEAD NOTHING;

-- ── Fix 2 continued: idempotent safety net — consent_records ───────────
CREATE TABLE IF NOT EXISTS consent_records (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          uuid        REFERENCES organizations(id) NOT NULL,
  patient_id      uuid        REFERENCES patients(id),
  consent_type    text        NOT NULL
    CHECK (consent_type IN (
      'data_processing', 'trial_matching', 'sponsor_aggregate',
      'pdf_report', 'whatsapp_notification', 'third_party_sharing',
      'data_retention'
    )),
  version         text        NOT NULL,
  given           boolean     NOT NULL,
  given_at        timestamptz,
  withdrawn_at    timestamptz,
  collection_method text      NOT NULL
    CHECK (collection_method IN ('verbal_logged', 'written_form', 'digital_form', 'abdm_derived')),
  collected_by    uuid        REFERENCES users(id),
  notes           text,
  evidence_ref    text,
  created_at      timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consent_patient  ON consent_records (patient_id, consent_type);
CREATE INDEX IF NOT EXISTS idx_consent_org      ON consent_records (org_id, given);

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_isolation_consent" ON consent_records;
CREATE POLICY "org_isolation_consent"
  ON consent_records
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- ── Sanity check ─────────────────────────────────────────────────────
SELECT policyname, cmd FROM pg_policies WHERE tablename = 'audit_log' ORDER BY policyname;
-- Expected: exactly 2 rows — org_admins_read_audit (SELECT), service_role_insert_audit (INSERT).
-- If org_isolation_audit still appears, something above did not apply.

SELECT 'Migration 025 complete' AS status;
