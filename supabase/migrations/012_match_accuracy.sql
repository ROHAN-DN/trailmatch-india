-- TrialMatch India — Match Accuracy Tracking Migration 012
-- Closes Phase 1 gap: "match accuracy stats start accumulating"
-- Links screen_fail_reason to specific trial criteria for continuous improvement

CREATE TABLE IF NOT EXISTS match_accuracy_events (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id           uuid REFERENCES organizations(id) ON DELETE CASCADE,
  match_result_id  uuid REFERENCES match_results(id) ON DELETE CASCADE,
  patient_id       uuid REFERENCES patients(id) ON DELETE CASCADE,
  nct_id           text NOT NULL,

  -- What happened
  outcome          text NOT NULL
    CHECK (outcome IN ('enrolled','screen_failed','patient_declined','trial_closed')),
  screen_fail_reason text,

  -- Which criteria were marked as 'partial' or 'unmet' in the original match
  -- Array of { criterion, match_status: 'met'|'partial'|'unmet', field }
  criteria_at_match jsonb DEFAULT '[]',

  -- Did the screen failure align with a partial/unmet criterion? (set by nightly job)
  failure_predicted boolean,
  failure_criterion text,     -- the criterion that predicted failure (if any)

  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accuracy_org     ON match_accuracy_events (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_accuracy_nct     ON match_accuracy_events (nct_id);
CREATE INDEX IF NOT EXISTS idx_accuracy_outcome ON match_accuracy_events (outcome);

ALTER TABLE match_accuracy_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation_accuracy" ON match_accuracy_events
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- View: criterion-level screen failure rates (powers match accuracy improvement)
CREATE OR REPLACE VIEW v_criterion_failure_rates AS
SELECT
  nct_id,
  failure_criterion,
  COUNT(*) FILTER (WHERE outcome = 'screen_failed')  AS screen_fail_count,
  COUNT(*) FILTER (WHERE outcome = 'enrolled')        AS enrolled_count,
  COUNT(*)                                            AS total_outcomes,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE outcome = 'screen_failed')
    / NULLIF(COUNT(*), 0), 1
  ) AS screen_fail_rate_pct
FROM match_accuracy_events
WHERE failure_criterion IS NOT NULL
GROUP BY nct_id, failure_criterion
ORDER BY screen_fail_rate_pct DESC;

-- Trigger: auto-create accuracy event when enrollment_status changes to a terminal state
CREATE OR REPLACE FUNCTION record_match_accuracy_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enrollment_status IN ('enrolled','screen_failed','patient_declined','trial_closed')
     AND (OLD.enrollment_status IS DISTINCT FROM NEW.enrollment_status) THEN
    INSERT INTO match_accuracy_events (
      org_id, match_result_id, patient_id, nct_id, outcome,
      screen_fail_reason, criteria_at_match
    )
    SELECT
      NEW.org_id,
      NEW.id,
      NEW.patient_id,
      COALESCE(NEW.matches->0->>'nctId', ''),
      NEW.enrollment_status,
      NEW.screen_fail_reason,
      COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(
          'criterion', elem->>'criterion',
          'status',    elem->>'status',
          'detail',    elem->>'detail'
        ))
        FROM jsonb_array_elements(NEW.matches->0->'eligibilityDetails') AS elem),
        '[]'::jsonb
      )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_match_accuracy ON match_results;
CREATE TRIGGER trg_match_accuracy
  AFTER UPDATE OF enrollment_status ON match_results
  FOR EACH ROW EXECUTE FUNCTION record_match_accuracy_event();

SELECT 'Migration 012 complete' AS status;
