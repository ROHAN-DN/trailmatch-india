-- TrialMatch India — Migration 021
-- Run AFTER 020_match_job_limits.sql
--
-- org_audit_summary was defined in migration 011_audit_log.sql, but its
-- creation failed silently at that point in the migration chain — it
-- selects `outcome`, a column that migration 011's own CREATE TABLE IF
-- NOT EXISTS never actually added (audit_log already existed from
-- schema.sql with a different, minimal set of columns — see
-- FIXES_2026-07-27.md for the full story). Migration 016 fixed the
-- underlying columns; nothing since then re-attempted this view.
-- CREATE OR REPLACE VIEW is naturally idempotent, so this is safe to run
-- regardless of whether an earlier, partial attempt exists.

CREATE OR REPLACE VIEW org_audit_summary AS
SELECT
  org_id,
  DATE(created_at AT TIME ZONE 'Asia/Kolkata') AS day_ist,
  action,
  outcome,
  COUNT(*) AS event_count
FROM audit_log
WHERE created_at > now() - INTERVAL '90 days'
GROUP BY org_id, day_ist, action, outcome;

-- Verify
SELECT table_name FROM information_schema.views
WHERE table_schema = 'public' AND table_name = 'org_audit_summary';
-- Expected: 1 row

SELECT 'Migration 021 complete' AS status;
