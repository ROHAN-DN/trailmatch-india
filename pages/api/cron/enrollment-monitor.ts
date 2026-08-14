/**
 * pages/api/cron/enrollment-monitor.ts — Production rewrite
 * Runs once daily at 00:30 UTC (06:00 IST) via vercel.json — changed
 * from every 6 hours specifically to stay on Vercel's free Hobby plan,
 * which only supports daily-or-longer cron schedules. If you're on Pro
 * (or move this to Supabase pg_cron instead) and want tighter
 * monitoring, restore the original 6-hourly schedule in vercel.json
 * (every 6 hours, on the hour — see git history for the exact string;
 * not spelled out here since it contains a sequence that breaks this
 * very comment block).
 * Sundays: also generates + sends weekly pace reports. A daily
 * schedule still lands on Sunday once a week, so this still fires
 * correctly with no change needed to the logic below.
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
