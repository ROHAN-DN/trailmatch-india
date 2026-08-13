-- TrialMatch India — Migration 018
-- Run AFTER 017_structured_clinical_data.sql
--
-- Trial Criteria Cache
--
-- Why: every single match run re-extracts criteria from scratch for
-- every retrieved trial — the free rule-based regex/dictionary pass
-- (lib/rule-based-extraction.ts) AND the Claude call that extracts
-- structured criteria from whatever residual text the rule-based pass
-- couldn't parse (lib/matcher.ts's scoreWithClaude). A trial's
-- eligibility criteria do not depend on which patient is being matched
-- against it — a popular trial matched against 50 patients this week
-- pays for the same extraction 50 times over, including 50 separate
-- Claude API calls for the residual-extraction portion, purely because
-- nothing remembers the answer from the first time. This table is that
-- memory: extract once per trial, reuse for every subsequent match,
-- until the trial's own eligibility text actually changes.
--
-- Deliberately NOT org-scoped, unlike every patient-data table in this
-- schema (patients, patient_labs, match_results, ...). A trial's
-- eligibility criteria are a fact about the trial — sourced from
-- ClinicalTrials.gov/CTRI's own public registry text — not about any
-- patient or organisation. Caching it per-org would multiply the very
-- redundant work this table exists to eliminate by the number of orgs on
-- the platform, for zero benefit: two different hospitals matching
-- against the same NCT ID should get the same cached criteria, not
-- separately pay to extract it twice. The precedent for a global,
-- service-write-managed table already exists in this schema —
-- india_site_profiles (migration 006) uses the identical
-- read-all-authenticated / service-role-write RLS shape for the same
-- reason (site profiles aren't org-specific facts either).
--
-- Self-invalidating on trial-text changes, not just NCT/CTRI-ID-keyed:
-- eligibility_text_hash is a sha256 of the exact eligibility text a
-- cache entry's criteria were extracted from. A protocol amendment that
-- changes a trial's eligibility criteria produces a different hash, so
-- the next match against that trial is a genuine cache miss — re-extract
-- and overwrite — rather than silently serving criteria that no longer
-- match the live protocol text. Keying by NCT/CTRI ID alone (with no
-- hash check) would have been simpler but wrong: a cache that can go
-- stale and never self-corrects is worse than no cache, for something
-- feeding into a clinical eligibility decision.

CREATE TABLE IF NOT EXISTS trial_criteria_cache (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),

  source                 text NOT NULL CHECK (source IN ('ClinicalTrials.gov', 'CTRI')),
  trial_id               text NOT NULL,              -- NCT ID or CTRI registration number
  eligibility_text_hash  text NOT NULL,               -- sha256 hex digest of the eligibility text these criteria came from — see header

  -- The full, final criteria set for this trial — rule-based AND
  -- AI-extracted entries already merged and deduped, in the same shape
  -- lib/eligibility-rules.ts's Criterion[] expects. Evaluation against a
  -- given patient's structured clinical data still happens fresh on
  -- every match (that part genuinely does depend on the patient) — only
  -- the extraction of WHAT the criteria are is what this table caches.
  criteria               jsonb NOT NULL DEFAULT '[]',

  -- Observability only — not read by matching logic, just makes it
  -- possible to see the rule-based/AI split for a cached trial without
  -- re-deriving it from criteria's own extractionSource-equivalent field.
  rule_based_count       int NOT NULL DEFAULT 0,
  ai_extracted_count     int NOT NULL DEFAULT 0,

  extracted_at           timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trial_criteria_cache_unique_trial UNIQUE (source, trial_id)
);

-- No separate index needed beyond the unique constraint's own index —
-- every real lookup is `WHERE source = ? AND trial_id = ?` (optionally
-- AND eligibility_text_hash = ? for a hit-or-miss check), and
-- (source, trial_id) is exactly the unique index's leftmost columns.

CREATE OR REPLACE FUNCTION set_trial_criteria_cache_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_trial_criteria_cache_updated
  BEFORE UPDATE ON trial_criteria_cache
  FOR EACH ROW EXECUTE FUNCTION set_trial_criteria_cache_updated_at();

-- ═══════════════════════════════════════════════════════════════════
-- RLS — same shape as india_site_profiles (migration 006): this is
-- global, non-sensitive, service-managed data, not org-scoped patient
-- data. Read allowed for any authenticated user (a future coordinator UI
-- showing "criteria last extracted for this trial" could query it
-- directly); writes restricted to the service role, since only
-- lib/matcher.ts (via supabaseAdmin, server-side only) ever populates
-- this table.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE trial_criteria_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trial_criteria_cache_read_all" ON trial_criteria_cache
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "trial_criteria_cache_service_write" ON trial_criteria_cache
  FOR ALL USING (auth.role() = 'service_role');

-- Verify
SELECT table_name, (SELECT rowsecurity FROM pg_tables WHERE tablename = table_name) AS rls_enabled
FROM information_schema.tables
WHERE table_name = 'trial_criteria_cache';
-- Expected: 1 row, rls_enabled = true

SELECT 'Migration 018 complete' AS status;
