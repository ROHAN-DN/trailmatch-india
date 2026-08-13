/**
 * pages/api/billing/checkout.ts
 * Creates a Stripe Checkout session and returns the URL.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'
import { stripe, createCheckoutSession } from '../../../lib/stripe'
import { PLANS, type PlanId } from '../../../lib/plans'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).end()
  }

  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user = session.user as any
  const db   = supabaseAdmin()

  const { plan_id } = req.body as { plan_id: PlanId }
  const plan = PLANS[plan_id]

  if (!plan || !plan.stripe_price_id) {
    return res.status(400).json({ error: 'Invalid plan or plan has no Stripe price' })
  }

  // Fetch org + existing billing record
  const [{ data: org }, { data: billing }] = await Promise.all([
    db.from('organizations').select('name').eq('id', user.org_id).single(),
    db.from('org_billing').select('stripe_customer_id').eq('org_id', user.org_id).single(),
  ])

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  try {
    const checkoutSession = await createCheckoutSession({
      orgId:               user.org_id,
      orgName:             org?.name || 'TrialMatch Org',
      email:               user.email,
      priceId:             plan.stripe_price_id,
      successUrl:          `${appUrl}/dashboard?billing=success&plan=${plan_id}`,
      cancelUrl:           `${appUrl}/dashboard?tab=billing&billing=cancelled`,
      existingCustomerId:  billing?.stripe_customer_id || undefined,
    })

    return res.json({ url: checkoutSession.url })
  } catch (err: any) {
    console.error('Stripe checkout error:', err)
    return res.status(500).json({ error: 'Failed to create checkout session' })
  }
}
