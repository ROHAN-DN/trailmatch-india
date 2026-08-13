/**
 * lib/stripe.ts
 * Stripe client + billing helper functions.
 *
 * Setup:
 *  1. Create account at https://stripe.com
 *  2. Activate India payments (GST registration recommended)
 *  3. Dashboard → Products → Create two products:
 *       "TrialMatch Starter" — ₹7,999/month recurring
 *       "TrialMatch Pro"     — ₹19,999/month recurring
 *  4. Copy each Price ID → STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO
 *  5. Add env vars (see .env.local.example)
 */

import Stripe from 'stripe'

// Server-side Stripe client (never expose secret key to browser)
// apiVersion must match what the installed `stripe` package (pinned to
// 16.2.0 in package.json) expects in its types — '2024-04-10' doesn't
// compile against this SDK version and would fail `tsc`/`next build`.
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20',
  typescript:  true,
})

// ── Create a Stripe Checkout session ─────────────────────────
export async function createCheckoutSession({
  orgId,
  orgName,
  email,
  priceId,
  successUrl,
  cancelUrl,
  existingCustomerId,
}: {
  orgId:               string
  orgName:             string
  email:               string
  priceId:             string
  successUrl:          string
  cancelUrl:           string
  existingCustomerId?: string
}) {
  const session = await stripe.checkout.sessions.create({
    mode:          'subscription',
    payment_method_types: ['card'],
    customer:      existingCustomerId || undefined,
    customer_email: existingCustomerId ? undefined : email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url:   successUrl,
    cancel_url:    cancelUrl,
    allow_promotion_codes: true,
    billing_address_collection: 'required',
    subscription_data: {
      metadata: { org_id: orgId, org_name: orgName },
    },
    metadata: { org_id: orgId },
    // Collect GST-compatible tax info
    automatic_tax: { enabled: false },   // enable after GST setup
    custom_text: {
      submit: { message: 'You can cancel anytime from your billing dashboard.' },
    },
  })
  return session
}

// ── Create a Stripe Customer Portal session ───────────────────
export async function createPortalSession({
  customerId,
  returnUrl,
}: {
  customerId: string
  returnUrl:  string
}) {
  const session = await stripe.billingPortal.sessions.create({
    customer:   customerId,
    return_url: returnUrl,
  })
  return session
}

// ── Map Stripe subscription status → plan id ──────────────────
export function subscriptionToPlan(
  status: Stripe.Subscription.Status,
  priceId: string
): 'starter' | 'pro' | 'trial' {
  if (status !== 'active' && status !== 'trialing') return 'trial'
  if (priceId === process.env.STRIPE_PRICE_PRO)     return 'pro'
  if (priceId === process.env.STRIPE_PRICE_STARTER) return 'starter'
  return 'trial'
}
