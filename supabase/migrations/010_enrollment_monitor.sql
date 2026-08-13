-- TrialMatch India — Enrollment Monitor Agent Migration 010
-- Run AFTER 009_sponsor_portal.sql
-- Supports the enrollment monitor agent (Week 14-16 of Phase 2)

-- ── Enrollment monitor tasks ───────────────────────────────────────────────
-- One row per active match-to-enrollment pipeline being monitored.
-- Created automatically when a match job completes.
CREATE TABLE IF NOT EXISTS enrollment_monitor_tasks (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id           uuid REFERENCES organizations(id) ON DELETE CASCADE,
  match_result_id  uuid REFERENCES match_results(id) ON DELETE CASCADE,
  patient_id       uuid REFERENCES patients(id) ON DELETE CASCADE,
  nct_id           text NOT NULL,

  -- Current pipeline state
  enrollment_status text,          -- mirrors match_results.enrollment_status
  last_status_change timestamptz,
  days_in_status   int,

  -- Alert thresholds
  alert_if_no_contact_hours int DEFAULT 48,   -- alert if not contacted in 48h
  alert_on_competing_trial  boolean DEFAULT true,

  -- Alert tracking
  last_alert_type  text,   -- 'no_contact' | 'competing_trial' | 'pace_warning'
  last_alerted_at  timestamptz,
  alert_count      int DEFAULT 0,

  -- Monitor status
  is_active        boolean DEFAULT true,
  completed_at     timestamptz,    -- set when enrollment_status = 'enrolled' or 'screen_failed'

  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_monitor_org     ON enrollment_monitor_tasks (org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_monitor_patient ON enrollment_monitor_tasks (patient_id);
CREATE INDEX IF NOT EXISTS idx_monitor_match   ON enrollment_monitor_tasks (match_result_id);

ALTER TABLE enrollment_monitor_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation_monitor"
  ON enrollment_monitor_tasks
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- ── Weekly enrollment pace reports ────────────────────────────────────────
-- Stores the weekly WhatsApp report payload for each org
CREATE TABLE IF NOT EXISTS enrollment_pace_reports (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       uuid REFERENCES organizations(id) ON DELETE CASCADE,
  week_ending  date NOT NULL,
  report_data  jsonb NOT NULL,
  -- { total_monitored, newly_enrolled, screen_failed, pending_contact,
  --   overdue_contact, conversion_rate_pct, top_trial }
  sent_via     text[] DEFAULT '{}',   -- ['whatsapp', 'email']
  created_at   timestamptz DEFAULT now(),
  UNIQUE (org_id, week_ending)
);

ALTER TABLE enrollment_pace_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation_pace_reports"
  ON enrollment_pace_reports
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- Verify
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('enrollment_monitor_tasks', 'enrollment_pace_reports')
ORDER BY table_name;
-- Expected: 2 rows
