-- TrialMatch India — Security & Correctness Fixes Migration 014
-- Run AFTER 013_fixes.sql
--
-- Fix 1: rematch_runs was the only table (of 25) created without RLS
--         enabled. Low severity — it holds only aggregate job counts, no
--         patient or org data — but closed here for completeness. No
--         policies are added because only the cron job (via the
--         service-role client, which bypasses RLS entirely) ever touches
--         this table; enabling RLS with zero policies means anon/
--         authenticated roles get zero access by default, which is correct.
--
-- Fix 2: match_results needs a source_status column. This supports the
--         lib/matcher.ts fix that removed the "AI-Synthesised" fabricated-
--         trial fallback — every match run now records whether
--         ClinicalTrials.gov and CTRI were actually reachable, so the UI
--         can show a coordinator the honest difference between "zero live
--         trials found" and "we couldn't check right now" instead of
--         collapsing both into the same silent empty state.

-- ═══════════════════════════════════════════════════════════════════
-- FIX 1: Enable RLS on rematch_runs
-- ═══════════════════════════════════════════════════════════════════

alter table rematch_runs enable row level security;

-- ═══════════════════════════════════════════════════════════════════
-- FIX 2: source_status column on match_results
-- ═══════════════════════════════════════════════════════════════════

alter table match_results
  add column if not exists source_status jsonb;

comment on column match_results.source_status is
  'Per-source fetch outcome for this match run, e.g. {"ctgov":"ok","ctri":"error","ctriError":"..."}. '
  '''error'' means the registry could not be reached — distinct from a genuine zero-result search. '
  'Written by lib/matcher.ts. Added in migration 014 alongside removal of the AI-Synthesised fabricated-trial fallback.';

-- Sanity check — should show the new column present with zero NOT NULL
-- violations (it's nullable, so existing rows are unaffected).
SELECT column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_name = 'match_results' AND column_name = 'source_status';
