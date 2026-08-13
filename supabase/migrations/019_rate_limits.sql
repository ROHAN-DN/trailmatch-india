-- TrialMatch India — Migration 019
-- Run AFTER 018_trial_criteria_cache.sql
--
-- Postgres-backed rate limiting
--
-- Why: lib/ratelimit.ts used a plain in-memory Map, and said so honestly
-- in its own header comment — "This Map is per-serverless-instance... does
-- NOT enforce a true global limit across all instances... an accepted
-- tradeoff for Phase 1." On Vercel, concurrent requests can land on
-- different warm instances (or trigger new cold starts), each with its
-- own empty Map, so none of this project's rate limits — the match
-- endpoint, patient creation, ABDM OTP requests, feasibility runs — were
-- reliably enforced once traffic stopped being small enough to mostly
-- land on one warm instance. This migration moves the counters into
-- Postgres, which is genuinely shared across every instance, using the
-- same "no new infrastructure" approach as everything else in this
-- project (no Redis, no new paid dependency — Supabase is already here).
--
-- Correctness under real concurrency, not just under a single request:
-- check_and_increment_rate_limit() below does the "is this window still
-- current, and should this request be counted or rejected" logic as ONE
-- atomic INSERT ... ON CONFLICT ... RETURNING statement, not a
-- read-then-write from application code. Two concurrent requests for the
-- same key genuinely serialize at the database row level — the second
-- transaction blocks until the first's write commits, then sees its
-- result — which is exactly the property a rate limiter needs and a
-- naive "SELECT count, then UPDATE if under limit" implementation does
-- not have (that shape has a real race: two concurrent requests can both
-- read the same "before" count and both decide they're allowed).

CREATE TABLE IF NOT EXISTS rate_limits (
  key       text PRIMARY KEY,
  count     int NOT NULL DEFAULT 1,
  reset_at  timestamptz NOT NULL
);

-- No separate cleanup job for expired rows — see
-- check_and_increment_rate_limit's own comment: an expired row is
-- indistinguishable from a fresh one to this function (it resets on read),
-- so stale rows are inert, not incorrect. Left in place rather than adding
-- a pg_cron job (Free-tier Supabase projects don't have pg_cron at all —
-- see notifications_and_cron.sql's own header) for a table whose rows are
-- tiny and whose count naturally stays bounded by the number of distinct
-- orgs/users/IPs actually making requests.

CREATE OR REPLACE FUNCTION check_and_increment_rate_limit(
  p_key          text,
  p_max_requests int,
  p_window_ms    int
) RETURNS TABLE(allowed boolean, remaining int, reset_in_ms bigint) LANGUAGE plpgsql AS $$
DECLARE
  v_now      timestamptz := clock_timestamp();
  v_count    int;
  v_reset_at timestamptz;
BEGIN
  INSERT INTO rate_limits (key, count, reset_at)
  VALUES (p_key, 1, v_now + (p_window_ms || ' milliseconds')::interval)
  ON CONFLICT (key) DO UPDATE SET
    count    = CASE WHEN rate_limits.reset_at <= v_now THEN 1
                     ELSE rate_limits.count + 1 END,
    reset_at = CASE WHEN rate_limits.reset_at <= v_now
                     THEN v_now + (p_window_ms || ' milliseconds')::interval
                     ELSE rate_limits.reset_at END
  RETURNING rate_limits.count, rate_limits.reset_at INTO v_count, v_reset_at;

  RETURN QUERY SELECT
    (v_count <= p_max_requests)                                        AS allowed,
    GREATEST(0, p_max_requests - v_count)                               AS remaining,
    GREATEST(0, CEIL(EXTRACT(EPOCH FROM (v_reset_at - v_now)) * 1000))::bigint AS reset_in_ms;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- RLS — same shape as trial_criteria_cache (migration 018) and
-- india_site_profiles (migration 006): global, not org-scoped data
-- (a rate-limit key can be an org, a user, or a raw IP — none of those
-- map to "this row belongs to org X" the way every patient-data table
-- does), read for any authenticated caller, write restricted to the
-- service role — in practice only ever called via supabaseAdmin() from
-- lib/ratelimit.ts itself.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rate_limits_read_all" ON rate_limits
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "rate_limits_service_write" ON rate_limits
  FOR ALL USING (auth.role() = 'service_role');

GRANT EXECUTE ON FUNCTION check_and_increment_rate_limit TO service_role;

-- Verify
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'rate_limits';
-- Expected: 1 row

SELECT 'Migration 019 complete' AS status;
