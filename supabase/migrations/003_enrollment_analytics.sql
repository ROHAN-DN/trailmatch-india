-- TrialMatch India — Enrollment Conversion Analytics Migration 003
-- Run AFTER 002_pi_directory.sql
-- Powers the conversion-rate cards on the Analytics tab

CREATE OR REPLACE VIEW v_enrollment_funnel AS
SELECT
  org_id,
  COUNT(*) FILTER (WHERE status = 'done')                                  AS total_matched,
  COUNT(*) FILTER (WHERE enrollment_status NOT IN ('pending'))             AS reviewed,
  COUNT(*) FILTER (WHERE enrollment_status IN (
    'pi_contacted','pre_screening_booked','pre_screening_done',
    'enrolled','screen_failed'
  ))                                                                       AS pi_contacted,
  COUNT(*) FILTER (WHERE enrollment_status IN (
    'pre_screening_booked','pre_screening_done','enrolled','screen_failed'
  ))                                                                       AS pre_screening_booked,
  COUNT(*) FILTER (WHERE enrollment_status = 'enrolled')                   AS enrolled,
  COUNT(*) FILTER (WHERE enrollment_status = 'screen_failed')              AS screen_failed,
  COUNT(*) FILTER (WHERE enrollment_status = 'patient_declined')           AS patient_declined,
  -- Conversion rates (as percentages, null-safe)
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE enrollment_status IN (
      'pi_contacted','pre_screening_booked','pre_screening_done','enrolled','screen_failed'
    )) / NULLIF(COUNT(*) FILTER (WHERE status = 'done'), 0), 1
  ) AS match_to_contacted_pct,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE enrollment_status = 'enrolled')
    / NULLIF(COUNT(*) FILTER (WHERE enrollment_status IN (
        'pi_contacted','pre_screening_booked','pre_screening_done','enrolled','screen_failed'
      )), 0), 1
  ) AS contacted_to_enrolled_pct,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE enrollment_status = 'enrolled')
    / NULLIF(COUNT(*) FILTER (WHERE status = 'done'), 0), 1
  ) AS overall_match_to_enrolled_pct
FROM match_results
GROUP BY org_id;

-- Verify
SELECT * FROM v_enrollment_funnel LIMIT 5;
