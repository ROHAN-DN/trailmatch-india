/**
 * pages/api/billing/portal.ts
 * Creates a Stripe Customer Portal session for self-serve billing management.
 * Users can: update payment method, download invoices, cancel subscription.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'
import { createPortalSession } from '../../../lib/stripe'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).end()
  }

  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user = session.user as any
  const db   = supabaseAdmin()

  const { data: billing } = await db
    .from('org_billing')
    .select('stripe_customer_id')
    .eq('org_id', user.org_id)
    .single()

  if (!billing?.stripe_customer_id) {
    return res.status(404).json({ error: 'No billing account found. Please subscribe first.' })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  try {
    const portalSession = await createPortalSession({
      customerId: billing.stripe_customer_id,
      returnUrl:  `${appUrl}/dashboard?tab=billing`,
    })
    return res.json({ url: portalSession.url })
  } catch (err: any) {
    console.error('Stripe portal error:', err)
    return res.status(500).json({ error: 'Failed to open billing portal' })
  }
}
