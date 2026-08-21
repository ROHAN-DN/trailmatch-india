# TrialMatch India — Hosted App

AI-powered clinical trial matching platform for India.
Matches patients to ClinicalTrials.gov + CTRI trials using Claude AI.

---

## What's included

> This table covers the full feature set as of **v17**. The sections further
> down ("Stripe Billing (v3 addition)", "ABDM Live API Connector (v6
> addition)", etc.) were written incrementally as each version shipped and
> are kept as-is for historical detail — see **"v10 → v17 — what's new since
> the last full changelog update"** below for what was built after v9,
> which those older sections don't cover.

| Feature | Status |
|---|---|
| User login (email magic link + Google) | ✅ |
| TOTP-based MFA for Owner/Admin roles | ✅ |
| Multi-org / team isolation (row-level security) | ✅ |
| Persistent patient records + structured clinical data | ✅ |
| Single + batch trial matching (bounded concurrency) | ✅ |
| ClinicalTrials.gov live data | ✅ |
| CTRI India — search-scrape + bulk-export fallback attempt | ⚠️ see note below |
| Rule-based (zero-LLM) criteria extraction, Claude only for residual text | ✅ |
| Trial-criteria caching (skips re-extraction for previously-seen protocol text) | ✅ |
| RxNorm medication normalization | ✅ |
| PDF report generation | ✅ |
| Email report delivery | ✅ |
| WhatsApp prescreening + notifications (Gupshup) | ✅ |
| Scheduled weekly re-matching | ✅ |
| ABDM / ABHA integration — real Fidelius (ECDH) crypto | ⚠️ see note below |
| FHIR/EHR bulk patient import | ✅ |
| Team invitations + roles | ✅ |
| Custom branding (name + colour) | ✅ |
| Stripe billing + revenue analytics dashboard | ✅ |
| Postgres-backed rate limiting (fails open, not in-memory) | ✅ |
| Match accuracy tracking (screen-fail → criterion correlation) | ✅ |
| Audit log | ✅ |

**⚠️ Two items are implemented but unverified against the real external
service**, and should not be treated as "done" until tested against it
directly:
- **CTRI bulk export** (`lib/ctri-bulk-export.ts`) — the live CTRI search
  form is CAPTCHA-gated, so this project falls back to a bulk-export
  endpoint that has never actually been reached from any sandbox this
  project has been built in (`ctri.nic.in` isn't network-reachable here).
  The code is defensive about this (structural validation before trusting
  the response, clean fallback to the old behavior if it fails), but
  nobody has confirmed it works.
- **ABDM Fidelius encryption** (`lib/fidelius.ts`) — the curve math is
  verified against the primary source (BouncyCastle's `Curve25519.java`)
  and unit-tested, but has never interoperated with ABDM's real sandbox
  or production gateway.

Both are real, honest gaps to close with actual network access before
depending on either in production — not bugs in what's written, but
untested assumptions about what's on the other end.

---

## Deploy in 30 minutes

### Step 1 — Clone and install

```bash
git clone <your-repo-url>
cd trialmatch
npm install
```

`.npmrc` (checked into this repo) sets `legacy-peer-deps=true`, so plain
`npm install` works with no extra flags. This exists because `next-auth`
declares a peer range for `nodemailer` narrower than the security-patched
version this project actually depends on — see the comment in `.npmrc`
for the full reasoning.

### Step 2 — Create a Supabase project (free)

1. Go to https://supabase.com and create a free account
2. Click **New project** → choose a name and region (choose Mumbai ap-south-1 for India)
3. Go to **SQL Editor** → **New query**
4. Paste the entire contents of `supabase/schema.sql` and click **Run**
5. Go to **Storage** → **New bucket** → name it `reports`, set to **Public**
6. Go to **Settings → API** and copy:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - anon public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - service_role secret key → `SUPABASE_SERVICE_ROLE_KEY`

### Step 3 — Get your API keys

**AI provider — the matching engine itself**

This app is **not locked to any single AI provider.** Every organization
using this deployment can configure its own provider (own API key, own
model) via Settings → AI provider — different orgs sharing one
deployment can each use a different vendor, encrypted at rest, same
pattern as MFA secrets. An org that configures nothing falls back to
the platform-wide default below, so the simplest path (one Anthropic
key for the whole deployment) still works exactly as before. A **Test
connection** button in that settings card verifies a key actually works
before saving it — makes one real, minimal call to the configured
provider and reports success or a plain-language reason for failure, so
a mistyped key is caught immediately instead of days later when the
first real match fails.

1. Go to https://console.anthropic.com
2. API Keys → Create Key
3. Copy → `ANTHROPIC_API_KEY`

Supported natively: Anthropic, OpenAI, Google Gemini. Anything else —
Groq, OpenRouter, Together, Azure OpenAI, a self-hosted model — works
via the generic `openai_compatible` option, since most providers
implement an OpenAI-compatible endpoint. See `lib/llm-provider.ts`'s
header comment for exactly how provider resolution works and what env
vars control the platform-wide default (`LLM_PLATFORM_PROVIDER`,
`LLM_PLATFORM_API_KEY`, `LLM_PLATFORM_MODEL`, `LLM_PLATFORM_BASE_URL` —
all optional; unset means "use Anthropic via `ANTHROPIC_API_KEY`",
exactly the original behavior).

**`LLM_CREDENTIAL_ENCRYPTION_KEY`** — required if any org configures
its own provider (not required for the simple, single-platform-key
setup). Generate the same way as `MFA_ENCRYPTION_KEY`, but as its own,
separate key — never reuse the MFA key here; a compromised AI provider
key and a compromised MFA secret should never share a blast radius:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Coverage — every real Claude call site in this app, not just the
matching engine.** The first multi-provider pass only covered
`lib/matcher.ts` and missed three other independent, hardcoded
`new Anthropic()` clients — protocol parsing, prescreening checklists,
and PDF protocol upload. All four now go through the same
provider-agnostic path. PDF upload specifically used to send the file
directly to Claude as a native "document" block — Anthropic-specific,
with no clean equivalent across OpenAI/Google/openai_compatible. Fixed
by extracting text from the PDF first (`lib/pdf-text-extract.ts`, using
`pdfjs-dist` — deliberately not the newer `pdf-parse@2.x`, which bundles
a native canvas binary as a hard dependency, a real risk for Vercel's
serverless functions), then feeding that text through the same
provider-agnostic `parseProtocol()` pipeline pasted-text protocols
already use. Real, stated trade-off: Claude's native PDF reading can use
visual/layout understanding (tables, multi-column text) that plain text
extraction loses — for a typical prose-heavy protocol this is unlikely
to matter, for one that's primarily a complex table it may not extract
as well as Claude reading the PDF directly would have.

**Resend (email)**
1. Go to https://resend.com → free account
2. API Keys → Create API Key
3. Copy → `RESEND_API_KEY`
4. Add your sending domain (or use their sandbox for testing)
5. Set `RESEND_FROM_EMAIL=reports@yourdomain.com`

**Google OAuth (optional — for Google Sign-In)**
1. Go to https://console.cloud.google.com
2. Create a project → APIs & Services → Credentials
3. Create OAuth 2.0 Client ID (Web application)
4. Add `http://localhost:3000` to authorised origins
5. Add `http://localhost:3000/api/auth/callback/google` to redirect URIs
6. Copy Client ID → `GOOGLE_CLIENT_ID`
7. Copy Client Secret → `GOOGLE_CLIENT_SECRET`

### Step 4 — Configure environment

```bash
cp .env.local.example .env.local
```

Open `.env.local` and fill in all the values from Step 2 and 3.

Generate a NextAuth secret:
```bash
openssl rand -base64 32
```
Paste the result into `NEXTAUTH_SECRET`.

### Step 5 — Run locally

```bash
npm run dev
```

Open http://localhost:3000 — you'll be redirected to sign in.

---

## Deploy to Vercel (production)

### Option A — Via Vercel CLI (fastest)

```bash
npm install -g vercel
vercel login
vercel --prod
```

Vercel will ask you to link the project. When prompted for environment variables, paste each value from your `.env.local`.

### Option B — Via GitHub

1. Push this folder to a GitHub repository
2. Go to https://vercel.com → **New Project** → Import your repo
3. Click **Environment Variables** and add all variables from `.env.local`
4. Click **Deploy**

After deploy:
- Update `NEXTAUTH_URL` to your production URL (e.g. `https://trialmatch.vercel.app`)
- Update Google OAuth redirect URIs to include your production URL
- Vercel auto-deploys on every `git push`
- **Set `CRON_SECRET` as a project environment variable.** `vercel.json` already
  registers all 5 scheduled jobs (`rematch`, `mrr-snapshot`, `data-retention`,
  `site-twin-refresh`, `enrollment-monitor`) as native Vercel Cron Jobs — no
  extra setup needed for them to run. **Real bug fixed in this build:** every
  cron route used to check only for a custom `x-cron-secret` header and (on 3
  of the 5) require `POST`, but Vercel's native cron always sends `GET` with
  the secret as `Authorization: Bearer <CRON_SECRET>` — so none of the 5 could
  ever have actually run once deployed. `lib/cron-auth.ts` now accepts both
  Vercel's real invocation and the original `x-cron-secret`/`POST` shape (for
  manual testing or if you set these up via Supabase pg_cron instead). One of
  the five, `data-retention`, is the DPDP Act storage-minimisation job — worth
  confirming it actually fires once, via Vercel's dashboard → your project →
  Cron Jobs → the "Run" button, rather than trusting the schedule blindly.
- **`enrollment-monitor` runs once daily** (`30 0 * * *`, 00:30 UTC / 06:00
  IST), not every 6 hours — confirmed against a real Hobby-plan deploy: Vercel
  rejects the whole deployment outright if any cron entry is more frequent
  than daily on that plan. If you're on Pro, or move this specific job to
  Supabase pg_cron instead (see the comment at the top of
  `pages/api/cron/enrollment-monitor.ts`), `"0 */6 * * *"` gets you back to
  6-hourly monitoring.

---

## Supabase Storage — enable public reports

After creating the `reports` bucket:

1. Go to **Storage → reports → Policies**
2. Add policy: **SELECT** for `public` (so PDF URLs work)
3. Add policy: **INSERT** for `authenticated` (so the server can upload)

---

## Project structure

```
trialmatch/
├── pages/
│   ├── index.tsx              # Root redirect
│   ├── _app.tsx               # SessionProvider wrapper
│   ├── auth/
│   │   └── signin.tsx         # Sign-in page
│   ├── dashboard/
│   │   └── index.tsx          # Main dashboard
│   └── api/
│       ├── auth/[...nextauth].ts  # Auth endpoints
│       ├── patients/index.ts  # Patient CRUD
│       ├── match/
│       │   ├── index.ts       # Trigger matching
│       │   ├── [id].ts        # Job status polling
│       │   └── jobs.ts        # Job list
│       ├── team/index.ts      # Team management
│       └── org/index.ts       # Org settings
├── components/
│   ├── PatientModal.tsx       # Add/edit patient modal
│   ├── BatchPanel.tsx         # Job history + progress
│   └── (TeamPanel + SettingsPanel inside PatientModal.tsx)
├── lib/
│   ├── supabase.ts            # DB client
│   ├── matcher.ts             # Core AI matching engine
│   ├── pdf.ts                 # PDF report generation
│   └── email.ts               # Email delivery
├── supabase/
│   └── schema.sql             # Full DB schema + RLS
├── .env.local.example         # All env vars documented
└── README.md
```

---

## User roles

| Role | Can do |
|---|---|
| **Owner** | Everything — billing, delete org, all settings |
| **Admin** | Invite/remove members, all patient/match operations, settings |
| **Member** | Add patients, run matches, view results |
| **Viewer** | View patients and results only, no edits |

---

## Pricing estimate (production)

| Service | Free tier | When you'll hit limits |
|---|---|---|
| Vercel | 100GB bandwidth, unlimited deploys | 1M+ requests/month |
| Supabase | 500MB DB, 1GB storage, 50,000 MAU | ~500 patients + reports |
| Anthropic | Pay-per-use | ~₹2–5 per patient match |
| Resend | 100 emails/day | Very early |

**Total cost for a 50-patient pilot: ~₹0–₹500/month**

---

## What to build next

Everything below was open when this list was first written (v2-era). Most
of it has since been built — kept here with accurate status rather than
deleted, so the history is honest:

- [x] WhatsApp notifications via Gupshup — `lib/whatsapp.ts`, `pages/api/prescreening/whatsapp.ts`
- [x] EHR/FHIR patient import — `lib/fhir.ts`, `pages/api/patients/fhir.ts` (see "FHIR / EHR Patient Import (v4 addition)" below)
- [x] Scheduled re-matching — `pages/api/cron/rematch.ts` + `lib/rematch.ts`, weekly, cache-aware
- [x] Analytics dashboard — `components/AnalyticsPanel.tsx` (see "Analytics Dashboard (v4 addition)" below)
- [ ] White-label custom domain per org — **still not built**, confirmed absent from the codebase as of v17
- [x] Stripe billing integration — `lib/stripe.ts` + full billing/analytics stack (see "Stripe Billing" sections below)

Genuinely still open, as of v17:
- [ ] White-label custom domain per org (above)
- [ ] Real-world verification of the CTRI bulk-export endpoint and ABDM Fidelius crypto against their live services — both are implemented and unit-tested but have never touched the real external system (see the ⚠️ note in "What's included")
- [x] Next.js 14 → 16 migration — **done.** See `NEXTJS_MIGRATION_PLAN.md` (the scoping doc) and `NEXTJS_MIGRATION_COMPLETE.md` (what actually happened, including two real dependency conflicts found and fixed along the way). Next.js 16.3.0, React 19.2.8, `middleware.ts` → `proxy.ts`. Re-verified: 267/267 tests, clean build, security-audit 9/9, plus a real four-scenario test of `proxy.ts`'s MFA enforcement against actual next-auth tokens.
- [ ] Real SMTP delivery has not been tested end-to-end (no live credentials available during development)
- [ ] `npm run lint` was completely unconfigured before the Next.js 16 migration (`next lint`, now removed, had no explicit config to run against). It works now — and surfaces 643 pre-existing findings (591 errors, 52 warnings; the large majority are `no-explicit-any`). None of this is new from the migration; it was simply never visible before. Worth a dedicated cleanup pass — not attempted here, out of scope for "does the app run."

## v10 → v17 — what's new since the last full changelog update

The versioned sections below (Stripe Billing, Analytics Dashboard, FHIR
Import, ABDM Connector, Phase 1, v9 pressure-test) were written through
v9 and are accurate for what existed at that point. Substantial work has
landed since then that was never folded back into this file. Summary,
each item verified directly against the current code rather than copied
from a prior session's notes:

- **Rule-based extraction rewrite** (`lib/rule-based-extraction.ts`) —
  deterministic regex/dictionary extraction now runs first on every
  trial's eligibility text; Claude only sees the residual text it can't
  classify, and only for criteria extraction (see next point) — never
  patient data.
- **Two-call, privacy-separated Claude design** — trial-criteria
  extraction (`extractResidualCriteriaViaClaude`) has no `Patient`
  parameter in its function signature at all; patient scoring is a
  separate call against already-finalized criteria.
- **Fabricated-trial fallback removed** — when no live trials are found,
  the app returns an honest empty result instead of asking Claude to
  invent plausible-looking trials.
- **Trial-criteria cache** (`lib/trial-criteria-cache.ts`, migration 018)
  — skips re-extraction entirely for eligibility text already seen,
  keyed by source + trial ID + a content hash so a changed protocol is
  never served stale criteria.
- **RxNorm medication enrichment** wired into the matching pipeline.
- **MFA** for Owner/Admin roles — TOTP, encrypted secret storage,
  `middleware.ts` as a universal enforcement backstop.
- **Postgres-backed rate limiting** (migration 019) replacing the
  in-memory limiter documented as a known Phase 1 gap in the v9 notes
  below — fails open by design (an outage never blocks a real match).
- **Bounded-concurrency batch matching** — was a strictly sequential
  loop; now processes patients concurrently within a bound.
- **Real ABDM Fidelius (ECDH) crypto** replacing the placeholder
  base64-as-a-"key" implementation referenced in the v6 ABDM section
  below.
- **CTRI bulk-export fallback** for when the live CAPTCHA-gated search
  form can't be used (see the ⚠️ note in "What's included" — untested
  against the real endpoint).
- **Match accuracy tracking, actually wired correctly** — the
  `match_accuracy_events` trigger from migration 012 was reading a JSON
  field nothing in the app ever wrote to; migration 022 fixes it to read
  the field that's actually populated on every real match.
- **Dependency security triage** — 23 → 13 vulnerable packages, each
  decision (fixed vs. deliberately deferred) documented with reasoning
  in `FIXES_2026-08-05.md`, not just a blanket `npm audit fix`.

---

## Support

Built with:
- [Next.js 16](https://nextjs.org)
- [Supabase](https://supabase.com)
- [NextAuth.js](https://next-auth.js.org)
- [Anthropic Claude](https://anthropic.com)
- [Resend](https://resend.com)
- [jsPDF](https://github.com/parallax/jsPDF)

---

## Stripe Billing (v3 addition)

### New files

| File | Purpose |
|---|---|
| `lib/plans.ts` | Plan definitions — limits, prices, feature flags |
| `lib/stripe.ts` | Stripe client + checkout/portal session helpers |
| `lib/gate.ts` | Plan enforcement — `checkGate()` + `checkLimit()` |
| `pages/api/billing/checkout.ts` | Creates Stripe Checkout session |
| `pages/api/billing/portal.ts` | Opens Stripe Customer Portal |
| `pages/api/billing/webhook.ts` | Handles all Stripe subscription events |
| `pages/api/billing/index.ts` | Current plan + usage + invoice history |
| `components/BillingPanel.tsx` | Full billing UI — pricing cards, invoices |
| `supabase/billing.sql` | `org_billing` table + plan-sync trigger |
| `supabase/stripe_setup.md` | Step-by-step Stripe setup guide |

### Plans

| Plan | Price | Patients | Users | WhatsApp | Re-match |
|---|---|---|---|---|---|
| Free Trial | ₹0 | 10 | 2 | ✗ | ✗ |
| Starter | ₹7,999/mo | 100 | 5 | ✗ | ✗ |
| Pro | ₹19,999/mo | ∞ | ∞ | ✅ | ✅ |
| Enterprise | Custom | ∞ | ∞ | ✅ | ✅ |

### Stripe setup (15 minutes)

See `supabase/stripe_setup.md` for the full step-by-step guide.

Quick version:
1. Create Stripe account → complete India KYC
2. Create two products (Starter ₹7,999 + Pro ₹19,999), copy Price IDs
3. Register webhook → copy signing secret
4. Add 6 Stripe env vars to `.env.local`
5. Run `supabase/billing.sql`
6. Test locally with `stripe listen --forward-to localhost:3000/api/billing/webhook`

---

## Analytics Dashboard (v4 addition)

### New files

| File | Purpose |
|---|---|
| `supabase/analytics.sql` | 5 SQL views + 1 RPC for pre-computed analytics |
| `pages/api/analytics/index.ts` | Single API route returning all chart data |
| `components/AnalyticsPanel.tsx` | Full dashboard — KPI cards, charts, funnel, table |

### Charts included

- **KPI cards** — total patients, strong matches, avg match score, jobs this month, top condition
- **Recruitment funnel** — patients → matched → strong match → partial only → no match, with conversion rates at each step
- **Match rate by condition** — stacked bar per diagnosis, strong vs partial, avg score badge
- **Jobs over time** — SVG line + bar chart, 4/8/12 week range selector
- **Top matched trials** — table of most frequently matched NCT IDs with score bars
- **Patient demographics** — age group and sex breakdowns

### Setup

Run `supabase/analytics.sql` in your Supabase SQL Editor. The views query `match_results.matches` (JSONB array) directly — no schema changes needed.

---

## FHIR / EHR Patient Import (v4 addition)

### New files

| File | Purpose |
|---|---|
| `lib/fhir.ts` | FHIR R4 parser — maps resources to TrialMatch Patient schema |
| `lib/abdm.ts` | ABDM adapter — normalises Ayushman Bharat bundles |
| `pages/api/patients/fhir.ts` | Import API endpoint — parse, validate, insert |
| `components/FHIRImportPanel.tsx` | Drag-drop UI with live preview and field mapping |
| `public/fhir-samples/sample-bundle-3-patients.json` | Test bundle (3 patients) |

### Supported EHR systems

- Epic MyChart (Health Records export → FHIR R4)
- Cerner PowerChart (Patient Summary)
- ABDM / Ayushman Bharat Digital Mission FHIR API
- Meditech (FHIR R4 export)
- Practo / Qure.ai JSON export
- Any standard FHIR R4 Bundle

### FHIR resources parsed

| Resource | Maps to |
|---|---|
| `Patient` | age, sex, location, patient_code |
| `Condition` | diagnosis (primary), comorbidities, stage |
| `MedicationRequest` | medications |
| `Observation` | labs (LOINC codes), biomarkers |
| `AllergyIntolerance` | allergies |
| `Procedure` | prior_treatments |

### Testing

Use `public/fhir-samples/sample-bundle-3-patients.json` to test the import — 3 Indian patients across Bengaluru, Mumbai, Chennai with varied conditions.

### ABDM integration

For live ABDM integration, use the ABDM Sandbox: https://sandbox.abdm.gov.in
The ABDM adapter automatically detects and normalises ABDM bundles (Composition-based records, ABHA identifiers, SNOMED codes).

---

## Stripe Billing Analytics (v5 addition)

### New files

| File | Purpose |
|---|---|
| `supabase/billing_analytics.sql` | 6 SQL views + 2 RPCs + mrr_snapshots table |
| `pages/api/analytics/billing.ts` | Analytics API — merges Supabase views + live Stripe data |
| `pages/api/cron/mrr-snapshot.ts` | Daily cron to record MRR snapshots for charting |
| `components/BillingAnalyticsPanel.tsx` | Full revenue dashboard — charts, funnel, tables |

### Dashboard sections

| Section | What it shows |
|---|---|
| **KPI cards** | Total MRR, MoM growth %, paying subscribers, free trials, ARPA, churn rate, conversion rate |
| **MRR over time** | 90-day SVG area chart with daily snapshots, colour-coded MoM growth badge |
| **Plan distribution** | Horizontal bars per plan, paying vs total orgs, free-to-paid ratio |
| **Trial → paid funnel** | 4-stage conversion funnel with step-level conversion rates |
| **Subscription health** | Status breakdown grid (active/trialing/past_due/canceled) + MRR split bar |
| **MRR by plan table** | Subscribers, MRR, ARPA, % of total per plan with score bars |
| **Upcoming renewals** | Next 7 days, amount, days-until badge (amber if ≤2 days) |
| **Churn table** | Cancelled/at-risk orgs, last MRR, estimated LTV, months as customer |
| **Stripe event feed** | Real-time subscription lifecycle events from Stripe API |
| **Recent charges** | Last 8 successful charges with receipt links |

### Setup (3 steps)

1. Run `supabase/billing_analytics.sql` in Supabase SQL Editor
2. Add daily MRR snapshot cron (pg_cron or cron-job.org):
   ```
   URL:    https://YOUR_URL/api/cron/mrr-snapshot
   Method: POST
   Header: x-cron-secret: YOUR_CRON_SECRET
   Schedule: Daily at 23:55 IST (18:25 UTC) — cron: 25 18 * * *
   ```
3. The **Revenue** tab appears in the dashboard for admin/owner roles

### How MRR is calculated

MRR is sourced from `org_billing.last_invoice_amount` (set by the Stripe webhook on every `invoice.payment_succeeded` event) and snapshotted daily into `mrr_snapshots`. The MoM growth rate compares the current month's total to the previous month using the snapshot history. On new installs with no snapshot history, the current live value is shown without a growth rate.

---

## Stripe Billing Analytics (v5 addition)

### New files

| File | Purpose |
|---|---|
| `supabase/billing_analytics.sql` | 6 SQL views + 2 RPCs + `mrr_snapshots` table |
| `pages/api/analytics/billing.ts` | Unified analytics API — Supabase views + live Stripe data |
| `components/BillingAnalyticsPanel.tsx` | Full revenue dashboard — all charts, tables, feeds |
| `pages/api/cron/mrr-snapshot.ts` | Daily cron endpoint for MRR history |

### Setup

1. Run `supabase/billing_analytics.sql` in Supabase SQL Editor
2. Add daily MRR snapshot cron (see SQL file for pg_cron command)
3. Navigate to the new **Revenue** tab in the dashboard

### Metrics included

| Metric | Source |
|---|---|
| Total MRR | Supabase `org_billing.last_invoice_amount` |
| MoM MRR growth | `mrr_snapshots` 30-day comparison |
| Paying subscribers | `org_billing` status counts |
| ARPA | Average of active invoice amounts |
| Trial → paid conversion | `v_trial_conversion` view |
| Monthly churn rate | 30-day rolling cancellations |
| Plan distribution | `v_plan_distribution` with paying breakdown |
| MRR over time | 90-day `v_mrr_over_time` sparkline |
| Subscription health | `v_subscription_status_counts` |
| Churn events + LTV | `v_churn_events` with months-as-customer |
| Upcoming renewals | Live Stripe subscriptions API |
| Recent charges | Live Stripe charges API |
| Stripe event feed | Live Stripe events API |

---

## ABDM Live API Connector (v6 addition)

### New files

| File | Purpose |
|---|---|
| `lib/abdm-client.ts` | ABDM gateway auth, ABHA verify, OTP flow, health record request, decryption |
| `pages/api/abdm/initiate.ts` | Step 1 — verify ABHA, send OTP, create session |
| `pages/api/abdm/verify.ts` | Step 2 — confirm OTP, request health records or return sandbox result |
| `pages/api/abdm/callback.ts` | Receives async FHIR bundle from ABDM gateway |
| `pages/api/abdm/status.ts` | Session polling endpoint for live async flow |
| `components/ABDMConnector.tsx` | Full UI — ABHA input, OTP, progress, patient preview |
| `supabase/abdm_setup.md` | Step-by-step ABDM registration + setup guide |

### How to test immediately (no registration needed)

1. Add sandbox env vars to `.env.local` (see `supabase/abdm_setup.md`)
2. Click **"Fetch from ABDM"** in the patient toolbar
3. Use sandbox ABHA `12-3456-7890-1234` + OTP `123456`
4. Patient record is created automatically from the fetched FHIR bundle

### For production

See `supabase/abdm_setup.md` for the full HIU registration process (2–4 weeks with NHA).

### Technical flow

```
1. POST /api/abdm/initiate  → verify ABHA with NHA, send OTP, create abdm_sessions row
2. POST /api/abdm/verify    → confirm OTP with ABDM, trigger health info consent request
3. ABDM POSTs FHIR bundle   → /api/abdm/callback decrypts + parses + creates patient
4. GET  /api/abdm/status    → client polls until status = 'parsed'
```

Sandbox mode bypasses steps 2–4 and returns a realistic mock FHIR bundle immediately.

---

## Phase 1 — Complete (v8)

### Migration run order (Supabase SQL Editor)

**The fastest, most reliable way to do this is the single consolidated
file:** `supabase/00_full_deploy.sql`. It's the exact concatenation of
everything below, in this order, and — unlike the list below — it has
actually been executed successfully, start to finish, against a real
Postgres 16 database as part of preparing this build, not just assembled
by hand. Paste it into the Supabase SQL Editor once, on a fresh project,
and run it.

If you'd rather run the files individually (e.g. to review each one),
this is the exact sequence — each numbered migration also states its own
"Run AFTER" dependency as a comment at the top of the file, consistent
with this order:

1. `supabase/schema.sql`
2. `supabase/billing.sql`
3. `supabase/analytics.sql`
4. `supabase/notifications_and_cron.sql` (CREATE TABLE statements only — skip cron.schedule at bottom, see the scheduling note below)
5. `supabase/billing_analytics.sql`
6. `supabase/migrations/001_compliance.sql` through `010_enrollment_monitor.sql`, in numeric order
7. `supabase/migrations/011_audit_log.sql` — **this one used to hard-crash on a fresh deploy.** It defines a richer `audit_log` schema than `schema.sql` already created, and (until this build) then queried two of those new columns in the very same script — a real error that aborted everything after it, silently skipping RLS, both intended policies, both tamper-prevention rules, and the entire `consent_records` table (the DPDP Act §6 consent-tracking table), every single time, for every deploy. Confirmed by actually running it, not inferred. Fixed in this build — 011 now completes cleanly on a fresh database.
8. `supabase/migrations/012_match_accuracy.sql` through `024_failure_prediction.sql`, in numeric order
9. `supabase/migrations/025_audit_log_rls_fix.sql` — **new in this build.** `schema.sql` separately creates a broad `org_isolation_audit` policy on `audit_log` granting every org member full SELECT/INSERT/UPDATE/DELETE. Since Postgres RLS policies OR together, that policy was never actually superseded by 011's much narrower, intentional design (admins/owners read-only, service-role insert-only, nobody can update/delete) — it just sat alongside it, quietly granting every org member read access to the full audit log and the ability to insert fabricated entries, undermining the "tamper-proof, immutable" property the table's own header comment promises. This migration removes that one policy from `audit_log` specifically (nowhere else — it's the correct model on other tables) and, as a safety net, idempotently re-applies everything 011 should have created for anyone who deployed before this fix.
10. `supabase/migrations/026_rematch_runs_rls_fix.sql` — `rematch_runs` had RLS enabled (migration 014) but zero policies were ever added — default-deny, harmless in practice since nothing reads/writes this table yet, but it would have silently blocked any future legitimate use. Adds the missing service-role-only policy, matching the pattern already used by `mrr_snapshots`.
11. `supabase/migrations/027_llm_provider_settings.sql` — adds per-organization AI provider configuration (`llm_provider`, encrypted `llm_api_key_encrypted`, `llm_model`, `llm_base_url`). See "AI provider" further up for what this enables.
12. `supabase/migrations/028_organizations_rls_fix.sql` — `organizations` had exactly one RLS policy with no `FOR` clause (defaults to `FOR ALL`), confirmed live on the actual database — meaning any org member, not just admin/owner, could `UPDATE` the row directly if RLS were ever the live boundary, now more consequential since migration 027 put an encrypted credential in that row. Splits it into `SELECT` (any member) and `UPDATE` (admin/owner only, matching what `pages/api/org`'s PATCH handler already enforces server-side).

Migrations 011 and 012 are also individually patched in place by 016 and
022 — run everything in order and each fix migration corrects the
earlier table/trigger correctly. 016 and 021 remain necessary even with
011 fixed, in case you're applying this to a database that already ran
the old 011 before this build existed.

### Seed the PI directory (Week 2, one-time)

```bash
npm install
NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  npm run seed:pi
```

Expect 10,000–20,000 contacts. Takes 10–20 minutes.

### Run security audit before every deploy

```bash
npm run security-audit
```

Checks: hardcoded keys, service role exposure, missing API auth, missing rate
limits, ABDM callback validation, .gitignore coverage, compliance schema presence.

### What's in Phase 1

| Feature | Status |
|---|---|
| Consent checkbox (client + server enforced) | ✅ |
| De-identification warnings | ✅ |
| Decision-support disclaimer (every page) | ✅ |
| Rate limiting (match, patients, ABDM OTP) | ✅ |
| ABDM callback UUID validation | ✅ |
| Data retention cron + configurable period | ✅ |
| PI contact directory (search + outreach log) | ✅ |
| Enrollment status tracker (10 states, audit-logged) | ✅ |
| Enrollment conversion analytics | ✅ |
| Site feasibility module (Pro plan gated) | ✅ |
| Protocol optimisation (tweak mode, live delta) | ✅ |

### New API routes

| Route | Purpose |
|---|---|
| `GET/POST /api/pi-contacts` | PI directory search + outreach logging |
| `GET/PATCH /api/match/[id]` | Job polling + enrollment status updates |
| `POST /api/feasibility` | Site feasibility query (Pro plan) |
| `POST /api/cron/data-retention` | Monthly patient archival |

### New dashboard tabs

PI Directory · Feasibility (Pro-gated)

---

## v9 — Pressure-test fixes

A full pressure-test pass before pilot deployment found and fixed 8 real issues:

### Build-breaking
- **Fixed:** `TeamPanel` and `SettingsPanel` were named exports buried inside `PatientModal.tsx`, but the dashboard imported them as default exports from nonexistent files. `npm run build` would have failed outright. Extracted both into their own files (`components/TeamPanel.tsx`, `components/SettingsPanel.tsx`).

### Compliance gaps
- **Fixed:** Consent enforcement only covered the single-patient form. CSV batch import, FHIR bulk import, and both ABDM flows created patient records without recording consent. All 4 patient-creation paths now enforce or record consent explicitly.

### Reliability
- **Fixed:** `max_tokens: 1500` on the Claude matching call was too low for the expected JSON output, causing intermittent truncated/unparseable responses. Raised to 4000, added explicit JSON-parse error handling and shape validation so failures are clear instead of silent.

### Clinical data integrity (most serious finding)
- **Fixed:** FHIR multi-patient bundle parsing had a correlation bug — if any patient lacked a FHIR `id`, that patient's record absorbed conditions/medications/labs from **every other patient** in the bundle. Verified the bug with a reproduction script, fixed the correlation logic to exclude ambiguous resources rather than guess, and re-verified the fix.
- **Fixed:** Related `Date.now()` collision in patient-code generation for ID-less patients in synchronous loops, which could cause duplicate codes and silent record overwrites.

### AI safety
- **Fixed:** The matching prompt had no rule preventing a `STRONG` match score when key lab values were missing from the patient record. Added an explicit instruction requiring `PARTIAL` (never `STRONG`) when criteria can't be verified due to missing data.

### Architecture / serverless correctness
- **Fixed:** 4 API routes (`match/index.ts`, `abdm/callback.ts`, `cron/rematch.ts`, `notifications/index.ts`) used a "respond early, keep processing" pattern without `waitUntil()`. On Vercel, code after a response is sent is not guaranteed to keep running — this could cause batch matches, ABDM fetches, and weekly re-matching to silently fail to complete. Added `@vercel/functions`'s `waitUntil()` to all 4, which is the documented-correct mechanism for this pattern.

### Documented (not fixed — accepted Phase 1 tradeoff)
- The in-memory rate limiter (`lib/ratelimit.ts`) does not share state across concurrent serverless instances. It catches casual misuse on a warm instance but not distributed abuse. Documented clearly in the file; upgrade path to Upstash Redis noted for Phase 2.

### Performance (ahead of Phase 2 scale)
- Added trigram (`pg_trgm`) indexes for the feasibility engine's `ILIKE` queries — these are unindexed-by-default and would degrade as org/patient counts grow.

