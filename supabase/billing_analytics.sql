-- TrialMatch India — Stripe Billing Analytics SQL
-- Run in Supabase SQL Editor after billing.sql

-- ══════════════════════════════════════════════════════════════
-- TABLE: mrr_snapshots
-- Daily snapshot of MRR per org (populated by the analytics API
-- after each webhook event and by the daily cron job)
-- ══════════════════════════════════════════════════════════════
create table if not exists mrr_snapshots (
  id           uuid primary key default uuid_generate_v4(),
  snapshot_date date not null default current_date,
  org_id       uuid references organizations(id) on delete cascade,
  plan         text,
  mrr_paise    bigint default 0,   -- monthly recurring revenue in paise
  status       text,               -- subscription_status at snapshot time
  created_at   timestamptz default now(),
  unique(snapshot_date, org_id)
);

create index idx_mrr_snapshots_date on mrr_snapshots(snapshot_date);
create index idx_mrr_snapshots_org  on mrr_snapshots(org_id);

alter table mrr_snapshots enable row level security;
-- Admin-only — no org isolation for cross-org totals (service role only)
create policy "service_role_only_mrr" on mrr_snapshots
  using (auth.role() = 'service_role');


-- ══════════════════════════════════════════════════════════════
-- VIEW: v_current_mrr_by_plan
-- Current MRR broken down by plan
-- ══════════════════════════════════════════════════════════════
create or replace view v_current_mrr_by_plan as
select
  o.plan,
  count(ob.id)                                    as subscribers,
  -- MRR in INR (paise → rupees)
  sum(ob.last_invoice_amount) / 100               as mrr_inr,
  -- Average revenue per account
  round(
    avg(ob.last_invoice_amount) / 100
  )                                               as arpa_inr,
  -- Percentage of total MRR
  round(
    100.0 * sum(ob.last_invoice_amount)
      / nullif(sum(sum(ob.last_invoice_amount)) over (), 0),
    1
  )                                               as mrr_pct
from org_billing ob
join organizations o on o.id = ob.org_id
where ob.subscription_status in ('active', 'trialing')
  and ob.last_invoice_amount > 0
group by o.plan
order by mrr_inr desc nulls last;


-- ══════════════════════════════════════════════════════════════
-- VIEW: v_subscription_status_counts
-- Subscription health overview
-- ══════════════════════════════════════════════════════════════
create or replace view v_subscription_status_counts as
select
  subscription_status,
  count(*)              as count,
  round(
    100.0 * count(*) / nullif(sum(count(*)) over (), 0), 1
  )                     as pct
from org_billing
group by subscription_status
order by count desc;


-- ══════════════════════════════════════════════════════════════
-- VIEW: v_plan_distribution
-- All orgs by plan (including free trial)
-- ══════════════════════════════════════════════════════════════
create or replace view v_plan_distribution as
select
  o.plan,
  count(*)                      as org_count,
  count(*) filter (
    where ob.subscription_status in ('active','trialing')
  )                             as paying_count,
  round(
    100.0 * count(*) / nullif(sum(count(*)) over (), 0), 1
  )                             as org_pct
from organizations o
left join org_billing ob on ob.org_id = o.id
group by o.plan
order by
  case o.plan
    when 'enterprise' then 1
    when 'pro'        then 2
    when 'starter'    then 3
    when 'trial'      then 4
    else 5
  end;


-- ══════════════════════════════════════════════════════════════
-- VIEW: v_churn_events
-- Cancelled or downgraded subscriptions with timing
-- ══════════════════════════════════════════════════════════════
create or replace view v_churn_events as
select
  ob.org_id,
  o.name                                  as org_name,
  o.plan                                  as current_plan,
  ob.subscription_status,
  ob.canceled_at,
  ob.current_period_end                   as access_until,
  ob.last_invoice_amount / 100            as last_mrr_inr,
  ob.stripe_price_id,
  -- Months as customer (from first invoice to cancellation)
  round(
    extract(epoch from (
      coalesce(ob.canceled_at, now()) - ob.current_period_start
    )) / (30.0 * 24 * 3600),
    1
  )                                       as months_as_customer
from org_billing ob
join organizations o on o.id = ob.org_id
where ob.subscription_status in ('canceled', 'past_due', 'unpaid')
   or ob.cancel_at_period_end = true
order by ob.canceled_at desc nulls last;


-- ══════════════════════════════════════════════════════════════
-- VIEW: v_trial_conversion
-- Free trial → paid conversion funnel
-- ══════════════════════════════════════════════════════════════
create or replace view v_trial_conversion as
select
  count(*) filter (where o.plan = 'trial')                   as on_free_trial,
  count(*) filter (
    where ob.subscription_status in ('active','trialing')
  )                                                          as paying_subscribers,
  count(*) filter (
    where ob.subscription_status = 'canceled'
    and ob.last_invoice_amount > 0
  )                                                          as churned,
  -- Conversion rate: paying / (paying + free trial with signup > 14 days)
  round(
    100.0 * count(*) filter (
      where ob.subscription_status in ('active','trialing')
    ) / nullif(count(*), 0),
    1
  )                                                          as conversion_rate_pct,
  -- Monthly churn rate
  round(
    100.0 * count(*) filter (
      where ob.subscription_status = 'canceled'
        and ob.canceled_at >= now() - interval '30 days'
    ) / nullif(
      count(*) filter (
        where ob.subscription_status in ('active','trialing','canceled')
      ),
      0
    ),
    1
  )                                                          as monthly_churn_rate_pct
from organizations o
left join org_billing ob on ob.org_id = o.id;


-- ══════════════════════════════════════════════════════════════
-- VIEW: v_mrr_over_time
-- Total MRR per day from mrr_snapshots (for sparkline chart)
-- ══════════════════════════════════════════════════════════════
create or replace view v_mrr_over_time as
select
  snapshot_date,
  sum(mrr_paise) / 100          as total_mrr_inr,
  count(distinct org_id)         as active_orgs,
  sum(mrr_paise) filter (
    where plan = 'pro'
  ) / 100                        as pro_mrr_inr,
  sum(mrr_paise) filter (
    where plan = 'starter'
  ) / 100                        as starter_mrr_inr
from mrr_snapshots
where status in ('active', 'trialing')
group by snapshot_date
order by snapshot_date;


-- ══════════════════════════════════════════════════════════════
-- RPC: get_billing_analytics_summary
-- Single call returns all KPIs for the analytics header cards
-- ══════════════════════════════════════════════════════════════
create or replace function get_billing_analytics_summary()
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    -- Total MRR (active + trialing, in INR)
    'total_mrr_inr', (
      select coalesce(sum(last_invoice_amount), 0) / 100
      from org_billing
      where subscription_status in ('active', 'trialing')
        and last_invoice_amount > 0
    ),
    -- MoM MRR growth (compare this month vs last month from snapshots)
    'mrr_growth_pct', (
      with monthly as (
        select
          date_trunc('month', snapshot_date) as month,
          sum(mrr_paise) / 100 as mrr
        from mrr_snapshots
        where status in ('active', 'trialing')
        group by date_trunc('month', snapshot_date)
        order by month desc
        limit 2
      )
      select
        case when lag(mrr) over (order by month) > 0
          then round(100.0 * (mrr - lag(mrr) over (order by month))
                     / lag(mrr) over (order by month), 1)
          else null
        end
      from monthly
      limit 1
    ),
    -- Total paying subscribers
    'paying_subscribers', (
      select count(*) from org_billing
      where subscription_status in ('active', 'trialing')
    ),
    -- Active trials (not yet converted)
    'free_trials', (
      select count(*) from organizations
      where plan = 'trial'
    ),
    -- Monthly churn rate
    'churn_rate_pct', (
      select monthly_churn_rate_pct from v_trial_conversion
    ),
    -- Trial → paid conversion rate
    'conversion_rate_pct', (
      select conversion_rate_pct from v_trial_conversion
    ),
    -- ARPA (average revenue per account) in INR
    'arpa_inr', (
      select round(avg(last_invoice_amount) / 100)
      from org_billing
      where subscription_status in ('active', 'trialing')
        and last_invoice_amount > 0
    ),
    -- Past due count (payment failures)
    'past_due_count', (
      select count(*) from org_billing
      where subscription_status = 'past_due'
    )
  ) into result;
  return result;
end;
$$;


-- ══════════════════════════════════════════════════════════════
-- FUNCTION: record_mrr_snapshot
-- Called daily by pg_cron to record MRR for charting over time
-- ══════════════════════════════════════════════════════════════
create or replace function record_mrr_snapshot()
returns void
language plpgsql
security definer
as $$
begin
  insert into mrr_snapshots (snapshot_date, org_id, plan, mrr_paise, status)
  select
    current_date,
    ob.org_id,
    o.plan,
    coalesce(ob.last_invoice_amount, 0),
    ob.subscription_status
  from org_billing ob
  join organizations o on o.id = ob.org_id
  on conflict (snapshot_date, org_id)
  do update set
    mrr_paise  = excluded.mrr_paise,
    plan       = excluded.plan,
    status     = excluded.status;
end;
$$;

-- ── Schedule daily MRR snapshot at 23:55 IST (18:25 UTC) ─────
-- Requires pg_cron extension (see notifications_and_cron.sql)
-- select cron.schedule(
--   'daily-mrr-snapshot',
--   '25 18 * * *',
--   $$ select record_mrr_snapshot(); $$
-- );
