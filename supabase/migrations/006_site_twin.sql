-- TrialMatch India — India Site Twin Network Migration 006
-- Run AFTER 005_performance.sql
-- Creates india_site_profiles (the Site Twin table) + org linking function

CREATE TABLE IF NOT EXISTS india_site_profiles (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Link to a TrialMatch org IF this site has signed up (nullable until they do)
  org_id               uuid REFERENCES organizations(id) ON DELETE SET NULL,

  -- Identity
  institution_name     text NOT NULL,
  city                 text,
  state                text,
  site_type            text DEFAULT 'hospital'
    CHECK (site_type IN ('hospital','academic','cro','research_center','government')),
  specialties          text[] DEFAULT '{}',

  -- Performance metrics (refreshed weekly by cron)
  active_trials        int DEFAULT 0,
  pi_count             int DEFAULT 0,
  total_patients       int DEFAULT 0,   -- de-identified count from TrialMatch
  avg_enrollment_rate  float,           -- patients enrolled per month (historical)
  avg_dropout_rate     float,
  avg_startup_days     int,             -- contract-to-first-patient average

  -- Status
  is_partner           boolean DEFAULT false,  -- true when org_id is set
  is_verified          boolean DEFAULT false,

  -- Source tracking
  ctgov_nct_ids        text[] DEFAULT '{}',    -- NCT IDs of trials at this site
  ctri_ids             text[] DEFAULT '{}',

  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

-- Prevent duplicates from seed script
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_profiles_institution_city
  ON india_site_profiles (lower(institution_name), lower(coalesce(city,'')));

CREATE INDEX IF NOT EXISTS idx_site_profiles_city      ON india_site_profiles (city);
CREATE INDEX IF NOT EXISTS idx_site_profiles_state     ON india_site_profiles (state);
CREATE INDEX IF NOT EXISTS idx_site_profiles_partner   ON india_site_profiles (is_partner);
CREATE INDEX IF NOT EXISTS idx_site_profiles_org       ON india_site_profiles (org_id) WHERE org_id IS NOT NULL;

-- GIN index for specialty search (array containment)
CREATE INDEX IF NOT EXISTS idx_site_profiles_specialties
  ON india_site_profiles USING gin (specialties);

-- Full-text search on institution name
CREATE INDEX IF NOT EXISTS idx_site_profiles_name_trgm
  ON india_site_profiles USING gin (institution_name gin_trgm_ops);

-- ── link_org_to_site_twin() ────────────────────────────────────────────────
-- Called when an org signs up or admin links manually.
-- Fuzzy-matches org name to site profiles and sets org_id + is_partner = true.
CREATE OR REPLACE FUNCTION link_org_to_site_twin(p_org_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_org_name text;
  v_site_id  uuid;
BEGIN
  SELECT name INTO v_org_name FROM organizations WHERE id = p_org_id;
  IF v_org_name IS NULL THEN RETURN; END IF;

  -- Try exact match first, then trigram similarity
  SELECT id INTO v_site_id
  FROM india_site_profiles
  WHERE lower(institution_name) = lower(v_org_name)
     OR similarity(institution_name, v_org_name) > 0.5
  ORDER BY similarity(institution_name, v_org_name) DESC
  LIMIT 1;

  IF v_site_id IS NOT NULL THEN
    UPDATE india_site_profiles
    SET org_id = p_org_id, is_partner = true, updated_at = now()
    WHERE id = v_site_id;
  END IF;
END;
$$;

-- ── RLS: site profiles are publicly readable (aggregate data only, no PII)
ALTER TABLE india_site_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "site_profiles_read_all_authenticated"
  ON india_site_profiles FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Only service role (admin/cron) can insert/update
CREATE POLICY "site_profiles_service_write"
  ON india_site_profiles FOR ALL
  USING (auth.role() = 'service_role');

-- Verify
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'india_site_profiles';
-- Expected: 1 row
