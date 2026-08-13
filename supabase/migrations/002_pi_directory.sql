-- TrialMatch India — PI Directory + Enrollment Tracking Migration 002
-- Run AFTER 001_compliance.sql

-- ── PI contacts ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pi_contacts (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nct_id              text,
  ctri_id             text,
  trial_title         text NOT NULL,
  pi_name             text,
  pi_email            text,
  pi_phone            text,
  pi_institution      text,
  pi_city             text,
  pi_state            text,
  department          text,
  specialty           text,
  verified            boolean DEFAULT false,
  verified_at         timestamptz,
  verified_by         uuid REFERENCES users(id),
  email_bounced       boolean DEFAULT false,
  phone_unreachable   boolean DEFAULT false,
  times_contacted     int DEFAULT 0,
  times_responded     int DEFAULT 0,
  response_rate       float,
  avg_response_hours  int,
  last_contacted_at   timestamptz,
  last_responded_at   timestamptz,
  source              text DEFAULT 'ctgov' CHECK (source IN ('ctgov','ctri','manual')),
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),
  UNIQUE (nct_id, pi_email)
);

CREATE INDEX IF NOT EXISTS idx_pi_nct_id      ON pi_contacts(nct_id);
CREATE INDEX IF NOT EXISTS idx_pi_city        ON pi_contacts(pi_city);
CREATE INDEX IF NOT EXISTS idx_pi_specialty   ON pi_contacts(specialty);
CREATE INDEX IF NOT EXISTS idx_pi_institution ON pi_contacts(pi_institution);
CREATE INDEX IF NOT EXISTS idx_pi_response    ON pi_contacts(response_rate DESC NULLS LAST);

ALTER TABLE pi_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pi_contacts_read_all" ON pi_contacts
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "pi_contacts_service_write" ON pi_contacts
  FOR ALL USING (auth.role() = 'service_role');

-- update_updated_at() is referenced by the trigger below (and, later, by
-- other tables' own updated_at triggers) but was never actually defined
-- anywhere in this migration set — confirmed by grep across every
-- migration file. Running this migration for real against a fresh
-- Postgres database would fail exactly here with "function
-- update_updated_at() does not exist", which would also block every
-- migration after this one from ever applying. Found while adding
-- migration 018, which needed to understand this project's own
-- updated_at-trigger convention — not something inspection alone would
-- have caught; this is the kind of gap that only surfaces by trying to
-- actually run the migration, exactly like this project's own Tier 2
-- disclosure (nothing has touched a real Supabase project yet) predicts.
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pi_contacts_updated
  BEFORE UPDATE ON pi_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ── PI outreach log ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pi_outreach_log (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id           uuid REFERENCES users(id),
  pi_contact_id     uuid REFERENCES pi_contacts(id),
  patient_id        uuid REFERENCES patients(id),
  match_result_id   uuid REFERENCES match_results(id),
  action            text NOT NULL CHECK (action IN (
    'email_sent','whatsapp_sent','phone_called','pi_responded',
    'meeting_booked','pre_screening_scheduled','no_response_followup'
  )),
  notes             text,
  created_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pi_log_org ON pi_outreach_log(org_id);
CREATE INDEX IF NOT EXISTS idx_pi_log_pi  ON pi_outreach_log(pi_contact_id);
CREATE INDEX IF NOT EXISTS idx_pi_log_pt  ON pi_outreach_log(patient_id);

ALTER TABLE pi_outreach_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation_pi_log" ON pi_outreach_log
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));


-- ── Response rate RPCs (atomic increments) ───────────────────
CREATE OR REPLACE FUNCTION increment_pi_contacted(pi_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE pi_contacts SET
    times_contacted   = times_contacted + 1,
    last_contacted_at = now(),
    response_rate     = CASE WHEN times_contacted + 1 > 0
                         THEN times_responded::float / (times_contacted + 1) ELSE 0 END
  WHERE id = pi_id;
END;
$$;

CREATE OR REPLACE FUNCTION increment_pi_responded(pi_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE pi_contacts SET
    times_responded    = times_responded + 1,
    last_responded_at  = now(),
    response_rate      = CASE WHEN times_contacted > 0
                          THEN (times_responded + 1)::float / times_contacted ELSE 1 END
  WHERE id = pi_id;
END;
$$;


-- ── Enrollment status tracking on match_results ───────────────
ALTER TABLE match_results
  ADD COLUMN IF NOT EXISTS enrollment_status text DEFAULT 'pending'
    CHECK (enrollment_status IN (
      'pending','coordinator_reviewing','pi_contacted',
      'pre_screening_booked','pre_screening_done','enrolled',
      'screen_failed','patient_declined','trial_closed','not_actioned'
    )),
  ADD COLUMN IF NOT EXISTS enrollment_status_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS enrollment_notes             text,
  ADD COLUMN IF NOT EXISTS enrolled_at                  timestamptz,
  ADD COLUMN IF NOT EXISTS screen_fail_reason           text;

CREATE INDEX IF NOT EXISTS idx_match_results_enrollment
  ON match_results(enrollment_status);

-- Verify
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('pi_contacts','pi_outreach_log')
ORDER BY table_name;
-- Expected: 2 rows
