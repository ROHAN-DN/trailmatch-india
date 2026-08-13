/**
 * components/BillingPanel.tsx
 * Full billing UI — pricing cards, current plan status,
 * upgrade/downgrade, Stripe portal, invoice history.
 */

import { useState, useEffect } from 'react'
import { PLAN_LIST, formatPrice, type Plan } from '../lib/plans'

interface Props { brandColor: string; userRole: string }

export default function BillingPanel({ brandColor, userRole }: Props) {
  const [data,       setData]       = useState<any>(null)
  const [loading,    setLoading]    = useState(true)
  const [upgrading,  setUpgrading]  = useState<string | null>(null)
  const [portalLoad, setPortalLoad] = useState(false)
  const [msg,        setMsg]        = useState<{ text: string; ok: boolean } | null>(null)

  useEffect(() => {
    fetch('/api/billing')
      .then(r => r.json())
      .then(setData)
      .finally(() => setLoading(false))

    // Show success/cancel flash from URL params
    const params = new URLSearchParams(window.location.search)
    if (params.get('billing') === 'success') {
      setMsg({ text: '🎉 Subscription activated! Your plan has been upgraded.', ok: true })
      window.history.replaceState({}, '', window.location.pathname)
    } else if (params.get('billing') === 'cancelled') {
      setMsg({ text: 'Checkout was cancelled — no changes were made.', ok: false })
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  async function upgrade(planId: string) {
    setUpgrading(planId); setMsg(null)
    const r = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: planId }),
    })
    const d = await r.json()
    if (r.ok && d.url) {
      window.location.href = d.url
    } else {
      setMsg({ text: d.error || 'Failed to start checkout.', ok: false })
      setUpgrading(null)
    }
  }

  async function openPortal() {
    setPortalLoad(true); setMsg(null)
    const r = await fetch('/api/billing/portal', { method: 'POST' })
    const d = await r.json()
    if (r.ok && d.url) {
      window.location.href = d.url
    } else {
      setMsg({ text: d.error || 'Failed to open billing portal.', ok: false })
      setPortalLoad(false)
    }
  }

  const S = {
    card:    { background: '#fff', border: '1px solid #E2E0D8', borderRadius: '10px', padding: '20px 22px', marginBottom: '14px' } as any,
    label:   { fontSize: '10px', fontWeight: '600', letterSpacing: '.06em', textTransform: 'uppercase', color: '#72706A' } as any,
    btn:     (primary = true, disabled = false) => ({
      padding: '9px 18px', fontFamily: 'sans-serif', fontSize: '13px', fontWeight: '500',
      cursor: disabled ? 'not-allowed' : 'pointer', borderRadius: '8px', transition: 'all .15s',
      opacity: disabled ? 0.5 : 1,
      background: primary ? brandColor : '#fff',
      color:      primary ? '#fff' : '#1C1B18',
      border:     primary ? 'none' : '1px solid #E2E0D8',
    }) as any,
  }

  if (loading) return <div style={{ padding: '40px', textAlign: 'center', color: '#72706A' }}>Loading…</div>
  if (!data)   return <div style={{ padding: '40px', textAlign: 'center', color: '#A32D2D' }}>Failed to load billing data.</div>

  const currentPlanId = data.plan?.id || 'trial'
  const billing       = data.billing
  const usage         = data.usage
  const invoices      = data.invoices || []

  const isActive   = ['active', 'trialing'].includes(billing?.subscription_status)
  const isPastDue  = billing?.subscription_status === 'past_due'
  const cancelAtEnd = billing?.cancel_at_period_end

  return (
    <div>
      <h2 style={{ margin: '0 0 4px', fontSize: '17px', fontWeight: '500' }}>Billing & Plan</h2>
      <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#72706A', lineHeight: '1.5' }}>
        Manage your subscription, view invoices, and upgrade your plan.
      </p>

      {msg && (
        <div style={{ padding: '12px 16px', borderRadius: '8px', marginBottom: '16px', fontSize: '13px', background: msg.ok ? '#EAF3DE' : '#FEF0EE', color: msg.ok ? '#27500A' : '#A32D2D', border: `1px solid ${msg.ok ? 'rgba(39,80,10,.2)' : 'rgba(165,45,45,.2)'}` }}>
          {msg.text}
        </div>
      )}

      {/* ── CURRENT PLAN STATUS ──────────────────────────── */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <div style={S.label}>Current plan</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' }}>
              <span style={{ fontSize: '22px', fontWeight: '500', color: brandColor }}>{data.plan?.name}</span>
              <StatusBadge status={billing?.subscription_status || 'none'} cancelAtEnd={cancelAtEnd}/>
            </div>
            {billing?.current_period_end && isActive && (
              <div style={{ fontSize: '12px', color: '#72706A', marginTop: '4px' }}>
                {cancelAtEnd
                  ? `⚠️ Cancels on ${new Date(billing.current_period_end).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}`
                  : `Renews on ${new Date(billing.current_period_end).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}`
                }
              </div>
            )}
            {isPastDue && (
              <div style={{ fontSize: '12px', color: '#B53030', marginTop: '4px', fontWeight: '500' }}>
                ⚠️ Payment failed — update your payment method to restore access
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {(isActive || isPastDue) && ['owner', 'admin'].includes(userRole) && (
              <button
                style={S.btn(false, portalLoad)}
                disabled={portalLoad}
                onClick={openPortal}
              >
                {portalLoad ? 'Opening…' : '⚙ Manage billing'}
              </button>
            )}
          </div>
        </div>

        {/* Usage bars */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginTop: '18px' }}>
          <UsageBar label="Patients" current={usage.patients} max={usage.patients_max} color={brandColor}/>
          <UsageBar label="Team members" current={usage.users} max={usage.users_max} color={brandColor}/>
        </div>
      </div>

      {/* ── PRICING PLANS ────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginBottom: '20px' }}>
        {PLAN_LIST.filter(p => p.id !== 'enterprise').map(plan => (
          <PlanCard
            key={plan.id}
            plan={plan}
            isCurrent={plan.id === currentPlanId}
            isUpgrade={comparePlans(currentPlanId, plan.id) === 'upgrade'}
            brandColor={brandColor}
            loading={upgrading === plan.id}
            canManage={['owner', 'admin'].includes(userRole)}
            onSelect={() => upgrade(plan.id)}
          />
        ))}

        {/* Enterprise card */}
        <div style={{ background: '#1C1B18', border: '1px solid #1C1B18', borderRadius: '10px', padding: '20px 18px' }}>
          <div style={{ fontSize: '15px', fontWeight: '500', color: '#fff', marginBottom: '4px' }}>Enterprise</div>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,.5)', marginBottom: '14px' }}>Custom contracts</div>
          <div style={{ fontSize: '20px', fontWeight: '500', color: '#9FE1CB', marginBottom: '16px' }}>Custom</div>
          {['EHR / FHIR integration', 'Dedicated onboarding', 'DPDP compliance review', 'On-premise option'].map(f => (
            <div key={f} style={{ display: 'flex', gap: '7px', marginBottom: '7px', fontSize: '12px', color: 'rgba(255,255,255,.7)' }}>
              <span style={{ color: '#9FE1CB', flexShrink: 0 }}>✓</span>{f}
            </div>
          ))}
          <a
            href="mailto:sales@trialmatch.in?subject=Enterprise enquiry"
            style={{ display: 'block', marginTop: '16px', padding: '9px', background: 'rgba(255,255,255,.1)', color: '#fff', borderRadius: '7px', textAlign: 'center', fontSize: '13px', fontWeight: '500', textDecoration: 'none', border: '1px solid rgba(255,255,255,.2)' }}
          >
            Contact sales
          </a>
        </div>
      </div>

      {/* ── INVOICE HISTORY ──────────────────────────────── */}
      {invoices.length > 0 && (
        <div style={S.card}>
          <div style={{ fontSize: '13px', fontWeight: '600', marginBottom: '14px' }}>Invoice history</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: '#F7F6F2' }}>
                {['Date', 'Amount', 'Status', 'Invoice'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: '10px', fontWeight: '600', letterSpacing: '.06em', textTransform: 'uppercase', color: '#72706A' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv: any) => (
                <tr key={inv.id} style={{ borderTop: '1px solid #E2E0D8' }}>
                  <td style={{ padding: '10px 12px', color: '#1C1B18' }}>
                    {new Date(inv.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </td>
                  <td style={{ padding: '10px 12px', fontWeight: '500', color: '#1C1B18' }}>
                    ₹{(inv.amount / 100).toLocaleString('en-IN')}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ background: inv.status === 'paid' ? '#EAF3DE' : '#FEF0EE', color: inv.status === 'paid' ? '#27500A' : '#A32D2D', fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '99px', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                      {inv.status}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {inv.pdf_url    && <a href={inv.pdf_url}    target="_blank" rel="noreferrer" style={{ color: brandColor, fontSize: '12px', fontWeight: '500' }}>PDF ↗</a>}
                      {inv.hosted_url && <a href={inv.hosted_url} target="_blank" rel="noreferrer" style={{ color: '#72706A', fontSize: '12px' }}>View ↗</a>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontSize: '11px', color: '#B4B2A9', lineHeight: '1.6', marginTop: '8px' }}>
        Payments processed securely by Stripe. Cancel anytime — access continues until end of billing period.
        Prices exclude GST where applicable.
      </p>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────

function StatusBadge({ status, cancelAtEnd }: { status: string; cancelAtEnd?: boolean }) {
  if (cancelAtEnd) return <span style={{ background: '#FEF3E2', color: '#BA7517', fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '99px', textTransform: 'uppercase', letterSpacing: '.04em' }}>Cancels soon</span>
  const map: Record<string, [string, string]> = {
    active:    ['#EAF3DE', '#27500A'],
    trialing:  ['#E6F1FB', '#1A56CC'],
    past_due:  ['#FEF0EE', '#A32D2D'],
    canceled:  ['#F3F2EF', '#72706A'],
    none:      ['#F3F2EF', '#72706A'],
  }
  const [bg, color] = map[status] || map.none
  const labels: Record<string, string> = { active: 'Active', trialing: 'Trialing', past_due: 'Past due', canceled: 'Canceled', none: 'Free' }
  return <span style={{ background: bg, color, fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '99px', textTransform: 'uppercase', letterSpacing: '.04em' }}>{labels[status] || status}</span>
}

function UsageBar({ label, current, max, color }: { label: string; current: number; max: number; color: string }) {
  const pct      = max === -1 ? 0 : Math.min(Math.round((current / max) * 100), 100)
  const isLimit  = max !== -1 && current >= max
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '5px' }}>
        <span style={{ color: '#72706A' }}>{label}</span>
        <span style={{ color: isLimit ? '#A32D2D' : '#1C1B18', fontWeight: '500' }}>
          {current} / {max === -1 ? '∞' : max}
        </span>
      </div>
      <div style={{ height: '5px', background: '#E2E0D8', borderRadius: '99px', overflow: 'hidden' }}>
        {max !== -1 && (
          <div style={{ height: '100%', width: `${pct}%`, background: isLimit ? '#A32D2D' : color, borderRadius: '99px', transition: 'width .5s' }}/>
        )}
      </div>
    </div>
  )
}

function PlanCard({ plan, isCurrent, isUpgrade, brandColor, loading, canManage, onSelect }: {
  plan: Plan; isCurrent: boolean; isUpgrade: boolean; brandColor: string;
  loading: boolean; canManage: boolean; onSelect: () => void
}) {
  return (
    <div style={{
      background: '#fff',
      border: `${isCurrent ? 2 : 1}px solid ${isCurrent ? brandColor : plan.highlight ? '#1D9E75' : '#E2E0D8'}`,
      borderRadius: '10px', padding: '20px 18px', position: 'relative',
    }}>
      {plan.highlight && !isCurrent && (
        <div style={{ position: 'absolute', top: '-11px', left: '50%', transform: 'translateX(-50%)', background: '#1D9E75', color: '#fff', fontSize: '10px', fontWeight: '600', padding: '2px 10px', borderRadius: '99px', letterSpacing: '.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
          Most popular
        </div>
      )}
      {isCurrent && (
        <div style={{ position: 'absolute', top: '-11px', right: '14px', background: brandColor, color: '#fff', fontSize: '10px', fontWeight: '600', padding: '2px 10px', borderRadius: '99px', letterSpacing: '.06em', textTransform: 'uppercase' }}>
          Current plan
        </div>
      )}
      <div style={{ fontSize: '15px', fontWeight: '500', color: '#1C1B18', marginBottom: '2px' }}>{plan.name}</div>
      <div style={{ fontSize: '11px', color: '#72706A', marginBottom: '12px' }}>{plan.tagline}</div>
      <div style={{ fontSize: '22px', fontWeight: '500', color: brandColor, marginBottom: '16px' }}>{formatPrice(plan.price_inr)}</div>

      {plan.features.slice(0, 5).map(f => (
        <div key={f} style={{ display: 'flex', gap: '7px', marginBottom: '6px', fontSize: '12px', color: '#1C1B18' }}>
          <span style={{ color: '#1D9E75', flexShrink: 0, fontWeight: '600' }}>✓</span>{f}
        </div>
      ))}

      <button
        disabled={isCurrent || loading || !canManage || plan.price_inr === 0}
        onClick={onSelect}
        style={{
          width: '100%', marginTop: '16px', padding: '9px',
          background: isCurrent ? '#F7F6F2' : isUpgrade ? brandColor : '#fff',
          color: isCurrent ? '#72706A' : isUpgrade ? '#fff' : '#1C1B18',
          border: isCurrent ? 'none' : isUpgrade ? 'none' : '1px solid #E2E0D8',
          borderRadius: '7px', fontSize: '13px', fontWeight: '500',
          cursor: isCurrent || !canManage || plan.price_inr === 0 ? 'default' : 'pointer',
          fontFamily: 'sans-serif', opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? 'Redirecting…' : isCurrent ? 'Current plan' : isUpgrade ? `Upgrade to ${plan.name}` : `Downgrade to ${plan.name}`}
      </button>
    </div>
  )
}

function comparePlans(current: string, target: string): 'upgrade' | 'downgrade' | 'same' {
  const order = ['trial', 'starter', 'pro', 'enterprise']
  const ci    = order.indexOf(current)
  const ti    = order.indexOf(target)
  if (ti > ci) return 'upgrade'
  if (ti < ci) return 'downgrade'
  return 'same'
}
