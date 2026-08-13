-- TrialMatch India — Sponsor Portal Foundation Migration 009
-- Run AFTER 008_prescreening.sql

-- ── 1. Extend organizations with type ─────────────────────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS org_type text DEFAULT 'hospital'
  CHECK (org_type IN (
    'hospital', 'academic', 'cro', 'pharma', 'biotech', 'research_center'
  ));

-- Convenience view: is this a sponsor-type org?
-- Coordinators: hospital, academic, cro (running trials)
-- Sponsors: pharma, biotech (funding trials)
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS is_sponsor boolean
  GENERATED ALWAYS AS (org_type IN ('pharma', 'biotech')) STORED;

CREATE INDEX IF NOT EXISTS idx_orgs_type ON organizations (org_type);

-- ── 2. Protocols table ─────────────────────────────────────────────────────
-- Sponsors upload trial protocols; Claude AI parses them into structured criteria
CREATE TABLE IF NOT EXISTS protocols (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id               uuid REFERENCES organizations(id) ON DELETE CASCADE,
  created_by           uuid REFERENCES users(id),

  title                text NOT NULL,
  phase                text CHECK (phase IN (
    'Phase I', 'Phase II', 'Phase III', 'Phase IV', 'Phase I/II', 'Phase II/III'
  )),
  therapeutic_area     text,

  -- AI-parsed structured criteria (array of FeasibilityCriterion objects)
  -- Same schema as lib/feasibility.ts FeasibilityCriterion
  inclusion_criteria   jsonb NOT NULL DEFAULT '[]',
  exclusion_criteria   jsonb NOT NULL DEFAULT '[]',

  -- Raw text the sponsor pasted or PDF-extracted
  raw_text             text,
  parsed_by_ai         boolean DEFAULT false,

  -- ICD-10 / SNOMED / LOINC codes identified by protocol parser agent
  mapped_codes         jsonb DEFAULT '{}',
  -- { icd10: ['E11.9'], snomed: ['44054006'], loinc: ['4548-4'] }

  status               text DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'archived')),

  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_protocols_org    ON protocols (org_id);
CREATE INDEX IF NOT EXISTS idx_protocols_status ON protocols (org_id, status);

ALTER TABLE protocols ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_isolation_protocols"
  ON protocols
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- ── 3. Site engagement requests ────────────────────────────────────────────
-- Tracks sponsor ↔ coordinator engagement workflow.
-- A sponsor finds a site via feasibility, clicks "Engage site",
-- coordinator gets WhatsApp + email alert, responds in dashboard.
CREATE TABLE IF NOT EXISTS site_engagement_requests (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  protocol_id          uuid REFERENCES protocols(id) ON DELETE CASCADE,
  sponsor_org_id       uuid REFERENCES organizations(id) ON DELETE CASCADE,

  -- Target site: one of these will be set
  site_org_id          uuid REFERENCES organizations(id),          -- TrialMatch partner site
  site_profile_id      uuid REFERENCES india_site_profiles(id),    -- non-partner site twin

  -- Status lifecycle
  status               text DEFAULT 'requested'
    CHECK (status IN (
      'requested',
      'coordinator_notified',
      'interested',
      'declined',
      'meeting_booked',
      'closed'
    )),

  -- Messages
  sponsor_message      text,           -- optional personalised message from sponsor
  coordinator_response text,           -- coordinator's reply

  -- Notification tracking
  notified_via         text DEFAULT 'whatsapp'
    CHECK (notified_via IN ('whatsapp', 'email', 'both')),
  notified_at          timestamptz,
  responded_at         timestamptz,

  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_engagement_sponsor  ON site_engagement_requests (sponsor_org_id);
CREATE INDEX IF NOT EXISTS idx_engagement_site     ON site_engagement_requests (site_org_id);
CREATE INDEX IF NOT EXISTS idx_engagement_protocol ON site_engagement_requests (protocol_id);
CREATE INDEX IF NOT EXISTS idx_engagement_status   ON site_engagement_requests (status);

ALTER TABLE site_engagement_requests ENABLE ROW LEVEL SECURITY;

-- Sponsor sees requests they created
CREATE POLICY "sponsor_sees_own_requests"
  ON site_engagement_requests FOR SELECT
  USING (sponsor_org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- Coordinator sees requests targeting their org
CREATE POLICY "coordinator_sees_incoming_requests"
  ON site_engagement_requests FOR SELECT
  USING (site_org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- Sponsor can insert (initiate engagement)
CREATE POLICY "sponsor_can_initiate"
  ON site_engagement_requests FOR INSERT
  WITH CHECK (sponsor_org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- Coordinator can update status + add response
CREATE POLICY "coordinator_can_respond"
  ON site_engagement_requests FOR UPDATE
  USING (site_org_id = (SELECT org_id FROM users WHERE id = auth.uid()))
  WITH CHECK (site_org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- Sponsor can update (e.g. close or book meeting)
CREATE POLICY "sponsor_can_update_own"
  ON site_engagement_requests FOR UPDATE
  USING (sponsor_org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- ── 4. Feasibility rate limiting ───────────────────────────────────────────
-- Tracks sponsor feasibility runs for daily quota enforcement (5/day)
CREATE TABLE IF NOT EXISTS sponsor_feasibility_runs (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       uuid REFERENCES organizations(id) ON DELETE CASCADE,
  protocol_id  uuid REFERENCES protocols(id),
  ran_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sfr_org_date
  ON sponsor_feasibility_runs (org_id, ran_at);

ALTER TABLE sponsor_feasibility_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation_sfr" ON sponsor_feasibility_runs
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

-- ── Verify all tables exist ────────────────────────────────────────────────
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'india_site_profiles', 'prescreening_checklists',
    'protocols', 'site_engagement_requests', 'sponsor_feasibility_runs'
  )
ORDER BY table_name;
-- Expected: 5 rows
