/**
 * pages/api/cron/site-twin-refresh.ts — Production rewrite
 * Weekly Sunday 02:00 IST cron via vercel.json
 */
import type { NextApiRequest, NextApiResponse } from 'next'
import { supabaseAdmin } from '../../../lib/supabase'
import { writeAudit } from '../../../lib/audit'
import { isAuthorizedCronRequest } from '../../../lib/cron-auth'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: 'Unauthorised' })
  }

  const db      = supabaseAdmin()
  const started = Date.now()

  try {
    const { error } = await db.rpc('refresh_site_twin_performance')
    if (error) throw new Error(error.message)

    const elapsed = Date.now() - started

    writeAudit({
      action:   'site:twin_refresh_run',
      metadata: { elapsed_ms: elapsed, triggered_by: 'cron' },
    })

    return res.json({ ok: true, elapsed_ms: elapsed })
  } catch (e: any) {
    console.error('[cron/site-twin-refresh]', e.message)
    return res.status(500).json({ error: e.message })
  }
}
