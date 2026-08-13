-- TrialMatch India — Site Twin Performance Refresh Migration 007
-- Run AFTER 006_site_twin.sql
-- Adds refresh_site_twin_performance() — called by weekly cron

-- ── refresh_site_twin_performance() ───────────────────────────────────────
-- Updates aggregate metrics for every partner site (org_id IS NOT NULL).
-- Reads only de-identified counts — never exposes patient-level data.
CREATE OR REPLACE FUNCTION refresh_site_twin_performance()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT isp.id, isp.org_id
    FROM india_site_profiles isp
    WHERE isp.org_id IS NOT NULL
  LOOP
    UPDATE india_site_profiles
    SET
      -- Active (non-archived) patient count from TrialMatch
      total_patients = (
        SELECT COUNT(*)::int
        FROM patients
        WHERE org_id = rec.org_id AND is_archived = false
      ),
      -- PI count at this org (from pi_contacts linked to their NCT IDs)
      pi_count = (
        SELECT COUNT(DISTINCT pi_name)::int
        FROM pi_contacts pc
        WHERE pc.pi_institution ILIKE
          (SELECT '%' || name || '%' FROM organizations WHERE id = rec.org_id)
      ),
      updated_at = now()
    WHERE id = rec.id;
  END LOOP;

  -- For all sites (partner + non-partner): update active_trials from
  -- the pi_contacts table which is sourced from CT.gov
  UPDATE india_site_profiles isp
  SET active_trials = sub.cnt
  FROM (
    SELECT
      lower(pi_institution) AS inst_key,
      COUNT(DISTINCT nct_id)::int AS cnt
    FROM pi_contacts
    GROUP BY lower(pi_institution)
  ) sub
  WHERE lower(isp.institution_name) = sub.inst_key;

END;
$$;

-- ── Scheduled refresh: runs every Sunday at 2 AM IST (20:30 UTC Saturday)
-- Requires pg_cron extension (already enabled in Supabase)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'site-twin-weekly-refresh',
      '30 20 * * 0',   -- Sunday 02:00 IST
      $cron$SELECT refresh_site_twin_performance();$cron$
    );
  END IF;
END $$;

-- Verify function exists
SELECT proname FROM pg_proc WHERE proname = 'refresh_site_twin_performance';
-- Expected: 1 row
