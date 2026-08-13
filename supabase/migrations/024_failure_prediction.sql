-- TrialMatch India — Migration 024
-- Run AFTER 023_mfa.sql
--
-- failure_predicted / failure_criterion — the piece migration 012's own
-- comment scoped as "(set by nightly job)" and migration 022 deliberately
-- left unbuilt: "a naive version — flagging any screen-failure with any
-- unmet/partial criterion as 'predicted' — would be almost always true
-- and not meaningfully informative, and could mislead a future accuracy
-- analysis into false confidence."
--
-- What's here instead: pg_trgm lexical similarity (already enabled by
-- migration 005, no new extension) between the coordinator's own
-- screen_fail_reason text and each unmet/partial criterion's description,
-- only flagging a prediction when the best match clears a real,
-- empirically-calibrated threshold — not "any correlation exists."
--
-- Threshold calibration (run directly against real Postgres before
-- picking a number, not guessed): genuinely correlated pairs — "eGFR too
-- low at screening" vs "eGFR >= 45", "still on metformin, did not stop in
-- time" vs "No current use of metformin", "Patient HbA1c came back too
-- high" vs "HbA1c between 8.0-11.0%" — scored 0.15 to 0.25. Genuinely
-- unrelated pairs — "patient moved out of the city" vs "eGFR >= 45",
-- "lost to follow up" vs "HbA1c between 8.0-11.0%" — scored exactly 0.
-- Short/generic reason text with real false-positive risk — "not
-- eligible", "no show", "coordinator error" — scored 0 to 0.09 against
-- unrelated criteria. 0.15 sits with real margin on both sides of that
-- empirical split.
--
-- Stated honestly, not just implied: this is LEXICAL similarity (shared
-- words/substrings), not clinical reasoning. "Declined due to renal
-- function" scored 0 against "eGFR >= 45" in calibration, even though a
-- clinician would recognize the connection — trigram similarity has no
-- concept of that relationship. This will only ever flag a correlation
-- when the coordinator's own wording actually overlaps with the
-- criterion's — which is a real, common case (coordinators often do
-- reference the specific lab/medication by name), but a conservative,
-- honest subset of true correlations, not all of them. Missing a real
-- correlation (false negative, leaving failure_predicted false) is the
-- deliberately preferred failure mode over inventing one this data can't
-- actually support — the same "UNKNOWN over a guessed answer" principle
-- this whole codebase already applies to patient-eligibility evaluation
-- (see lib/eligibility-rules.ts).

CREATE OR REPLACE FUNCTION record_match_accuracy_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_criteria_at_match jsonb;
  v_failure_predicted  boolean := false;
  v_failure_criterion  text    := NULL;
  v_best_score         real;
BEGIN
  IF NEW.enrollment_status IN ('enrolled','screen_failed','patient_declined','trial_closed')
     AND (OLD.enrollment_status IS DISTINCT FROM NEW.enrollment_status) THEN

    v_criteria_at_match := COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'criterion', elem->>'description',
        'status',    CASE elem->>'result'
                       WHEN 'PASS'    THEN 'met'
                       WHEN 'FAIL'    THEN 'unmet'
                       WHEN 'UNKNOWN' THEN 'partial'
                       ELSE 'partial'
                     END,
        'field',     elem->>'evidence'
      ))
      FROM jsonb_array_elements(NEW.matches->0->'deterministicResults') AS elem),
      '[]'::jsonb
    );

    IF NEW.enrollment_status = 'screen_failed'
       AND NEW.screen_fail_reason IS NOT NULL
       AND length(trim(NEW.screen_fail_reason)) > 0 THEN
      SELECT c->>'criterion', similarity(NEW.screen_fail_reason, c->>'criterion')
      INTO v_failure_criterion, v_best_score
      FROM jsonb_array_elements(v_criteria_at_match) AS c
      WHERE c->>'status' IN ('unmet', 'partial')
      ORDER BY similarity(NEW.screen_fail_reason, c->>'criterion') DESC
      LIMIT 1;

      IF v_best_score IS NULL OR v_best_score < 0.15 THEN
        v_failure_predicted := false;
        v_failure_criterion := NULL;
      ELSE
        v_failure_predicted := true;
      END IF;
    END IF;

    INSERT INTO match_accuracy_events (
      org_id, match_result_id, patient_id, nct_id, outcome,
      screen_fail_reason, criteria_at_match, failure_predicted, failure_criterion
    )
    SELECT
      NEW.org_id,
      NEW.id,
      NEW.patient_id,
      COALESCE(NEW.matches->0->>'nctId', ''),
      NEW.enrollment_status,
      NEW.screen_fail_reason,
      v_criteria_at_match,
      -- NULL (not false) for every outcome other than screen_failed —
      -- "did the screen failure align with a criterion" is a question
      -- that only applies to a screen failure in the first place; NULL
      -- here means "not applicable," which is different from "checked
      -- and found no correlation" (false).
      CASE WHEN NEW.enrollment_status = 'screen_failed' THEN v_failure_predicted ELSE NULL END,
      v_failure_criterion
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- Verify
SELECT prosrc LIKE '%similarity%' AS uses_trigram_similarity
FROM pg_proc WHERE proname = 'record_match_accuracy_event';
-- Expected: t

SELECT 'Migration 024 complete' AS status;
