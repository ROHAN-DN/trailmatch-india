-- TrialMatch India — Migration 022
-- Run AFTER 021_org_audit_summary_view.sql
--
-- match_accuracy_events was reported as a dormant table — "created in
-- migration 012, never written to by anything." That was half right.
-- Verified directly against a real Postgres database: the trigger
-- migration 012 already created (record_match_accuracy_event, AFTER
-- UPDATE OF enrollment_status ON match_results) genuinely fires and
-- genuinely inserts a row, correctly, every time a coordinator uses the
-- existing enrollment-status UI (components/EnrollmentStatusDropdown.tsx
-- + pages/api/match/[id].ts's PATCH handler — both already real, already
-- working, already in production code) to mark a match as enrolled,
-- screen_failed, patient_declined, or trial_closed. outcome,
-- screen_fail_reason, and nct_id all populate correctly.
--
-- What's actually broken: the trigger reads
-- `NEW.matches->0->'eligibilityDetails'` for criteria_at_match — and
-- eligibilityDetails is a field nothing in this codebase has ever
-- written (confirmed earlier this engagement: it's declared on the
-- TrialMatch type and read in two places, but no code path ever sets
-- it). So criteria_at_match has always ended up '[]', silently, on
-- every real accuracy event — confirmed directly: inserted a
-- realistic match_results row (matches JSONB shaped exactly like what
-- lib/matcher.ts actually produces, deterministicResults present,
-- eligibilityDetails absent because nothing sets it), ran the exact
-- UPDATE the coordinator PATCH handler runs, and got outcome/
-- screen_fail_reason/nct_id all correct with criteria_at_match = [].
--
-- The fix: read from `deterministicResults` instead — the field that is
-- actually populated on every real match, with a real
-- extractionSource-tagged PASS/FAIL/UNKNOWN per criterion (see
-- lib/matcher.ts). Mapped to the shape criteria_at_match's own
-- comment already documented as the intent (`match_status:
-- 'met'|'partial'|'unmet'`): PASS -> met, FAIL -> unmet,
-- UNKNOWN -> partial. `field` (loosely named in the original schema
-- comment) is populated from `evidence` — the specific data point the
-- deterministic evaluator actually examined for that criterion, the
-- closest real analogue to what that field was for.
--
-- Left unchanged, deliberately: this still only looks at matches->0 (the
-- patient's top-ranked match), matching migration 012's own original
-- design — enrollment_status is one field per match_results row (one row
-- per patient, not per trial-match), so tracking anything other than the
-- top match here would be a real, separate data-model change, not a bug
-- fix. Also unchanged: failure_predicted/failure_criterion, which
-- migration 012's own comment already scoped as "(set by nightly job)" —
-- no such job exists yet; wiring it up is real, separate future work
-- that needs criteria_at_match to actually contain data first, which is
-- exactly what this migration fixes.

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
      )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- Verify
SELECT prosrc LIKE '%deterministicResults%' AS reads_the_real_field
FROM pg_proc WHERE proname = 'record_match_accuracy_event';
-- Expected: t

SELECT 'Migration 022 complete' AS status;
