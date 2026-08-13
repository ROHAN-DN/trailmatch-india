/**
 * pages/api/cron/data-retention.ts
 * Monthly job: archives patient records inactive beyond org's retention period.
 * Required under DPDP Act 2023 (storage minimisation principle).
 *
 * Triggered by the native Vercel Cron entry in vercel.json (2:00 AM UTC,
 * 1st of the month). Also runnable via Supabase pg_cron + pg_net or
 * manually — see lib/cron-auth.ts for accepted auth mechanisms.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { supabaseAdmin } from '../../../lib/supabase'
import { isAuthorizedCronRequest, isAllowedCronMethod } from '../../../lib/cron-auth'

export const config = { maxDuration: 60 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAllowedCronMethod(req.method)) {
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).end()
  }

  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const db  = supabaseAdmin()
  const now = new Date()
  console.log(`[data-retention] Starting run at ${now.toISOString()}`)

  const { data: orgs, error: orgsErr } = await db
    .from('organizations')
    .select('id, name, data_retention_months')

  if (orgsErr || !orgs) {
    return res.status(500).json({ error: orgsErr?.message })
  }

  let totalArchived = 0
  const results: { org: string; archived: number }[] = []

  for (const org of orgs) {
    const retentionMonths = org.data_retention_months || 24
    const cutoff = new Date(now)
    cutoff.setMonth(cutoff.getMonth() - retentionMonths)

    try {
      const { data: stale } = await db
        .from('patients')
        .select('id, patient_code')
        .eq('org_id', org.id)
        .eq('is_archived', false)
        .lt('updated_at', cutoff.toISOString())

      if (!stale?.length) continue

      const { data: recentMatches } = await db
        .from('match_results')
        .select('patient_id')
        .eq('org_id', org.id)
        .gte('created_at', cutoff.toISOString())

      const recentIds = new Set((recentMatches || []).map(m => m.patient_id))
      const toArchive = stale.filter(p => !recentIds.has(p.id))
      if (!toArchive.length) continue

      await db.from('patients')
        .update({ is_archived: true, updated_at: now.toISOString() })
        .in('id', toArchive.map(p => p.id))
        .eq('org_id', org.id)

      await db.from('audit_log').insert({
        org_id:   org.id,
        action:   'data_retention_archive',
        metadata: {
          archived_count:   toArchive.length,
          retention_months: retentionMonths,
          cutoff_date:      cutoff.toISOString(),
          patient_codes:    toArchive.map(p => p.patient_code),
        },
      })

      totalArchived += toArchive.length
      results.push({ org: org.name, archived: toArchive.length })
    } catch (e: any) {
      console.error(`[data-retention] Error for org ${org.name}:`, e.message)
    }
  }

  console.log(`[data-retention] Complete. Total archived: ${totalArchived}`)
  return res.json({ success: true, run_at: now.toISOString(), total_archived: totalArchived, by_org: results })
}
