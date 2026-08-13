-- TrialMatch India — Migration 020
-- Run AFTER 019_rate_limits.sql
--
-- Two related fixes, found together while wiring up match-jobs/month
-- enforcement (previously advertised in lib/plans.ts's trial-tier
-- features list, never actually enforced anywhere):
--
-- 1. max_match_jobs_per_month didn't exist as a column at all — added
--    below, matching the same per-org-overridable pattern already used
--    for max_patients/max_users (see schema.sql's organizations table
--    and lib/gate.ts's checkLimit).
--
-- 2. organizations.max_patients/max_users' column DEFAULTs never matched
--    what the 'trial' plan they default alongside actually advertises.
--    schema.sql: `max_users int default 5, max_patients int default 50`.
--    lib/plans.ts's trial tier: max_users: 2, max_patients: 10. Every
--    self-signup organization — created via
--    pages/api/auth/[...nextauth].ts's "New user" branch, which never
--    set these columns explicitly, relying entirely on these defaults —
--    silently got 2.5x the advertised team-member capacity and 5x the
--    advertised patient capacity of the free trial it was labelled as,
--    for its full lifetime on that plan. Confirmed by reading
--    schema.sql's column defaults directly against lib/plans.ts's
--    PLANS.trial values — not a guess.
--
--    Fixed at the column-default level here (defense in depth for
--    anything that ever inserts an organizations row without setting
--    these explicitly) AND, more importantly, at the actual org-creation
--    code path itself (pages/api/auth/[...nextauth].ts now sets all
--    three limits explicitly from lib/plans.ts's PLANS.trial, the single
--    source of truth, rather than depending on column defaults to happen
--    to agree with it).
--
--    Deliberately NOT touched here: any already-existing organization's
--    current max_patients/max_users values. Retroactively lowering a
--    real, already-onboarded org's limit is a support/business decision
--    (grandfather them in, or enforce the corrected cap and risk breaking
--    their workflow if they're already over it), not something a
--    migration should silently decide. Given this product has no real
--    production organizations yet (see FIXES_2026-07-27.md's Tier 5
--    disclosure), this is moot today but worth stating explicitly for
--    whenever it stops being moot.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS max_match_jobs_per_month int DEFAULT 5;

ALTER TABLE organizations ALTER COLUMN max_patients SET DEFAULT 10;
ALTER TABLE organizations ALTER COLUMN max_users    SET DEFAULT 2;

-- Verify
SELECT column_name, column_default
FROM information_schema.columns
WHERE table_name = 'organizations'
  AND column_name IN ('max_patients', 'max_users', 'max_match_jobs_per_month')
ORDER BY column_name;
-- Expected: max_match_jobs_per_month default 5, max_patients default 10, max_users default 2

SELECT 'Migration 020 complete' AS status;
