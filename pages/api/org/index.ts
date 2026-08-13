import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user = session.user as any
  const db   = supabaseAdmin()

  // ── GET — fetch org settings ──────────────────────────────────
  if (req.method === 'GET') {
    const { data: org } = await db.from('organizations')
      .select('*')
      .eq('id', user.org_id)
      .single()

    const { count: patientCount } = await db.from('patients')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', user.org_id)
      .eq('is_archived', false)

    const { count: userCount } = await db.from('users')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', user.org_id)
      .eq('is_active', true)

    const { count: jobCount } = await db.from('match_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', user.org_id)

    return res.json({
      org,
      usage: { patients: patientCount, users: userCount, jobs: jobCount },
    })
  }

  // ── PATCH — update org settings (admin/owner only) ─────────────
  if (req.method === 'PATCH') {
    if (!['owner', 'admin'].includes(user.role)) {
      return res.status(403).json({ error: 'Admin access required' })
    }

    const allowed = ['name', 'type', 'city', 'state', 'logo_url', 'brand_color', 'data_retention_months']
    const updates: Record<string, any> = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }

    const { data, error } = await db.from('organizations')
      .update(updates)
      .eq('id', user.org_id)
      .select().single()

    if (error) return res.status(500).json({ error: error.message })

    await db.from('audit_log').insert({
      org_id:   user.org_id,
      user_id:  user.id,
      action:   'update_org_settings',
      metadata: updates,
    })

    return res.json({ org: data })
  }

  res.setHeader('Allow', ['GET', 'PATCH'])
  res.status(405).end()
}
