-- TrialMatch India — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query

-- ── Enable extensions ────────────────────────────────────────
create extension if not exists "uuid-ossp";
-- pgcrypto is required below for gen_random_bytes() (magic-link tokens
-- etc.). It's commonly available on Supabase but not guaranteed
-- pre-enabled on every project — confirmed by actually running this
-- file against a real Postgres 16 instance without it, which failed
-- with "function gen_random_bytes(integer) does not exist". Declaring
-- it explicitly here removes the assumption entirely.
create extension if not exists pgcrypto;

-- ── Organizations (hospitals, CROs, pharma) ───────────────────
create table organizations (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,
  type          text check (type in ('hospital','cro','pharma','research_center','other')),
  city          text,
  state         text,
  logo_url      text,
  brand_color   text default '#0F6E56',
  plan          text default 'trial' check (plan in ('trial','starter','pro','enterprise')),
  max_users     int default 5,
  max_patients  int default 50,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ── Users ────────────────────────────────────────────────────
create table users (
  id            uuid primary key default uuid_generate_v4(),
  org_id        uuid references organizations(id) on delete cascade,
  email         text unique not null,
  name          text,
  role          text default 'member' check (role in ('owner','admin','member','viewer')),
  avatar_url    text,
  last_login    timestamptz,
  is_active     boolean default true,
  created_at    timestamptz default now()
);

-- ── Patients ──────────────────────────────────────────────────
create table patients (
  id                uuid primary key default uuid_generate_v4(),
  org_id            uuid references organizations(id) on delete cascade,
  created_by        uuid references users(id),
  patient_code      text not null,
  age               int,
  sex               text check (sex in ('Male','Female','Other')),
  location          text,
  diagnosis         text not null,
  stage             text,
  medications       text,
  labs              text,
  comorbidities     text,
  prior_treatments  text,
  biomarkers        text,
  allergies         text,
  ecog_status       text,
  notes             text,
  is_archived       boolean default false,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  unique(org_id, patient_code)
);

-- ── Match jobs ────────────────────────────────────────────────
create table match_jobs (
  id              uuid primary key default uuid_generate_v4(),
  org_id          uuid references organizations(id) on delete cascade,
  created_by      uuid references users(id),
  name            text,
  status          text default 'pending' check (status in ('pending','running','completed','failed','cancelled')),
  total_patients  int default 0,
  done_patients   int default 0,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz default now()
);

-- ── Match results ─────────────────────────────────────────────
create table match_results (
  id              uuid primary key default uuid_generate_v4(),
  job_id          uuid references match_jobs(id) on delete cascade,
  patient_id      uuid references patients(id) on delete cascade,
  org_id          uuid references organizations(id) on delete cascade,
  status          text default 'pending' check (status in ('pending','running','done','error')),
  trials_searched int,
  ctgov_count     int,
  ctri_count      int,
  summary         text,
  matches         jsonb,
  not_matched     jsonb,
  error_msg       text,
  report_url      text,
  email_sent_at   timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── Invitations ───────────────────────────────────────────────
create table invitations (
  id          uuid primary key default uuid_generate_v4(),
  org_id      uuid references organizations(id) on delete cascade,
  invited_by  uuid references users(id),
  email       text not null,
  role        text default 'member',
  token       text unique not null default encode(gen_random_bytes(32), 'hex'),
  accepted_at timestamptz,
  expires_at  timestamptz default (now() + interval '7 days'),
  created_at  timestamptz default now()
);

-- ── Audit log ─────────────────────────────────────────────────
create table audit_log (
  id         uuid primary key default uuid_generate_v4(),
  org_id     uuid references organizations(id) on delete cascade,
  user_id    uuid references users(id),
  action     text not null,
  entity     text,
  entity_id  uuid,
  metadata   jsonb,
  created_at timestamptz default now()
);

-- ── Row Level Security ────────────────────────────────────────
alter table organizations  enable row level security;
alter table users          enable row level security;
alter table patients       enable row level security;
alter table match_jobs     enable row level security;
alter table match_results  enable row level security;
alter table invitations    enable row level security;
alter table audit_log      enable row level security;

-- Users can only see their own org's data
create policy "org_isolation_users"      on users          using (org_id = (select org_id from users where id = auth.uid()));
create policy "org_isolation_patients"   on patients       using (org_id = (select org_id from users where id = auth.uid()));
create policy "org_isolation_jobs"       on match_jobs     using (org_id = (select org_id from users where id = auth.uid()));
create policy "org_isolation_results"    on match_results  using (org_id = (select org_id from users where id = auth.uid()));
create policy "org_isolation_invites"    on invitations    using (org_id = (select org_id from users where id = auth.uid()));
create policy "org_isolation_audit"      on audit_log      using (org_id = (select org_id from users where id = auth.uid()));
create policy "org_self_read"            on organizations   using (id    = (select org_id from users where id = auth.uid()));

-- ── Indexes ───────────────────────────────────────────────────
create index idx_patients_org       on patients(org_id);
create index idx_patients_diagnosis on patients(diagnosis);
create index idx_match_results_job  on match_results(job_id);
create index idx_match_results_org  on match_results(org_id);
create index idx_match_jobs_org     on match_jobs(org_id);
create index idx_users_org          on users(org_id);
create index idx_users_email        on users(email);

-- ── Updated_at trigger ────────────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger trg_patients_updated      before update on patients      for each row execute function update_updated_at();
create trigger trg_match_results_updated before update on match_results for each row execute function update_updated_at();


-- ── ABDM health data fetch sessions ──────────────────────────
-- Tracks in-progress and completed ABDM health record requests
create table if not exists abdm_sessions (
  id                uuid primary key default uuid_generate_v4(),
  org_id            uuid references organizations(id) on delete cascade,
  created_by        uuid references users(id),

  -- Patient identifiers
  abha_number       text,              -- 14-digit ABHA number
  abha_address      text,              -- name@abdm format

  -- ABDM API state
  transaction_id    text unique,       -- ABDM transaction ID
  request_id        text unique,       -- our consent request ID
  consent_artefact_id text,            -- consent artefact from ABDM
  access_token      text,             -- short-lived ABDM access token

  -- Session state machine
  status            text default 'initiated'
    check (status in (
      'initiated',       -- OTP sent
      'verified',        -- OTP confirmed, access token obtained
      'consent_requested', -- health info request sent to HIU
      'fetching',        -- ABDM is fetching records from HIP
      'received',        -- raw FHIR bundle received
      'parsed',          -- patient record created in DB
      'failed',          -- terminal error
      'expired'          -- token expired
    )),

  -- Result
  fhir_bundle       jsonb,             -- raw FHIR bundle from ABDM
  patient_id        uuid references patients(id),   -- created patient
  error_message     text,

  -- Timing
  expires_at        timestamptz default (now() + interval '10 minutes'),
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index idx_abdm_sessions_org         on abdm_sessions(org_id);
create index idx_abdm_sessions_transaction on abdm_sessions(transaction_id);
create index idx_abdm_sessions_request     on abdm_sessions(request_id);

alter table abdm_sessions enable row level security;
create policy "org_isolation_abdm" on abdm_sessions
  using (org_id = (select org_id from users where id = auth.uid()));

create trigger trg_abdm_sessions_updated
  before update on abdm_sessions
  for each row execute function update_updated_at();
