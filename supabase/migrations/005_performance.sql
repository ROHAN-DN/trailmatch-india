-- TrialMatch India — Performance Migration 005
-- Run AFTER 004_feasibility.sql
--
-- WHY: lib/feasibility.ts runs ILIKE '%term%' queries against diagnosis,
-- medications, labs, and comorbidities for every site × every criterion.
-- Without trigram indexes these are sequential full table scans — fine at
-- Phase 1 scale (3 pilot orgs) but will degrade as patient counts and org
-- counts grow in Phase 2 (sponsor portal, multi-site feasibility).
--
-- pg_trgm enables fast ILIKE '%substring%' lookups via GIN indexes,
-- which a standard btree index cannot accelerate.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_patients_diagnosis_trgm
  ON patients USING gin (diagnosis gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_patients_medications_trgm
  ON patients USING gin (medications gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_patients_labs_trgm
  ON patients USING gin (labs gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_patients_comorbidities_trgm
  ON patients USING gin (comorbidities gin_trgm_ops);

-- Composite index to speed up the base "active patients at org" count
-- that feasibility.ts runs first for every site.
CREATE INDEX IF NOT EXISTS idx_patients_org_active
  ON patients (org_id, is_archived) WHERE is_archived = false;

-- Verify
SELECT indexname FROM pg_indexes
WHERE tablename = 'patients' AND indexname LIKE '%trgm%';
-- Expected: 4 rows
