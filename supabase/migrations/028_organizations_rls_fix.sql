-- TrialMatch India — Migration 028
-- Run AFTER 027_llm_provider_settings.sql
--
-- Found during continued review after adding llm_api_key_encrypted to
-- this table: organizations has exactly one RLS policy, org_self_read,
-- and it has no FOR clause — which defaults to FOR ALL. Confirmed
-- directly against the live database (not assumed): cmd = 'ALL'. That
-- means any org member, not just admin/owner, could UPDATE their org's
-- row directly if RLS were ever the live enforcement boundary — the
-- same class of gap migration 025 found and fixed for audit_log, now
-- more consequential here specifically because this table holds an
-- encrypted AI provider credential (migration 027) that pages/api/org's
-- PATCH handler already correctly restricts to admin/owner server-side.
-- This migration makes the DB-level guarantee match that server-side
-- enforcement, rather than relying on the API layer alone.
--
-- As established elsewhere in this project's own audit trail: the
-- browser never obtains a real per-user Supabase JWT here (NextAuth
-- issues its own, unrelated to and unrecognized by Supabase's
-- auth.uid()), so this isn't a currently-reachable exploit — it's
-- defense-in-depth, the same category as the audit_log fix, fixed for
-- the same reason: a policy that's broader than intended shouldn't sit
-- there just because nothing currently reaches it.
--
-- No INSERT/DELETE policy is added, intentionally — organizations are
-- created via the signup flow using the service-role client (which
-- bypasses RLS entirely), never by a regular authenticated user
-- directly, and should never be deletable by one either.

DROP POLICY IF EXISTS "org_self_read" ON organizations;

DROP POLICY IF EXISTS "org_members_read" ON organizations;
CREATE POLICY "org_members_read"
  ON organizations FOR SELECT
  USING (id = (SELECT org_id FROM users WHERE id = auth.uid()));

DROP POLICY IF EXISTS "org_admins_update" ON organizations;
CREATE POLICY "org_admins_update"
  ON organizations FOR UPDATE
  USING (
    id = (SELECT org_id FROM users WHERE id = auth.uid() AND role IN ('admin', 'owner'))
    OR auth.role() = 'service_role'
  );

-- Verify
SELECT policyname, cmd FROM pg_policies WHERE tablename = 'organizations' ORDER BY policyname;
-- Expected: exactly 2 rows — org_members_read (SELECT), org_admins_update (UPDATE)

SELECT 'Migration 028 complete' AS status;
