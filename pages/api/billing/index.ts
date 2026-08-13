/**
 * pages/api/billing/index.ts
 * Returns current billing status, plan details, usage, and invoice history.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'
import { PLANS } from '../../../lib/plans'
import { stripe } from '../../../lib/stripe'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).end()
  }

  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user = session.user as any
  const db   = supabaseAdmin()

  const [{ data: org }, { data: billing }, { count: patientCount }, { count: userCount }] =
    await Promise.all([
      db.from('organizations').select('*').eq('id', user.org_id).single(),
      db.from('org_billing').select('*').eq('org_id', user.org_id).single(),
      db.from('patients').select('*', { count: 'exact', head: true }).eq('org_id', user.org_id).eq('is_archived', false),
      db.from('users').select('*', { count: 'exact', head: true }).eq('org_id', user.org_id).eq('is_active', true),
    ])

  const planId   = (org?.plan || 'trial') as keyof typeof PLANS
  const planDef  = PLANS[planId]

  // Fetch recent invoices from Stripe if customer exists
  let invoices: any[] = []
  if (billing?.stripe_customer_id) {
    try {
      const stripeInvoices = await stripe.invoices.list({
        customer: billing.stripe_customer_id,
        limit:    5,
      })
      invoices = stripeInvoices.data.map(inv => ({
        id:       inv.id,
        date:     new Date(inv.created * 1000).toISOString(),
        amount:   inv.amount_paid,
        status:   inv.status,
        pdf_url:  inv.invoice_pdf,
        hosted_url: inv.hosted_invoice_url,
        period_end: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
      }))
    } catch (e) {
      console.error('Failed to fetch Stripe invoices:', e)
    }
  }

  return res.json({
    plan:    planDef,
    billing: billing || null,
    usage: {
      patients:      patientCount || 0,
      patients_max:  planDef.max_patients,
      users:         userCount || 0,
      users_max:     planDef.max_users,
    },
    invoices,
  })
}
