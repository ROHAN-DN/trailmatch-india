/**
 * lib/feasibility.ts — Production rewrite (Fix 4: N+1 query timeout)
 *
 * PROBLEM: Old implementation fired O(orgs × criteria²) sequential DB queries.
 * With 80 orgs + 8 criteria = 2,880 queries → Vercel 10s timeout → silent failure.
 *
 * FIX: Reduced to O(criteria + 1) total queries — independent of org count.
 *
 * Approach:
 *   1. One query: count all active patients grouped by org (the denominator).
 *   2. For each cumulative criterion step i (0..N-1): one query that counts
 *      patients matching criteria[0..i], grouped by org_id.
 *   Total: N_criteria + 1 queries. At 8 criteria = 9 queries regardless of orgs.
 *
 * Clinical accuracy rules are unchanged:
 *   - Text matching is ILIKE (approximate, over-inclusive by design)
 *   - Lab values matched on name presence, not numeric threshold
 *   - Sites with <5 total patients never shown
 *   - Confidence: high ≥50, medium 10-49, low 1-9
 */

import { supabaseAdmin } from './supabase'

export interface FeasibilityCriterion {
  field:    'diagnosis' | 'age' | 'labs' | 'medications' | 'comorbidities' | 'biomarkers' | 'ecog_status' | 'sex'
  operator: 'contains' | 'not_contains' | 'gte' | 'lte' | 'between' | 'equals'
  value:    string | number | [number, number]
  label:    string
}

export interface SiteFeasibilityResult {
  org_id:                 string
  org_name:               string
  city:                   string
  total_patients_at_site: number
  total_count:            number
  confidence:             'high' | 'medium' | 'low'
  breakdown:              { criterion: string; count: number; cumulative: number }[]
  disclaimer:             string
}

const DISCLAIMER =
  'Estimate based on de-identified patient records entered by coordinators. ' +
  'Actual eligibility requires confirmation by the Principal Investigator at screening. ' +
  'Lab value filters match on recorded test names, not numeric thresholds.'

const MIN_SITE_PATIENTS = 5

// Apply a single criterion to a Supabase query builder
function applyCriterion(q: any, c: FeasibilityCriterion): any {
  const v = c.value
  switch (c.field) {
    case 'diagnosis':
      return c.operator === 'not_contains'
        ? q.not('diagnosis', 'ilike', `%${v}%`)
        : q.ilike('diagnosis', `%${v}%`)

    case 'age':
      if (c.operator === 'gte')     return q.gte('age', v)
      if (c.operator === 'lte')     return q.lte('age', v)
      if (c.operator === 'between') {
        const [lo, hi] = v as [number, number]
        return q.gte('age', lo).lte('age', hi)
      }
      if (c.operator === 'equals')  return q.eq('age', v)
      return q

    case 'medications':
      return c.operator === 'not_contains'
        ? q.not('medications', 'ilike', `%${v}%`)
        : q.ilike('medications', `%${v}%`)

    case 'labs':
      return c.operator === 'not_contains'
        ? q.not('labs', 'ilike', `%${v}%`)
        : q.ilike('labs', `%${v}%`)

    case 'comorbidities':
      return c.operator === 'not_contains'
        ? q.not('comorbidities', 'ilike', `%${v}%`)
        : q.ilike('comorbidities', `%${v}%`)

    case 'biomarkers':
      return c.operator === 'not_contains'
        ? q.not('biomarkers', 'ilike', `%${v}%`)
        : q.ilike('biomarkers', `%${v}%`)

    case 'ecog_status':
      return q.ilike('ecog_status', `%${v}%`)

    case 'sex':
      return q.ilike('sex', `%${v}%`)

    default:
      return q
  }
}

export async function runFeasibility(
  criteria: FeasibilityCriterion[]
): Promise<SiteFeasibilityResult[]> {
  if (!criteria.length) return []

  const db = supabaseAdmin()

  // ── Step 1: Load all orgs with their names (1 query) ──────────────────────
  const { data: orgs } = await db
    .from('organizations')
    .select('id, name, city')
    .not('org_type', 'in', '("pharma","biotech")')  // sponsors don't have patients

  if (!orgs?.length) return []

  const orgMap = new Map<string, { name: string; city: string }>(
    orgs.map(o => [o.id, { name: o.name, city: o.city || 'India' }])
  )

  // ── Step 2: Total active patients per org (1 query, all orgs) ─────────────
  const { data: totals } = await db
    .from('patients')
    .select('org_id')
    .eq('is_archived', false)

  // Count in JS — avoids a GROUP BY which Supabase JS client doesn't support cleanly
  const totalByOrg = new Map<string, number>()
  for (const row of totals || []) {
    totalByOrg.set(row.org_id, (totalByOrg.get(row.org_id) || 0) + 1)
  }

  // Filter out orgs below the minimum threshold immediately
  const eligibleOrgIds = new Set(
    [...totalByOrg.entries()]
      .filter(([, count]) => count >= MIN_SITE_PATIENTS)
      .map(([id]) => id)
  )

  if (eligibleOrgIds.size === 0) return []

  // ── Step 3: For each cumulative criterion step, 1 query across ALL orgs ───
  // Total: N_criteria queries (e.g. 8 criteria = 8 queries, not 8 × 80 = 640)
  const stepCounts: Map<string, number>[] = []

  for (let i = 0; i < criteria.length; i++) {
    // Build query with criteria[0..i] applied cumulatively
    let q = db
      .from('patients')
      .select('org_id')
      .eq('is_archived', false)
      .in('org_id', [...eligibleOrgIds])

    for (let j = 0; j <= i; j++) {
      q = applyCriterion(q, criteria[j])
    }

    const { data: rows } = await q

    const countMap = new Map<string, number>()
    for (const row of rows || []) {
      countMap.set(row.org_id, (countMap.get(row.org_id) || 0) + 1)
    }
    stepCounts.push(countMap)
  }

  // ── Step 4: Assemble results ───────────────────────────────────────────────
  const results: SiteFeasibilityResult[] = []

  for (const orgId of eligibleOrgIds) {
    const org        = orgMap.get(orgId)
    if (!org) continue

    const totalAtSite = totalByOrg.get(orgId) || 0
    const finalCount  = stepCounts[criteria.length - 1]?.get(orgId) || 0

    if (finalCount === 0) continue

    const breakdown: { criterion: string; count: number; cumulative: number }[] = [
      { criterion: 'All active patients', count: totalAtSite, cumulative: totalAtSite },
    ]

    for (let i = 0; i < criteria.length; i++) {
      const count = stepCounts[i]?.get(orgId) || 0
      breakdown.push({ criterion: criteria[i].label, count, cumulative: count })
    }

    const confidence: 'high' | 'medium' | 'low' =
      finalCount >= 50 ? 'high' :
      finalCount >= 10 ? 'medium' : 'low'

    results.push({
      org_id:                 orgId,
      org_name:               org.name,
      city:                   org.city,
      total_patients_at_site: totalAtSite,
      total_count:            finalCount,
      confidence,
      breakdown,
      disclaimer:             DISCLAIMER,
    })
  }

  return results.sort((a, b) => b.total_count - a.total_count)
}
