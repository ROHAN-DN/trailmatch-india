-- TrialMatch India — Stripe Billing Schema Additions
-- Run AFTER base schema.sql in Supabase SQL Editor

-- ── Billing records per org ───────────────────────────────────
create table org_billing (
  id                      uuid primary key default uuid_generate_v4(),
  org_id                  uuid unique references organizations(id) on delete cascade,

  -- Stripe identifiers
  stripe_customer_id      text unique,
  stripe_subscription_id  text unique,
  stripe_price_id         text,

  -- Subscription state
  subscription_status     text default 'none'
    check (subscription_status in (
      'none','trialing','active','past_due',
      'canceled','unpaid','paused','incomplete'
    )),
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean default false,
  canceled_at             timestamptz,

  -- Invoice snapshot
  last_invoice_amount     int,          -- in paise
  last_invoice_date       timestamptz,
  last_invoice_url        text,

  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);

alter table org_billing enable row level security;

create policy "org_isolation_billing" on org_billing
  using (org_id = (select org_id from users where id = auth.uid()));

create trigger trg_org_billing_updated
  before update on org_billing
  for each row execute function update_updated_at();

-- ── Index for webhook lookups ─────────────────────────────────
create index idx_billing_stripe_customer    on org_billing(stripe_customer_id);
create index idx_billing_stripe_subscription on org_billing(stripe_subscription_id);

-- ── Update organizations plan limits on billing change ────────
-- This function is called by the webhook handler via the API,
-- but we also add a DB trigger as a safety net.

create or replace function sync_plan_limits()
returns trigger as $$
begin
  -- Update org plan + limits based on subscription status
  update organizations set
    plan = case
      when new.subscription_status in ('active','trialing') then
        case new.stripe_price_id
          when current_setting('app.stripe_price_pro',     true) then 'pro'
          when current_setting('app.stripe_price_starter', true) then 'starter'
          else 'trial'
        end
      else 'trial'
    end,
    max_patients = case
      when new.subscription_status in ('active','trialing') then
        case new.stripe_price_id
          when current_setting('app.stripe_price_pro', true) then -1
          else 100
        end
      else 10
    end,
    max_users = case
      when new.subscription_status in ('active','trialing') then
        case new.stripe_price_id
          when current_setting('app.stripe_price_pro', true) then -1
          else 5
        end
      else 2
    end
  where id = new.org_id;
  return new;
end;
$$ language plpgsql security definer;

create trigger trg_sync_plan_on_billing_change
  after insert or update on org_billing
  for each row execute function sync_plan_limits();
