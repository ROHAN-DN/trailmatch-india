/**
 * pages/api/feasibility/index.ts
 * POST → run a feasibility query, save it, return per-site results
 * GET  → list saved feasibility queries for this org
 *
 * Gated to Pro plan and above. Rate limited to prevent DB-heavy abuse.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'
import { runFeasibility, type FeasibilityCriterion } from '../../../lib/feasibility'
import { requireFeature } from '../../../lib/gate'
import { feasibilityRateLimit } from '../../../lib/ratelimit'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user = session.user as any
  const db   = supabaseAdmin()

  if (req.method === 'GET') {
    const { data, error } = await db.from('feasibility_queries')
      .select('id, name, criteria, total_sites, created_at, parent_query_id')
      .eq('org_id', user.org_id)
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) return res.status(500).json({ error: error.message })
    return res.json({ queries: data || [] })
  }

  if (req.method === 'POST') {
    // Gate: Pro plan and above only
    if (!await requireFeature(user.org_id, 'feasibility', res)) return

    // Rate limit: 20 feasibility runs per org per hour (DB-heavy)
    const rl = await feasibilityRateLimit(user.org_id)
    if (!rl.ok) return res.status(429).json({ error: rl.message })

    const { criteria, name, parent_query_id } = req.body as {
      criteria: FeasibilityCriterion[]
      name?: string
      parent_query_id?: string
    }

    if (!criteria || !Array.isArray(criteria) || criteria.length === 0) {
      return res.status(400).json({ error: 'At least one criterion is required (diagnosis is recommended).' })
    }
    if (criteria.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 criteria per feasibility query.' })
    }

    try {
      const results = await runFeasibility(criteria)

      const { data: saved, error } = await db.from('feasibility_queries').insert({
        org_id:          user.org_id,
        created_by:      user.id,
        name:            name || `Feasibility — ${new Date().toLocaleDateString('en-IN')}`,
        criteria,
        results,
        total_sites:     results.length,
        status:          'complete',
        parent_query_id: parent_query_id || null,
      }).select().single()

      if (error) return res.status(500).json({ error: error.message })

      await db.from('audit_log').insert({
        org_id: user.org_id, user_id: user.id, action: 'run_feasibility_query',
        entity: 'feasibility_query', entity_id: saved.id,
        metadata: { criteria_count: criteria.length, sites_found: results.length },
      })

      return res.json({
        query_id:        saved.id,
        results,
        total_sites:     results.length,
        total_qualifying: results.reduce((a, r) => a + r.total_count, 0),
      })

    } catch (err: any) {
      console.error('[feasibility] Error:', err)
      return res.status(500).json({ error: `Feasibility query failed: ${err.message}` })
    }
  }

  res.setHeader('Allow', ['GET', 'POST'])
  res.status(405).end()
}
