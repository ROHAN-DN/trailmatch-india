-- TrialMatch India — Notifications + pg_cron Schema Additions
-- Run this in Supabase SQL Editor AFTER running the base schema.sql

-- ── Org notification preferences ─────────────────────────────
create table org_notifications (
  id                        uuid primary key default uuid_generate_v4(),
  org_id                    uuid unique references organizations(id) on delete cascade,
  -- WhatsApp
  whatsapp_number           text,        -- e.g. "919876543210" (no + or spaces)
  notify_on_match_complete  boolean default true,
  notify_on_new_trials      boolean default true,
  notify_on_batch_complete  boolean default true,
  -- Email
  notify_email              text,        -- coordinator email for notifications
  email_on_match_complete   boolean default true,
  email_on_new_trials       boolean default true,
  created_at                timestamptz default now(),
  updated_at                timestamptz default now()
);

alter table org_notifications enable row level security;
create policy "org_isolation_notifications" on org_notifications
  using (org_id = (select org_id from users where id = auth.uid()));

create trigger trg_org_notifications_updated
  before update on org_notifications
  for each row execute function update_updated_at();


-- ── Scheduled re-match log ────────────────────────────────────
create table rematch_runs (
  id              uuid primary key default uuid_generate_v4(),
  started_at      timestamptz default now(),
  completed_at    timestamptz,
  patients_total  int default 0,
  patients_done   int default 0,
  new_trials_found int default 0,
  errors          int default 0,
  status          text default 'running' check (status in ('running','completed','failed'))
);


-- ── Enable pg_net extension (needed for http calls from pg_cron) ──
create extension if not exists pg_net;

-- ── Enable pg_cron extension ──────────────────────────────────
-- Note: pg_cron is available on Supabase Pro plan.
-- On Free plan, use an external cron service like cron-job.org instead.
create extension if not exists pg_cron;

-- ── Schedule weekly re-match ──────────────────────────────────
-- Runs every Sunday at 00:30 UTC = 06:00 IST
-- IMPORTANT: Replace YOUR_VERCEL_URL and YOUR_CRON_SECRET before running.

select cron.schedule(
  'weekly-rematch',          -- job name
  '30 0 * * 0',             -- cron expression: Sunday 00:30 UTC
  $$
    select net.http_post(
      url     := 'https://YOUR_VERCEL_URL/api/cron/rematch',
      headers := jsonb_build_object(
        'Content-Type',    'application/json',
        'x-cron-secret',   'YOUR_CRON_SECRET'
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- ── Verify the scheduled job ──────────────────────────────────
-- Run this to confirm the job is registered:
-- select * from cron.job;

-- ── To manually trigger a run (for testing) ───────────────────
-- select net.http_post(
--   url     := 'https://YOUR_VERCEL_URL/api/cron/rematch',
--   headers := '{"Content-Type":"application/json","x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb,
--   body    := '{}'::jsonb
-- );

-- ── To pause/resume the job ───────────────────────────────────
-- update cron.job set active = false where jobname = 'weekly-rematch';  -- pause
-- update cron.job set active = true  where jobname = 'weekly-rematch';  -- resume

-- ── To delete the job ─────────────────────────────────────────
-- select cron.unschedule('weekly-rematch');


-- ── Alternative: cron-job.org (Free plan workaround) ─────────
-- If you're on Supabase Free plan (no pg_cron), use cron-job.org:
-- 1. Go to https://cron-job.org and create a free account
-- 2. Create a new cronjob:
--    URL:     https://YOUR_VERCEL_URL/api/cron/rematch
--    Method:  POST
--    Headers: x-cron-secret: YOUR_CRON_SECRET
--    Schedule: Every Sunday at 06:00 IST (00:30 UTC)
-- Total cost: Free
