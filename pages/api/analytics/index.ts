/**
 * pages/api/analytics/index.ts
 * Returns all analytics data for the dashboard in a single request.
 * Queries the pre-computed views in analytics.sql.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).end()
  }

  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user = session.user as any
  const db   = supabaseAdmin()
  const org_id = user.org_id

  try {
    // All queries run in parallel for speed
    const [
      summaryRes,
      conditionsRes,
      funnelRes,
      topTrialsRes,
      timelineRes,
      demographicsRes,
      enrollmentFunnelRes,
    ] = await Promise.all([

      // KPI summary (single RPC call)
      db.rpc('get_analytics_summary', { p_org_id: org_id }),

      // Match rates by condition (top 10)
      db.from('v_match_rates_by_condition')
        .select('*')
        .eq('org_id', org_id)
        .order('patient_count', { ascending: false })
        .limit(10),

      // Recruitment funnel
      db.from('v_recruitment_funnel')
        .select('*')
        .eq('org_id', org_id)
        .single(),

      // Top matched trials
      db.from('v_top_trials')
        .select('*')
        .eq('org_id', org_id)
        .order('times_matched', { ascending: false })
        .limit(8),

      // Jobs over time (last 12 weeks)
      db.from('v_jobs_over_time')
        .select('*')
        .eq('org_id', org_id)
        .order('week_start', { ascending: true })
        .limit(12),

      // Patient demographics
      db.from('v_patient_demographics')
        .select('*')
        .eq('org_id', org_id),

      // Enrollment conversion funnel
      db.from('v_enrollment_funnel')
        .select('*')
        .eq('org_id', org_id)
        .single(),
    ])

    return res.json({
      summary:           summaryRes.data || {},
      conditions:        conditionsRes.data || [],
      funnel:            funnelRes.data || null,
      top_trials:        topTrialsRes.data || [],
      timeline:          timelineRes.data || [],
      demographics:      demographicsRes.data || [],
      enrollment_funnel: enrollmentFunnelRes.data || null,
    })

  } catch (err: any) {
    console.error('Analytics error:', err)
    return res.status(500).json({ error: err.message })
  }
}
