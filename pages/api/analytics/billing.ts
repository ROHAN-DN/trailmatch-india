/**
 * pages/api/analytics/billing.ts
 * Billing analytics endpoint — pulls from both Supabase views
 * and live Stripe data, merges, and returns a single payload.
 *
 * Admin/owner only — returns 403 for members & viewers.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'
import { stripe } from '../../../lib/stripe'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).end()
  }

  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user = session.user as any
  if (!['owner', 'admin'].includes(user.role)) {
    return res.status(403).json({ error: 'Admin access required to view billing analytics' })
  }

  const db = supabaseAdmin()

  try {
    // ── 1. Supabase views — all run in parallel ────────────────
    const [
      summaryRes,
      mrrByPlanRes,
      planDistRes,
      statusCountsRes,
      churnEventsRes,
      conversionRes,
      mrrTimelineRes,
    ] = await Promise.all([
      db.rpc('get_billing_analytics_summary'),
      db.from('v_current_mrr_by_plan').select('*'),
      db.from('v_plan_distribution').select('*'),
      db.from('v_subscription_status_counts').select('*'),
      db.from('v_churn_events').select('*').limit(10),
      db.from('v_trial_conversion').select('*').single(),
      db.from('v_mrr_over_time').select('*').order('snapshot_date').limit(90),
    ])

    // ── 2. Live Stripe data (recent events + upcoming renewals) ─
    let stripeEvents: any[] = []
    let upcomingRenewals: any[] = []
    let recentCharges: any[] = []

    try {
      const [eventsRes, subscriptionsRes, chargesRes] = await Promise.all([
        // Recent subscription lifecycle events
        stripe.events.list({
          types: [
            'customer.subscription.created',
            'customer.subscription.deleted',
            'customer.subscription.updated',
            'invoice.payment_failed',
          ],
          limit: 15,
        }),

        // Active subscriptions renewing in next 7 days
        stripe.subscriptions.list({
          status:                'active',
          current_period_end:    { lte: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 },
          limit:                 10,
          expand:                ['data.customer'],
        }),

        // Recent successful charges
        stripe.charges.list({ limit: 8 }),
      ])

      stripeEvents = eventsRes.data.map(e => ({
        id:         e.id,
        type:       e.type,
        created:    new Date(e.created * 1000).toISOString(),
        amount:     (e.data.object as any).amount_paid
                    || (e.data.object as any).amount
                    || null,
        org_id:     (e.data.object as any).metadata?.org_id || null,
      }))

      upcomingRenewals = subscriptionsRes.data.map(sub => ({
        subscription_id: sub.id,
        customer_email:  (sub.customer as any).email || '',
        amount:          sub.items.data[0]?.price.unit_amount || 0,
        renews_at:       new Date(sub.current_period_end * 1000).toISOString(),
        org_id:          sub.metadata?.org_id || null,
      }))

      recentCharges = chargesRes.data
        .filter(c => c.paid)
        .map(c => ({
          id:           c.id,
          amount:       c.amount,
          created:      new Date(c.created * 1000).toISOString(),
          customer:     c.customer,
          receipt_url:  c.receipt_url,
          org_id:       (c.metadata as any)?.org_id || null,
        }))

    } catch (stripeErr: any) {
      // Stripe not configured yet — return empty arrays gracefully
      console.warn('[billing-analytics] Stripe not available:', stripeErr.message)
    }

    // ── 3. Compose MRR timeline with gap-filling ────────────────
    // If no snapshot data yet (new install), synthesise from current billing
    let mrrTimeline = mrrTimelineRes.data || []
    if (mrrTimeline.length === 0) {
      // Synthesise a single today datapoint from current active subs
      const currentMRR = (summaryRes.data as any)?.total_mrr_inr || 0
      if (currentMRR > 0) {
        mrrTimeline = [{
          snapshot_date: new Date().toISOString().split('T')[0],
          total_mrr_inr: currentMRR,
          active_orgs:   (summaryRes.data as any)?.paying_subscribers || 0,
        }]
      }
    }

    return res.json({
      summary:          summaryRes.data     || {},
      mrr_by_plan:      mrrByPlanRes.data   || [],
      plan_distribution: planDistRes.data   || [],
      status_counts:    statusCountsRes.data || [],
      churn_events:     churnEventsRes.data  || [],
      conversion:       conversionRes.data   || null,
      mrr_timeline:     mrrTimeline,
      stripe_events:    stripeEvents,
      upcoming_renewals: upcomingRenewals,
      recent_charges:   recentCharges,
    })

  } catch (err: any) {
    console.error('[billing-analytics] Error:', err)
    return res.status(500).json({ error: err.message })
  }
}
