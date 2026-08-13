/**
 * pages/api/billing/webhook.ts
 * Stripe webhook endpoint — receives subscription lifecycle events
 * and keeps the database in sync.
 *
 * Setup:
 *  1. Stripe Dashboard → Developers → Webhooks → Add endpoint
 *     URL: https://YOUR_VERCEL_URL/api/billing/webhook
 *     Events to listen for:
 *       ✅ checkout.session.completed
 *       ✅ customer.subscription.created
 *       ✅ customer.subscription.updated
 *       ✅ customer.subscription.deleted
 *       ✅ invoice.payment_succeeded
 *       ✅ invoice.payment_failed
 *  2. Copy "Signing secret" → STRIPE_WEBHOOK_SECRET env var
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { buffer } from 'micro'
import Stripe from 'stripe'
import { stripe, subscriptionToPlan } from '../../../lib/stripe'
import { supabaseAdmin } from '../../../lib/supabase'
import { PLANS } from '../../../lib/plans'

// Disable body parsing — Stripe needs the raw body for signature verification
export const config = { api: { bodyParser: false } }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).end()
  }

  const rawBody = await buffer(req)
  const sig     = req.headers['stripe-signature'] as string

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message)
    return res.status(400).json({ error: `Webhook Error: ${err.message}` })
  }

  const db = supabaseAdmin()
  console.log(`[webhook] ${event.type}`)

  try {
    switch (event.type) {

      // ── Checkout completed — first-time subscription ──────────
      case 'checkout.session.completed': {
        const session  = event.data.object as Stripe.Checkout.Session
        const org_id   = session.metadata?.org_id
        if (!org_id || session.mode !== 'subscription') break

        const subId    = session.subscription as string
        const sub      = await stripe.subscriptions.retrieve(subId)
        const priceId  = sub.items.data[0]?.price.id || ''
        const plan     = subscriptionToPlan(sub.status, priceId)

        await upsertBilling(db, org_id, {
          stripe_customer_id:     session.customer as string,
          stripe_subscription_id: subId,
          stripe_price_id:        priceId,
          subscription_status:    sub.status,
          current_period_start:   new Date(sub.current_period_start * 1000).toISOString(),
          current_period_end:     new Date(sub.current_period_end   * 1000).toISOString(),
        })

        await syncOrgPlan(db, org_id, plan)
        await recordMRRSnapshot(db, org_id, sub.status, priceId)
        console.log(`[webhook] checkout.completed — org ${org_id} → ${plan}`)
        break
      }

      // ── Subscription created / updated ────────────────────────
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub     = event.data.object as Stripe.Subscription
        const org_id  = sub.metadata?.org_id
        if (!org_id) break

        const priceId = sub.items.data[0]?.price.id || ''
        const plan    = subscriptionToPlan(sub.status, priceId)

        await upsertBilling(db, org_id, {
          stripe_customer_id:     sub.customer as string,
          stripe_subscription_id: sub.id,
          stripe_price_id:        priceId,
          subscription_status:    sub.status,
          current_period_start:   new Date(sub.current_period_start * 1000).toISOString(),
          current_period_end:     new Date(sub.current_period_end   * 1000).toISOString(),
          cancel_at_period_end:   sub.cancel_at_period_end,
          canceled_at:            sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
        })

        await syncOrgPlan(db, org_id, plan)
        await recordMRRSnapshot(db, org_id, sub.status, priceId)
        console.log(`[webhook] subscription.${event.type.split('.')[2]} — org ${org_id} → ${plan} (${sub.status})`)
        break
      }

      // ── Subscription deleted (cancelled and expired) ──────────
      case 'customer.subscription.deleted': {
        const sub    = event.data.object as Stripe.Subscription
        const org_id = sub.metadata?.org_id
        if (!org_id) break

        await upsertBilling(db, org_id, {
          subscription_status:  'canceled',
          cancel_at_period_end: false,
          canceled_at:          new Date().toISOString(),
        })

        await syncOrgPlan(db, org_id, 'trial')
        await recordMRRSnapshot(db, org_id, 'canceled', '')
        console.log(`[webhook] subscription.deleted — org ${org_id} → trial`)
        break
      }

      // ── Invoice paid ──────────────────────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice
        const org_id  = (invoice.subscription_details?.metadata as any)?.org_id
                     || (invoice as any).metadata?.org_id
        if (!org_id) break

        await db.from('org_billing').update({
          last_invoice_amount: invoice.amount_paid,
          last_invoice_date:   new Date(invoice.created * 1000).toISOString(),
          last_invoice_url:    invoice.hosted_invoice_url || null,
          subscription_status: 'active',
        }).eq('org_id', org_id)

        // Log payment in audit
        await db.from('audit_log').insert({
          org_id,
          action:   'invoice_payment_succeeded',
          metadata: {
            amount: invoice.amount_paid,
            invoice_id: invoice.id,
          },
        })
        console.log(`[webhook] invoice.paid — org ${org_id} ₹${(invoice.amount_paid / 100).toLocaleString('en-IN')}`)
        break
      }

      // ── Invoice payment failed ────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const org_id  = (invoice.subscription_details?.metadata as any)?.org_id
        if (!org_id) break

        await db.from('org_billing').update({
          subscription_status: 'past_due',
        }).eq('org_id', org_id)

        await syncOrgPlan(db, org_id, 'trial')

        // Fetch owner email and send payment failure notification
        const { data: owner } = await db.from('users')
          .select('email, name')
          .eq('org_id', org_id)
          .eq('role', 'owner')
          .single()

        if (owner?.email) {
          const { Resend } = await import('resend')
          const resend = new Resend(process.env.RESEND_API_KEY)
          await resend.emails.send({
            from:    process.env.RESEND_FROM_EMAIL!,
            to:      owner.email,
            subject: 'Action required — TrialMatch India payment failed',
            html: `
              <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
                <h2 style="color:#B53030;margin:0 0 12px">Payment failed</h2>
                <p style="color:#1C1B18;font-size:14px;line-height:1.6;margin:0 0 16px">
                  Hi ${owner.name || 'there'},<br/><br/>
                  We couldn't process your TrialMatch India subscription payment.
                  Your account has been temporarily downgraded to the free tier.
                </p>
                <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard?tab=billing"
                   style="display:inline-block;background:#0F6E56;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500">
                  Update payment method
                </a>
                <p style="color:#72706A;font-size:12px;margin:16px 0 0">
                  If you need help, reply to this email.
                </p>
              </div>`,
          })
        }

        console.log(`[webhook] invoice.payment_failed — org ${org_id}`)
        break
      }
    }

    return res.json({ received: true })
  } catch (err: any) {
    console.error('[webhook] Handler error:', err)
    return res.status(500).json({ error: 'Webhook handler failed' })
  }
}

// ── MRR Snapshot helper ───────────────────────────────────────
async function recordMRRSnapshot(db: any, org_id: string, status: string, priceId: string) {
  try {
    // Get last invoice amount for this org
    const { data: billing } = await db
      .from('org_billing')
      .select('last_invoice_amount, stripe_price_id')
      .eq('org_id', org_id)
      .single()

    const { data: org } = await db.from('organizations').select('plan').eq('id', org_id).single()

    await db.from('mrr_snapshots').upsert({
      snapshot_date: new Date().toISOString().split('T')[0],
      org_id,
      plan:      org?.plan || 'trial',
      mrr_paise: billing?.last_invoice_amount || 0,
      status,
    }, { onConflict: 'snapshot_date,org_id' })
  } catch(e) {
    console.warn('[webhook] MRR snapshot failed:', e)
  }
}

// ── DB helpers ────────────────────────────────────────────────

async function upsertBilling(db: any, org_id: string, data: Record<string, any>) {
  await db.from('org_billing').upsert(
    { org_id, ...data, updated_at: new Date().toISOString() },
    { onConflict: 'org_id' }
  )
}

async function syncOrgPlan(
  db:     any,
  org_id: string,
  plan:   'trial' | 'starter' | 'pro' | 'enterprise'
) {
  // Was a hardcoded duplicate of lib/plans.ts's PLANS object, kept in
  // sync with it only by whoever remembered to update both places —
  // exactly the kind of silent-drift risk this codebase has run into
  // more than once (see FIXES_2026-07-30.md for another instance).
  // Deriving directly from PLANS means there is now only one place these
  // numbers are ever written.
  const { max_patients, max_users, max_match_jobs_per_month } = PLANS[plan]
  await db.from('organizations')
    .update({ plan, max_patients, max_users, max_match_jobs_per_month })
    .eq('id', org_id)
}
