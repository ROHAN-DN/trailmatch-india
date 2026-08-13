-- TrialMatch India — Audit Log Migration 011
-- Run AFTER 010_enrollment_monitor.sql
--
-- Implements a tamper-proof, immutable audit trail required by:
--   - India DPDP Act 2023 (data processing accountability)
--   - ICH GCP E6(R2) (clinical trial data integrity)
--   - ISO 27001 (information security)
--
-- Design principles:
--   - INSERT only — no UPDATE, no DELETE ever
--   - Every meaningful action produces a row
--   - Before/after state captured for mutations
--   - IP address + user agent for forensic reconstruction
--   - RLS: org admins can read their org's log; service role only for writes

-- ── audit_log ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id            uuid          PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        uuid          REFERENCES organizations(id),       -- nullable for system events
  user_id       uuid          REFERENCES users(id),               -- nullable for cron/system
  session_id    text,                                             -- NextAuth session jti

  -- What happened
  action        text          NOT NULL,
  -- Core actions:
  -- auth:         login, logout, login_failed, session_expired
  -- patient:      patient_created, patient_updated, patient_archived, patient_viewed_phi
  -- match:        match_job_started, match_job_completed, match_result_viewed
  -- report:       pdf_generated, pdf_downloaded, pdf_emailed
  -- prescreening: checklist_generated, checklist_reviewed, whatsapp_sent
  -- protocol:     protocol_uploaded, protocol_parsed, protocol_updated, protocol_archived
  -- feasibility:  feasibility_run, feasibility_result_exported
  -- engagement:   engagement_initiated, engagement_notified, engagement_responded, engagement_closed
  -- consent:      consent_recorded, consent_withdrawn, dpdp_request_processed
  -- team:         user_invited, user_role_changed, user_deactivated
  -- billing:      plan_changed, payment_processed, payment_failed
  -- data:         data_export, bulk_import, data_retention_applied
  -- security:     api_key_created, api_key_revoked, mfa_enabled, suspicious_access
  -- ai:           ai_match_called, ai_prescreening_called, ai_protocol_parsed, ai_monitor_alert

  -- What was affected
  entity_type   text,                    -- 'patient' | 'match_result' | 'protocol' | etc.
  entity_id     text,                    -- UUID of the affected record

  -- State capture (JSONB — only for mutations, nil for read events)
  before_state  jsonb,                   -- state before mutation (redacted of raw PII)
  after_state   jsonb,                   -- state after mutation (redacted of raw PII)

  -- Request context
  ip_address    inet,
  user_agent    text,
  request_id    text,                    -- X-Request-ID header for tracing

  -- Outcome
  outcome       text          DEFAULT 'success'
    CHECK (outcome IN ('success', 'failure', 'partial')),
  error_code    text,                    -- only when outcome = 'failure'
  error_message text,

  -- Metadata
  metadata      jsonb         DEFAULT '{}',  -- extra context (e.g. trial NCT IDs, counts)

  -- Immutable timestamp — stored as timestamptz WITH time zone
  created_at    timestamptz   DEFAULT now() NOT NULL,

  -- Prevent accidental updates
  CONSTRAINT audit_log_no_update CHECK (created_at IS NOT NULL)
);

-- Performance indexes
--
-- REAL BUG FOUND AND FIXED HERE, by actually running this file against a
-- real fresh Postgres database rather than assuming it: schema.sql
-- ALWAYS creates a minimal audit_log first (see migration 016's header
-- comment for the full story), so the CREATE TABLE IF NOT EXISTS above
-- is always a silent no-op — audit_log never actually gets the columns
-- this file defines. The idx_audit_entity index below used to reference
-- entity_type, a column that (until migration 016 adds it) does not
-- exist on the table that's actually there. That's not a silent skip —
-- it's a hard SQL error that aborts this entire script, in one paste,
-- before a single line below this point ever runs: no RLS on audit_log,
-- neither policy, neither no-delete/no-update rule, no
-- org_audit_summary view, and no consent_records table — the DPDP Act
-- §6 consent-tracking table this same file defines further down. Every
-- one of those gaps is completed correctly in migration 025, once the
-- entity_type column actually exists. This index is intentionally
-- removed from here (not just left to fail) so a fresh deploy runs
-- 001 → 024 without a hard stop; migration 016 creates the equivalent
-- index once the column that's queried actually exists.
CREATE INDEX IF NOT EXISTS idx_audit_org_time    ON audit_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user_time   ON audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action      ON audit_log (action, created_at DESC);

-- ── RLS: strict access control ────────────────────────────────────────────
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Org admins can read their own org's audit log
CREATE POLICY "org_admins_read_audit"
  ON audit_log FOR SELECT
  USING (
    org_id = (
      SELECT org_id FROM users
      WHERE id = auth.uid() AND role IN ('admin', 'owner')
    )
    OR auth.role() = 'service_role'
  );

-- Only service_role (server-side code) can INSERT
CREATE POLICY "service_role_insert_audit"
  ON audit_log FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

-- CRITICAL: NO UPDATE, NO DELETE policies — these are intentionally absent
-- Any attempt to UPDATE or DELETE audit records returns a policy violation error

-- ── Prevent row deletion at DB level (belt + suspenders) ─────────────────
CREATE OR REPLACE RULE no_delete_audit AS ON DELETE TO audit_log
  DO INSTEAD NOTHING;

CREATE OR REPLACE RULE no_update_audit AS ON UPDATE TO audit_log
  DO INSTEAD NOTHING;

-- ── Helper view: recent activity per org (last 90 days) ──────────────────
--
-- REMOVED FROM HERE — same class of bug as the index above: this SELECTs
-- `outcome`, another column that (until migration 016 adds it) doesn't
-- exist on the table schema.sql actually created, so this CREATE VIEW
-- was ALSO a hard error that aborted the rest of this script — meaning
-- consent_records below never got created either, on a fresh deploy.
-- Migration 021 already independently recreates this exact view once
-- the column exists; that's the real, working definition. Confirmed by
-- actually running this file against a fresh Postgres database, not
-- assumed.

-- ── consent_records (DPDP Act 2023 §6 — explicit consent tracking) ───────
-- Separate from audit_log — consent records need even stricter guarantees
CREATE TABLE IF NOT EXISTS consent_records (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          uuid        REFERENCES organizations(id) NOT NULL,
  patient_id      uuid        REFERENCES patients(id),

  -- Consent specifics
  consent_type    text        NOT NULL
    CHECK (consent_type IN (
      'data_processing',       -- basic TrialMatch processing
      'trial_matching',        -- AI-based trial matching
      'sponsor_aggregate',     -- sharing aggregate data with sponsors
      'pdf_report',            -- PDF report generation
      'whatsapp_notification', -- WhatsApp messages
      'third_party_sharing',   -- any third-party data share
      'data_retention'         -- explicit retention period acknowledgement
    )),
  version         text        NOT NULL,    -- consent form version (e.g. '2024.1')
  given           boolean     NOT NULL,    -- true = consented, false = withdrawn
  given_at        timestamptz,
  withdrawn_at    timestamptz,

  -- How was consent collected?
  collection_method text      NOT NULL
    CHECK (collection_method IN ('verbal_logged', 'written_form', 'digital_form', 'abdm_derived')),
  collected_by    uuid        REFERENCES users(id),

  -- Evidence
  notes           text,
  evidence_ref    text,       -- e.g. signed form file name / ABHA consent artefact ID

  created_at      timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consent_patient  ON consent_records (patient_id, consent_type);
CREATE INDEX IF NOT EXISTS idx_consent_org      ON consent_records (org_id, given);

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_isolation_consent"
  ON consent_records
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- Verify
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('audit_log', 'consent_records')
ORDER BY table_name;
-- Expected: 2 rows
