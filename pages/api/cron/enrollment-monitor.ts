/**
 * pages/api/cron/enrollment-monitor.ts — Production rewrite
 * Runs every 6h via vercel.json.
 * Sundays: also generates + sends weekly pace reports.
 */
import type { NextApiRequest, NextApiResponse } from 'next'
import { runEnrollmentMonitor, generateWeeklyReport } from '../../../lib/enrollment-monitor'
import { supabaseAdmin } from '../../../lib/supabase'
import { writeAudit } from '../../../lib/audit'
import { isAuthorizedCronRequest } from '../../../lib/cron-auth'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: 'Unauthorised' })
  }

  const started  = Date.now()
  const isSunday = new Date().getUTCDay() === 0

  try {
    const { alerts_sent, orgs_checked } = await runEnrollmentMonitor()

    let reports_sent = 0
    if (isSunday) {
      const db           = supabaseAdmin()
      const { data: orgs } = await db
        .from('organizations')
        .select('id')
        .not('org_type', 'in', '("pharma","biotech")')
        .eq('is_active', true)

      for (const o of orgs || []) {
        try {
          const { sent } = await generateWeeklyReport(o.id)
          if (sent) reports_sent++
        } catch (e) {
          console.error('[cron/enrollment-monitor] Report failed for org', o.id, e)
        }
      }
    }

    const elapsed = Date.now() - started

    writeAudit({
      action:   'ai:monitor_alert_sent',
      metadata: { alerts_sent, orgs_checked, reports_sent, elapsed_ms: elapsed, weekly: isSunday },
    })

    return res.json({ ok: true, alerts_sent, orgs_checked, reports_sent, weekly: isSunday, elapsed_ms: elapsed })
  } catch (e: any) {
    console.error('[cron/enrollment-monitor]', e.message)
    return res.status(500).json({ error: e.message })
  }
}
