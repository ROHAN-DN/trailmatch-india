-- TrialMatch India — Critical Bug Fixes Migration 013
-- Run AFTER 012_match_accuracy.sql
--
-- Fix 1: Site twin upsert was broken because the unique INDEX used lower()
--         expressions but Supabase upsert onConflict needs a named CONSTRAINT.
--         Add the named constraint and a helper RPC for the seed script.
--
-- Fix 2: Enrollment monitor tasks were never created automatically.
--         Add a DB-level trigger as a safety net (match/index.ts also inserts,
--         but this trigger ensures tasks are created even from future code paths).

-- ═══════════════════════════════════════════════════════════════════
-- FIX 1: Named unique constraint on india_site_profiles
-- ═══════════════════════════════════════════════════════════════════

-- Drop the existing expression index (can't convert to constraint directly)
DROP INDEX IF EXISTS idx_site_profiles_institution_city;

-- Add proper named UNIQUE CONSTRAINT that the seed upsert can reference
-- PostgreSQL doesn't support expression-based UNIQUE CONSTRAINTs directly,
-- so we use a generated column approach for clean upserts.

ALTER TABLE india_site_profiles
  ADD COLUMN IF NOT EXISTS institution_city_key text
  GENERATED ALWAYS AS (lower(institution_name) || '|' || lower(coalesce(city, ''))) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS idx_site_profiles_key
  ON india_site_profiles (institution_city_key);

-- Upsert RPC used by seed-site-twins.ts
-- Returns the upserted row ID.
CREATE OR REPLACE FUNCTION upsert_site_profile(
  p_institution_name  text,
  p_city              text,
  p_state             text,
  p_site_type         text,
  p_specialties       text[],
  p_ctgov_nct_ids     text[],
  p_ctri_ids          text[],
  p_active_trials     int
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id  uuid;
BEGIN
  -- institution_city_key is GENERATED ALWAYS AS (...) STORED (see the
  -- ALTER TABLE above) — Postgres computes it automatically from
  -- institution_name/city and never accepts an explicit value for it in
  -- an INSERT, on any deployment. An earlier version of this function
  -- tried to insert one anyway (a leftover from before the column became
  -- generated), which made this RPC fail on every call — confirmed by
  -- actually running it against a real Postgres instance, not just
  -- reading the SQL. It's omitted here entirely; ON CONFLICT
  -- (institution_city_key) below still works, since Postgres computes the
  -- generated value before conflict detection regardless of whether the
  -- INSERT mentions it.
  INSERT INTO india_site_profiles (
    institution_name, city, state, site_type, specialties,
    ctgov_nct_ids, ctri_ids, active_trials
  ) VALUES (
    p_institution_name, p_city, p_state, p_site_type, p_specialties,
    p_ctgov_nct_ids, p_ctri_ids, p_active_trials
  )
  ON CONFLICT (institution_city_key) DO UPDATE SET
    specialties     = CASE
      WHEN array_length(EXCLUDED.specialties, 1) > array_length(india_site_profiles.specialties, 1)
      THEN EXCLUDED.specialties
      ELSE india_site_profiles.specialties
    END,
    ctgov_nct_ids   = (
      SELECT array_agg(DISTINCT e) FROM unnest(
        india_site_profiles.ctgov_nct_ids || EXCLUDED.ctgov_nct_ids
      ) AS e
    ),
    ctri_ids        = (
      SELECT array_agg(DISTINCT e) FROM unnest(
        india_site_profiles.ctri_ids || EXCLUDED.ctri_ids
      ) AS e
    ),
    active_trials   = GREATEST(india_site_profiles.active_trials, EXCLUDED.active_trials),
    updated_at      = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_site_profile TO service_role;

-- ═══════════════════════════════════════════════════════════════════
-- FIX 2: Auto-create enrollment monitor tasks via DB trigger
-- This is a safety net — match/index.ts also inserts tasks directly.
-- The trigger catches any future code paths that update match_results
-- to 'done' without going through match/index.ts (e.g. future FHIR jobs).
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION create_enrollment_monitor_task()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_nct_id text;
BEGIN
  -- Only fire when status transitions TO 'done' from something else
  IF NEW.status = 'done' AND (OLD.status IS DISTINCT FROM 'done') THEN
    -- Extract top match NCT ID from the matches JSONB array
    v_nct_id := NEW.matches->0->>'nctId';

    -- Insert monitor task; ignore if one already exists for this match result
    INSERT INTO enrollment_monitor_tasks (
      org_id,
      match_result_id,
      patient_id,
      nct_id,
      enrollment_status,
      last_status_change,
      days_in_status,
      alert_if_no_contact_hours,
      alert_on_competing_trial,
      alert_count,
      is_active
    ) VALUES (
      NEW.org_id,
      NEW.id,
      NEW.patient_id,
      v_nct_id,
      COALESCE(NEW.enrollment_status, 'pending'),
      now(),
      0,
      48,
      true,
      0,
      true
    )
    ON CONFLICT (match_result_id) DO NOTHING;
  END IF;

  -- Keep monitor task in sync when enrollment_status changes
  IF NEW.enrollment_status IS DISTINCT FROM OLD.enrollment_status THEN
    UPDATE enrollment_monitor_tasks
    SET
      enrollment_status  = NEW.enrollment_status,
      last_status_change = now(),
      days_in_status     = 0,
      -- Mark as inactive when pipeline reaches a terminal state
      is_active          = CASE
        WHEN NEW.enrollment_status IN ('enrolled', 'screen_failed', 'patient_declined', 'trial_closed')
        THEN false
        ELSE true
      END,
      completed_at       = CASE
        WHEN NEW.enrollment_status IN ('enrolled', 'screen_failed', 'patient_declined', 'trial_closed')
        THEN now()
        ELSE NULL
      END
    WHERE match_result_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

-- Unique constraint on match_result_id so ON CONFLICT DO NOTHING works.
--
-- `ADD CONSTRAINT IF NOT EXISTS` (the previous version of this
-- statement) is not valid PostgreSQL syntax — IF NOT EXISTS is only
-- supported for ADD COLUMN, not ADD CONSTRAINT. It failed as a syntax
-- error every time this migration ran, which silently meant this
-- constraint was NEVER created — confirmed by actually running this
-- migration against a real Postgres instance and then exercising the
-- trigger below for real: every UPDATE of match_results to status='done'
-- (i.e. every completed match, in production) threw "there is no unique
-- or exclusion constraint matching the ON CONFLICT specification" from
-- inside this trigger, which aborted that UPDATE — the core match flow's
-- own result could never actually get persisted. This DO block achieves
-- the same "safe to re-run" intent the invalid IF NOT EXISTS syntax was
-- reaching for, correctly this time.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'enrollment_monitor_tasks_match_result_id_key'
  ) THEN
    ALTER TABLE enrollment_monitor_tasks
      ADD CONSTRAINT enrollment_monitor_tasks_match_result_id_key
      UNIQUE (match_result_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_enrollment_monitor ON match_results;
CREATE TRIGGER trg_enrollment_monitor
  AFTER UPDATE ON match_results
  FOR EACH ROW
  EXECUTE FUNCTION create_enrollment_monitor_task();

-- Backfill: create tasks for existing completed match results that have none
INSERT INTO enrollment_monitor_tasks (
  org_id, match_result_id, patient_id, nct_id,
  enrollment_status, last_status_change, days_in_status,
  alert_if_no_contact_hours, alert_on_competing_trial, alert_count, is_active
)
SELECT
  mr.org_id,
  mr.id,
  mr.patient_id,
  mr.matches->0->>'nctId',
  COALESCE(mr.enrollment_status, 'pending'),
  COALESCE(mr.updated_at, mr.created_at),
  0, 48, true, 0,
  mr.enrollment_status NOT IN ('enrolled', 'screen_failed', 'patient_declined', 'trial_closed')
FROM match_results mr
LEFT JOIN enrollment_monitor_tasks emt ON emt.match_result_id = mr.id
WHERE mr.status = 'done' AND emt.id IS NULL
ON CONFLICT (match_result_id) DO NOTHING;

SELECT
  (SELECT COUNT(*) FROM india_site_profiles)    AS site_profiles,
  (SELECT COUNT(*) FROM enrollment_monitor_tasks) AS monitor_tasks;
-- Both should show row counts after backfill (not zeros).
