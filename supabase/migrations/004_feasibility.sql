-- TrialMatch India — Site Feasibility Migration 004
-- Run AFTER 003_enrollment_analytics.sql

CREATE TABLE IF NOT EXISTS feasibility_queries (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          uuid REFERENCES organizations(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES users(id),

  name            text,
  diagnosis_keyword text,
  age_min         int,
  age_max         int,
  criteria        jsonb,   -- array of {field, operator, value, label}

  status          text DEFAULT 'complete' CHECK (status IN ('running','complete','failed')),
  results         jsonb,   -- array of {org_id, org_name, city, total_count, confidence, breakdown}
  total_sites     int,

  -- For protocol optimisation: links a modified scenario back to its original
  parent_query_id uuid REFERENCES feasibility_queries(id),

  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feasibility_org ON feasibility_queries(org_id);

ALTER TABLE feasibility_queries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_isolation_feasibility" ON feasibility_queries
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- Verify
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'feasibility_queries';
-- Expected: 1 row
