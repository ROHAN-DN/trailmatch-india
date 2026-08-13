-- TrialMatch India — Compliance Migration 001
-- Run AFTER schema.sql in Supabase SQL Editor
-- Adds DPDP Act 2023 compliance columns

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS consent_given      boolean     DEFAULT false,
  ADD COLUMN IF NOT EXISTS consent_given_at   timestamptz;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS data_retention_months int DEFAULT 24;

UPDATE organizations SET data_retention_months = 24
  WHERE data_retention_months IS NULL;

-- Verify
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'patients'
  AND column_name IN ('consent_given', 'consent_given_at')
ORDER BY column_name;
-- Expected: 2 rows
