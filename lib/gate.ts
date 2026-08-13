/**
 * lib/gate.ts
 * Plan enforcement helpers — call these in API routes to block
 * features not available on the current org's plan.
 *
 * Usage in an API route:
 *
 *   const gate = await checkGate(user.org_id, 'whatsapp')
 *   if (!gate.allowed) return res.status(402).json({ error: gate.message, upgrade: gate.upgrade })
 */

import { supabaseAdmin } from './supabase'
import { PLANS, planAllows, withinLimit, type PlanId } from './plans'

export interface GateResult {
  allowed:  boolean
  message?: string
  upgrade?: string   // plan id to upgrade to
}

// ── Feature gate ──────────────────────────────────────────────
export async function checkGate(
  org_id:  string,
  feature: keyof typeof PLANS.trial.limits
): Promise<GateResult> {
  const db = supabaseAdmin()
  const { data: org } = await db
    .from('organizations')
    .select('plan')
    .eq('id', org_id)
    .single()

  const planId = (org?.plan || 'trial') as PlanId

  if (planAllows(planId, feature)) {
    return { allowed: true }
  }

  const featureLabels: Record<string, string> = {
    whatsapp:         'WhatsApp notifications',
    rematch:          'Weekly auto re-matching',
    email_reports:    'Email report delivery',
    batch_mode:       'Batch matching',
    custom_branding:  'Custom branding',
    api_access:       'API access',
    priority_support: 'Priority support',
    feasibility:      'Site feasibility',
  }

  const label   = featureLabels[feature] || feature
  const upgrade = planId === 'trial' ? 'starter' : 'pro'

  return {
    allowed: false,
    message: `${label} is not available on the ${PLANS[planId].name} plan. Upgrade to ${PLANS[upgrade].name} to unlock it.`,
    upgrade,
  }
}

// ── Numeric limit gate ────────────────────────────────────────
export async function checkLimit(
  org_id: string,
  metric: 'patients' | 'users',
  additionalCount: number = 1
): Promise<GateResult> {
  const db = supabaseAdmin()

  const [{ data: org }, { count }] = await Promise.all([
    db.from('organizations').select('plan, max_patients, max_users').eq('id', org_id).single(),
    metric === 'patients'
      ? db.from('patients').select('*', { count: 'exact', head: true }).eq('org_id', org_id).eq('is_archived', false)
      : db.from('users').select('*', { count: 'exact', head: true }).eq('org_id', org_id).eq('is_active', true),
  ])

  const planId  = (org?.plan || 'trial') as PlanId
  const current = count || 0
  const limit   = metric === 'patients' ? org?.max_patients : org?.max_users

  // current + additionalCount <= limit is exactly equivalent to the
  // original `current < limit` for the default additionalCount of 1 —
  // every existing single-item call site behaves identically to before.
  if (limit === -1 || current + additionalCount <= limit) {
    return { allowed: true }
  }

  const upgrade = planId === 'trial' ? 'starter' : 'pro'
  const label   = metric === 'patients' ? 'patients' : 'team members'
  const room    = Math.max(0, limit - current)

  return {
    allowed: false,
    message: additionalCount > 1
      ? `Adding ${additionalCount} ${label} would exceed the ${PLANS[planId].name} plan limit of ${limit} (you have room for ${room} more). Upgrade to add more.`
      : `You've reached the ${PLANS[planId].name} plan limit of ${limit} ${label}. Upgrade to add more.`,
    upgrade,
  }
}

// ── Monthly match-job limit ──────────────────────────────────
// Separate from checkLimit above because this isn't a simple
// current-count-vs-cap check — it's windowed to the current calendar
// month, resetting automatically each month rather than being a running
// total. "5 match jobs/month" has been advertised in the trial plan's
// features list since that list existed; nothing ever enforced it.
export async function checkMonthlyMatchJobLimit(org_id: string): Promise<GateResult> {
  const db = supabaseAdmin()
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()

  const [{ data: org }, { count }] = await Promise.all([
    db.from('organizations').select('plan, max_match_jobs_per_month').eq('id', org_id).single(),
    db.from('match_jobs').select('*', { count: 'exact', head: true })
      .eq('org_id', org_id).gte('created_at', startOfMonth),
  ])

  const planId = (org?.plan || 'trial') as PlanId
  const limit  = org?.max_match_jobs_per_month
  const current = count || 0

  if (limit === -1 || current < limit) {
    return { allowed: true }
  }

  const upgrade = planId === 'trial' ? 'starter' : 'pro'
  return {
    allowed: false,
    message: `You've reached the ${PLANS[planId].name} plan's limit of ${limit} match job${limit === 1 ? '' : 's'} this month. Upgrade to ${PLANS[upgrade].name} for unlimited match jobs, or try again next month.`,
    upgrade,
  }
}

// ── Convenience: throw-style gate (use in async API handlers) ─
export async function requireFeature(
  org_id:    string,
  feature:   keyof typeof PLANS.trial.limits,
  res:       any
): Promise<boolean> {
  const gate = await checkGate(org_id, feature)
  if (!gate.allowed) {
    res.status(402).json({ error: gate.message, upgrade: gate.upgrade })
    return false
  }
  return true
}
