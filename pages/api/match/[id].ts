/**
 * pages/api/match/[id].ts
 * GET   -> job status + result rows (for polling)
 * PATCH -> update enrollment_status on a specific result row (audit-logged)
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'

const VALID_STATUSES = [
  'pending','coordinator_reviewing','pi_contacted','pre_screening_booked',
  'pre_screening_done','enrolled','screen_failed','patient_declined',
  'trial_closed','not_actioned',
]

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user   = session.user as any
  const db     = supabaseAdmin()
  const { id } = req.query as { id: string }

  if (req.method === 'GET') {
    const { data: job } = await db.from('match_jobs')
      .select('*').eq('id', id).eq('org_id', user.org_id).single()

    if (!job) return res.status(404).json({ error: 'Job not found' })

    const { data: results } = await db.from('match_results')
      .select(`
        id, status, error_msg, report_url, email_sent_at,
        trials_searched, ctgov_count, ctri_count, summary,
        matches, not_matched,
        enrollment_status, enrollment_status_updated_at,
        enrollment_notes, enrolled_at, screen_fail_reason,
        patients (id, patient_code, diagnosis, age, sex, location)
      `)
      .eq('job_id', id)
      .order('created_at', { ascending: true })

    return res.json({ job, results: results || [] })
  }

  if (req.method === 'PATCH') {
    const { result_id, enrollment_status, enrollment_notes, screen_fail_reason } = req.body as {
      result_id: string; enrollment_status: string; enrollment_notes?: string; screen_fail_reason?: string
    }

    if (!result_id) return res.status(400).json({ error: 'result_id is required' })
    if (!VALID_STATUSES.includes(enrollment_status)) {
      return res.status(400).json({ error: `Invalid enrollment_status: ${enrollment_status}`, allowed: VALID_STATUSES })
    }

    const { data: current } = await db.from('match_results')
      .select('enrollment_status, org_id').eq('id', result_id).single()

    if (!current || current.org_id !== user.org_id) {
      return res.status(404).json({ error: 'Result not found' })
    }

    const updates: Record<string, any> = {
      enrollment_status,
      enrollment_status_updated_at: new Date().toISOString(),
    }
    if (enrollment_notes  !== undefined) updates.enrollment_notes   = enrollment_notes
    if (screen_fail_reason !== undefined) updates.screen_fail_reason = screen_fail_reason
    if (enrollment_status === 'enrolled') updates.enrolled_at = new Date().toISOString()

    const { data: updated, error } = await db.from('match_results')
      .update(updates).eq('id', result_id).eq('org_id', user.org_id).select().single()

    if (error) return res.status(500).json({ error: error.message })

    await db.from('audit_log').insert({
      org_id: user.org_id, user_id: user.id, action: 'update_enrollment_status',
      entity: 'match_result', entity_id: result_id,
      metadata: { previous_status: current.enrollment_status, new_status: enrollment_status, notes: enrollment_notes || null },
    })

    return res.json({ result: updated })
  }

  res.setHeader('Allow', ['GET', 'PATCH'])
  res.status(405).end()
}
