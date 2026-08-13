-- TrialMatch India — Pre-screening Checklists Migration 008
-- Run AFTER 007_site_twin_performance.sql

CREATE TABLE IF NOT EXISTS prescreening_checklists (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id           uuid REFERENCES organizations(id) ON DELETE CASCADE,
  match_result_id  uuid REFERENCES match_results(id) ON DELETE CASCADE,
  patient_id       uuid REFERENCES patients(id) ON DELETE CASCADE,

  -- Trial reference
  nct_id           text NOT NULL,
  trial_title      text,

  -- The AI-generated checklist: array of checklist items
  -- Each item: { category, item, required, notes }
  -- category: 'labs' | 'documents' | 'medications' | 'preparation' | 'questions'
  checklist        jsonb NOT NULL DEFAULT '[]',

  -- Workflow status
  status           text DEFAULT 'generated'
    CHECK (status IN ('generated', 'reviewed', 'completed')),

  -- Timestamps
  generated_at     timestamptz DEFAULT now(),
  reviewed_at      timestamptz,
  reviewed_by      uuid REFERENCES users(id),

  -- One checklist per match result + trial combination
  CONSTRAINT prescreening_unique_match_trial UNIQUE (match_result_id, nct_id)
);

CREATE INDEX IF NOT EXISTS idx_prescreening_org        ON prescreening_checklists (org_id);
CREATE INDEX IF NOT EXISTS idx_prescreening_patient    ON prescreening_checklists (patient_id);
CREATE INDEX IF NOT EXISTS idx_prescreening_match      ON prescreening_checklists (match_result_id);

ALTER TABLE prescreening_checklists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_isolation_prescreening"
  ON prescreening_checklists
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- Verify
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'prescreening_checklists';
-- Expected: 1 row
