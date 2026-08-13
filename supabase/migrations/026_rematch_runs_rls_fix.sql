-- TrialMatch India — Migration 026
-- Run AFTER 025_audit_log_rls_fix.sql
--
-- Found during a systematic policy audit (Tier 3 security pass) of every
-- table, not just the ones that looked interesting: `rematch_runs` has
-- RLS enabled (migration 014_security_fixes.sql turned it on, correctly
-- flagging it as "the only table of 25 created without RLS") but zero
-- policies were ever added. RLS-enabled-with-no-policies means Postgres
-- default-denies everyone except the table owner and roles with
-- BYPASSRLS (service_role) — so this doesn't currently break anything,
-- since the only thing that could ever query this table is service-role
-- code, which bypasses RLS entirely regardless of policies. Confirmed
-- separately: rematch_runs is not referenced anywhere in application
-- code today (lib/rematch.ts doesn't write to it) — it's dead, matching
-- this project's own established pattern of features defined in SQL but
-- never wired up (see rxnorm.ts's history for the same class of gap,
-- now fixed). This migration doesn't wire it up — that's a product
-- decision, not a security fix — it just makes the table's access
-- control correctly defined, consistent with every other global
-- (non-org-scoped) table in this schema, so it's ready whenever
-- something does read/write it, rather than silently returning zero
-- rows to anyone who eventually tries.
--
-- Pattern matched exactly from mrr_snapshots (the other cross-org,
-- service-role-only table): FOR ALL, service_role only.

DROP POLICY IF EXISTS "service_role_only_rematch_runs" ON rematch_runs;
CREATE POLICY "service_role_only_rematch_runs"
  ON rematch_runs FOR ALL
  USING (auth.role() = 'service_role');

SELECT policyname, cmd FROM pg_policies WHERE tablename = 'rematch_runs';
-- Expected: 1 row — service_role_only_rematch_runs.

SELECT 'Migration 026 complete' AS status;
