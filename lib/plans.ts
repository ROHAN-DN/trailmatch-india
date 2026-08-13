/**
 * lib/plans.ts
 * Single source of truth for all plan definitions.
 * Prices are in INR (paise for Stripe: ₹1 = 100 paise).
 *
 * Stripe product/price IDs come from environment variables so
 * they work in both test and live mode without code changes.
 */

export type PlanId = 'trial' | 'starter' | 'pro' | 'enterprise'

export interface Plan {
  id:             PlanId
  name:           string
  tagline:        string
  price_inr:      number        // monthly price in INR (0 = free)
  price_paise:    number        // for Stripe (price_inr * 100)
  stripe_price_id: string | null // from env
  max_patients:   number        // -1 = unlimited
  max_users:      number        // -1 = unlimited
  max_match_jobs_per_month: number // -1 = unlimited
  features:       string[]
  limits: {
    whatsapp:     boolean
    rematch:      boolean       // weekly scheduled re-match
    pdf_reports:  boolean
    email_reports: boolean
    batch_mode:   boolean
    api_access:   boolean
    custom_branding: boolean
    priority_support: boolean
    feasibility:         boolean   // site feasibility + protocol optimiser
    sponsor_portal:      boolean   // Phase 2: sponsor protocol upload + cross-org feasibility
    enrollment_monitor:  boolean   // Phase 2: enrollment monitor agent alerts
    hms_export:          boolean   // Phase 2: Insta HMS CSV export
  }
  highlight?:     boolean       // show "Most popular" badge
}

export const PLANS: Record<PlanId, Plan> = {
  trial: {
    id:          'trial',
    name:        'Free Trial',
    tagline:     'Try it out',
    price_inr:   0,
    price_paise: 0,
    stripe_price_id: null,
    max_patients: 10,
    max_users:    2,
    max_match_jobs_per_month: 5,
    features: [
      'Up to 10 patients',
      '2 team members',
      'ClinicalTrials.gov matching',
      'CTRI India matching',
      'PDF report download',
      '5 match jobs/month',
    ],
    limits: {
      whatsapp:         false,
      rematch:          false,
      pdf_reports:      true,
      email_reports:    false,
      batch_mode:       false,
      api_access:       false,
      custom_branding:  false,
      priority_support: false,
      feasibility:         false,
      sponsor_portal:      false,
      enrollment_monitor:  false,
      hms_export:          false,
    },
  },

  starter: {
    id:          'starter',
    name:        'Starter',
    tagline:     'For small clinics & research teams',
    price_inr:   7999,
    price_paise: 799900,
    stripe_price_id: process.env.STRIPE_PRICE_STARTER || null,
    max_patients: 100,
    max_users:    5,
    max_match_jobs_per_month: -1,
    features: [
      'Up to 100 patients',
      '5 team members',
      'ClinicalTrials.gov + CTRI matching',
      'PDF + email reports',
      'Batch matching (up to 10)',
      'Unlimited match jobs',
      'Basic email notifications',
    ],
    limits: {
      whatsapp:         false,
      rematch:          false,
      pdf_reports:      true,
      email_reports:    true,
      batch_mode:       true,
      api_access:       false,
      custom_branding:  false,
      priority_support: false,
      feasibility:         false,
      sponsor_portal:      false,
      enrollment_monitor:  false,
      hms_export:          false,
    },
  },

  pro: {
    id:          'pro',
    name:        'Pro',
    tagline:     'For hospitals & CROs',
    price_inr:   19999,
    price_paise: 1999900,
    stripe_price_id: process.env.STRIPE_PRICE_PRO || null,
    max_patients: -1,         // unlimited
    max_users:    -1,
    max_match_jobs_per_month: -1,
    highlight:   true,
    features: [
      'Unlimited patients',
      'Unlimited team members',
      'Everything in Starter',
      'WhatsApp notifications (Gupshup)',
      'Weekly auto re-matching',
      'New trial alerts',
      'Custom branding on reports',
      'Priority email support',
    ],
    limits: {
      whatsapp:         true,
      rematch:          true,
      pdf_reports:      true,
      email_reports:    true,
      batch_mode:       true,
      api_access:       false,
      custom_branding:  true,
      priority_support: true,
      feasibility:         true,
      sponsor_portal:      true,
      enrollment_monitor:  true,
      hms_export:          true,
    },
  },

  enterprise: {
    id:          'enterprise',
    name:        'Enterprise',
    tagline:     'Custom contracts for large institutions',
    price_inr:   0,           // custom pricing — contact sales
    price_paise: 0,
    stripe_price_id: null,    // handled via direct invoicing
    max_patients: -1,
    max_users:    -1,
    max_match_jobs_per_month: -1,
    features: [
      'Everything in Pro',
      'Custom SLA & uptime guarantee',
      'Dedicated onboarding',
      'EHR / FHIR integration support',
      'DPDP compliance review',
      'Custom contract & invoicing',
      'On-premise deployment option',
    ],
    limits: {
      whatsapp:         true,
      rematch:          true,
      pdf_reports:      true,
      email_reports:    true,
      batch_mode:       true,
      api_access:       true,
      custom_branding:  true,
      priority_support: true,
      feasibility:         true,
      sponsor_portal:      true,
      enrollment_monitor:  true,
      hms_export:          true,
    },
  },
}

export const PLAN_LIST = Object.values(PLANS)

// ── Helpers ───────────────────────────────────────────────────

/** Check if an org's plan allows a specific feature */
export function planAllows(planId: PlanId, feature: keyof Plan['limits']): boolean {
  return PLANS[planId]?.limits[feature] ?? false
}

/** Check if an org has hit a numeric limit */
export function withinLimit(planId: PlanId, metric: 'patients' | 'users', current: number): boolean {
  const plan  = PLANS[planId]
  if (!plan) return false
  const limit = metric === 'patients' ? plan.max_patients : plan.max_users
  return limit === -1 || current < limit
}

/** Format price for display */
export function formatPrice(price_inr: number): string {
  if (price_inr === 0) return 'Free'
  return `₹${price_inr.toLocaleString('en-IN')}/mo`
}
