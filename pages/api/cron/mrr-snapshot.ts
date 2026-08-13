/**
 * pages/api/cron/mrr-snapshot.ts
 * Triggered monthly (1st, 00:00 UTC) by the native Vercel Cron entry in
 * vercel.json. Ensures the v_mrr_over_time chart has data even on days
 * when no Stripe events fire.
 *
 * Also runnable via Supabase pg_cron + pg_net if you'd rather trigger
 * from Postgres — see lib/cron-auth.ts for accepted auth mechanisms:
 *   select cron.schedule(
 *     'daily-mrr-snapshot',
 *     '25 18 * * *',   -- 23:55 IST = 18:25 UTC
 *     $$
 *       select net.http_post(
 *         url     := 'https://YOUR_VERCEL_URL/api/cron/mrr-snapshot',
 *         headers := '{"Content-Type":"application/json","x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb,
 *         body    := '{}'::jsonb
 *       );
 *     $$
 *   );
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { supabaseAdmin } from '../../../lib/supabase'
import { isAuthorizedCronRequest, isAllowedCronMethod } from '../../../lib/cron-auth'

export const config = { maxDuration: 30 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAllowedCronMethod(req.method)) {
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).end()
  }

  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const db   = supabaseAdmin()
  const date = new Date().toISOString().split('T')[0]

  try {
    // Fetch all active billing records
    const { data: billingRecords } = await db
      .from('org_billing')
      .select('org_id, subscription_status, last_invoice_amount, stripe_price_id')

    if (!billingRecords?.length) {
      return res.json({ message: 'No billing records found', snapshots: 0 })
    }

    // Fetch org plans in one call
    const orgIds = billingRecords.map(b => b.org_id)
    const { data: orgs } = await db
      .from('organizations')
      .select('id, plan')
      .in('id', orgIds)

    const planMap = Object.fromEntries((orgs || []).map(o => [o.id, o.plan]))

    // Upsert snapshots for today
    const snapshots = billingRecords.map(b => ({
      snapshot_date: date,
      org_id:        b.org_id,
      plan:          planMap[b.org_id] || 'trial',
      mrr_paise:     b.subscription_status === 'active' || b.subscription_status === 'trialing'
                       ? (b.last_invoice_amount || 0)
                       : 0,
      status:        b.subscription_status,
    }))

    const { error } = await db
      .from('mrr_snapshots')
      .upsert(snapshots, { onConflict: 'snapshot_date,org_id' })

    if (error) throw new Error(error.message)

    const totalMRR = snapshots.reduce((a, s) => a + s.mrr_paise, 0)

    console.log(`[mrr-snapshot] ${date}: ${snapshots.length} orgs, total MRR ₹${totalMRR / 100}`)

    return res.json({
      date,
      snapshots: snapshots.length,
      total_mrr_inr: totalMRR / 100,
    })

  } catch (err: any) {
    console.error('[mrr-snapshot] Error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
