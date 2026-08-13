/**
 * components/BillingAnalyticsPanel.tsx
 *
 * Full billing analytics dashboard:
 *  - MRR KPI cards (total MRR, MoM growth, ARPA, churn rate, conversion rate)
 *  - MRR over time SVG sparkline (90-day history)
 *  - Plan distribution donut + table
 *  - Trial → paid conversion funnel
 *  - Subscription health breakdown
 *  - Upcoming renewals list
 *  - Recent Stripe activity feed
 *  - Churn events table with LTV
 *
 * Pure SVG + inline styles — no external chart library needed.
 */

import { useState, useEffect } from 'react'
import { PLANS, formatPrice } from '../lib/plans'

interface Props { brandColor: string; userRole: string }

const C = {
  teal:   '#0F6E56', tealM:  '#1D9E75', tealL:  '#E1F5EE',
  amber:  '#BA7517', amberL: '#FEF3E2', amberM: '#E8A92A',
  red:    '#A32D2D', redL:   '#FEF0EE',
  blue:   '#1A56CC', blueL:  '#E6F1FB',
  purple: '#6D28D9', purpleL:'#EDE9FE',
  gray:   '#72706A', border: '#E2E0D8', bg:     '#F7F6F2', text:   '#1C1B18',
}

const PLAN_COLORS: Record<string, string> = {
  enterprise: C.purple,
  pro:        C.teal,
  starter:    C.blue,
  trial:      C.gray,
}

function fmt(paise: number) {
  const inr = Math.round(paise / 100)
  if (inr >= 100000) return `₹${(inr / 100000).toFixed(1)}L`
  if (inr >= 1000)   return `₹${(inr / 1000).toFixed(1)}K`
  return `₹${inr.toLocaleString('en-IN')}`
}
function fmtINR(inr: number) {
  if (inr >= 100000) return `₹${(inr / 100000).toFixed(1)}L`
  if (inr >= 1000)   return `₹${(inr / 1000).toFixed(1)}K`
  return `₹${inr.toLocaleString('en-IN')}`
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

export default function BillingAnalyticsPanel({ brandColor, userRole }: Props) {
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  useEffect(() => {
    if (!['owner', 'admin'].includes(userRole)) { setLoading(false); return }
    fetch('/api/analytics/billing')
      .then(r => r.json())
      .then(d => { if (d.error) setError(d.error); else setData(d) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [userRole])

  if (!['owner', 'admin'].includes(userRole)) return (
    <div style={{ padding: '48px', textAlign: 'center', color: C.gray, fontSize: '13px' }}>
      Billing analytics is only available to workspace admins and owners.
    </div>
  )

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px', gap: '12px', color: C.gray }}>
      <div style={{ width: '20px', height: '20px', border: `2px solid ${C.tealL}`, borderTopColor: C.tealM, borderRadius: '50%', animation: 'spin .8s linear infinite' }}/>
      Loading billing analytics…
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  )

  if (error) return (
    <div style={{ padding: '20px', background: C.redL, borderRadius: '10px', color: C.red, fontSize: '13px' }}>
      {error}
    </div>
  )

  const S = data?.summary || {}
  const mrrByPlan: any[]    = data?.mrr_by_plan      || []
  const planDist: any[]     = data?.plan_distribution || []
  const statusCounts: any[] = data?.status_counts     || []
  const churnEvents: any[]  = data?.churn_events      || []
  const conversion: any     = data?.conversion        || {}
  const mrrTimeline: any[]  = data?.mrr_timeline      || []
  const stripeEvents: any[] = data?.stripe_events     || []
  const renewals: any[]     = data?.upcoming_renewals || []
  const charges: any[]      = data?.recent_charges    || []

  const totalMRR   = S.total_mrr_inr    || 0
  const mrrGrowth  = S.mrr_growth_pct   || null
  const subs       = S.paying_subscribers || 0
  const trials     = S.free_trials      || 0
  const churnRate  = S.churn_rate_pct   || 0
  const convRate   = S.conversion_rate_pct || 0
  const arpa       = S.arpa_inr         || 0
  const pastDue    = S.past_due_count   || 0

  return (
    <div style={{ fontFamily: 'sans-serif' }}>

      {/* ── HEADER ───────────────────────────────────────── */}
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ margin: '0 0 3px', fontSize: '17px', fontWeight: '500', color: C.text }}>Billing Analytics</h2>
        <p style={{ margin: 0, fontSize: '13px', color: C.gray }}>MRR, churn, plan distribution, and Stripe activity.</p>
      </div>

      {/* ── KPI CARDS ────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginBottom: '20px' }}>
        <KPICard label="Monthly MRR"          value={fmtINR(totalMRR)}    sub={mrrGrowth !== null ? `${mrrGrowth > 0 ? '▲' : '▼'} ${Math.abs(mrrGrowth)}% MoM` : 'No prior month data'} color={C.teal}  accent={mrrGrowth === null ? undefined : mrrGrowth >= 0 ? C.tealM : C.red}/>
        <KPICard label="Paying subscribers"   value={subs}                sub="active + trialing"         color={C.text}/>
        <KPICard label="Free trials"          value={trials}              sub="not yet converted"         color={C.amber}/>
        <KPICard label="ARPA"                 value={fmtINR(arpa)}        sub="avg revenue per account"  color={C.blue}/>
        <KPICard label="Trial → paid"         value={`${convRate}%`}      sub="conversion rate"           color={C.tealM}/>
        <KPICard label="Monthly churn"        value={`${churnRate}%`}     sub="cancellations this month"  color={churnRate > 5 ? C.red : C.text} accent={churnRate > 5 ? C.red : undefined}/>
        {pastDue > 0 && <KPICard label="Payment failures" value={pastDue} sub="past due — action needed" color={C.red} accent={C.red}/>}
      </div>

      {/* ── MRR CHART + PLAN DISTRIBUTION ────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '12px', marginBottom: '12px' }}>

        {/* MRR over time */}
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', padding: '18px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
            <span style={{ fontSize: '13px', fontWeight: '600', color: C.text }}>MRR over time</span>
            {mrrGrowth !== null && (
              <span style={{ fontSize: '11px', fontWeight: '600', padding: '3px 9px', borderRadius: '99px', background: mrrGrowth >= 0 ? C.tealL : C.redL, color: mrrGrowth >= 0 ? C.teal : C.red }}>
                {mrrGrowth >= 0 ? '▲' : '▼'} {Math.abs(mrrGrowth)}% MoM
              </span>
            )}
          </div>
          {mrrTimeline.length > 1
            ? <MRRChart data={mrrTimeline} brandColor={brandColor}/>
            : <EmptyChart label="Run for 2+ days to see MRR trend" icon="📈"/>}
        </div>

        {/* Plan distribution */}
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', padding: '18px 20px' }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: C.text, marginBottom: '14px' }}>Plan distribution</div>
          {planDist.length > 0
            ? <PlanDistribution plans={planDist}/>
            : <EmptyChart label="No orgs yet" icon="📊"/>}
        </div>
      </div>

      {/* ── CONVERSION FUNNEL + SUBSCRIPTION HEALTH ──────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>

        {/* Conversion funnel */}
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', padding: '18px 20px' }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: C.text, marginBottom: '14px' }}>Trial → paid funnel</div>
          <ConversionFunnel conversion={conversion} trials={trials} subs={subs} churnEvents={churnEvents} brandColor={brandColor}/>
        </div>

        {/* Subscription health */}
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', padding: '18px 20px' }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: C.text, marginBottom: '14px' }}>Subscription health</div>
          <SubscriptionHealth statusCounts={statusCounts} mrrByPlan={mrrByPlan}/>
        </div>
      </div>

      {/* ── MRR BY PLAN TABLE + UPCOMING RENEWALS ────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>

        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', padding: '18px 20px' }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: C.text, marginBottom: '14px' }}>MRR by plan</div>
          {mrrByPlan.length > 0
            ? <MRRByPlanTable plans={mrrByPlan} totalMRR={totalMRR}/>
            : <EmptyChart label="No paid subscriptions yet" icon="💳"/>}
        </div>

        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', padding: '18px 20px' }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: C.text, marginBottom: '14px' }}>Upcoming renewals <span style={{ fontSize: '11px', fontWeight: '400', color: C.gray }}>(next 7 days)</span></div>
          {renewals.length > 0
            ? <RenewalsList renewals={renewals}/>
            : <EmptyChart label="No renewals in the next 7 days" icon="📅"/>}
        </div>
      </div>

      {/* ── CHURN EVENTS TABLE ────────────────────────────── */}
      {churnEvents.length > 0 && (
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', padding: '18px 20px', marginBottom: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: C.text, marginBottom: '14px' }}>Recent churn & at-risk accounts</div>
          <ChurnTable events={churnEvents}/>
        </div>
      )}

      {/* ── STRIPE ACTIVITY FEED ──────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>

        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', padding: '18px 20px' }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: C.text, marginBottom: '14px' }}>Recent Stripe events</div>
          {stripeEvents.length > 0
            ? <StripeEventFeed events={stripeEvents}/>
            : <EmptyChart label="No recent Stripe events" icon="⚡"/>}
        </div>

        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', padding: '18px 20px' }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: C.text, marginBottom: '14px' }}>Recent charges</div>
          {charges.length > 0
            ? <ChargesList charges={charges}/>
            : <EmptyChart label="No charges yet" icon="💳"/>}
        </div>
      </div>

      <p style={{ fontSize: '11px', color: C.gray, lineHeight: '1.6' }}>
        MRR data sourced from Stripe API + daily Supabase snapshots. Churn rate calculated on a 30-day rolling window.
        All amounts in INR excluding GST.
      </p>
    </div>
  )
}

// ── KPI Card ─────────────────────────────────────────────────
function KPICard({ label, value, sub, color, accent }: { label: string; value: any; sub: string; color: string; accent?: string }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${accent ? accent + '44' : C.border}`, borderRadius: '10px', padding: '14px 16px', borderLeft: accent ? `3px solid ${accent}` : undefined }}>
      <div style={{ fontSize: '10px', fontWeight: '600', letterSpacing: '.06em', textTransform: 'uppercase', color: C.gray, marginBottom: '6px' }}>{label}</div>
      <div style={{ fontSize: '22px', fontWeight: '500', color, lineHeight: '1.1', marginBottom: '3px' }}>{value}</div>
      <div style={{ fontSize: '11px', color: C.gray }}>{sub}</div>
    </div>
  )
}

// ── MRR Chart (SVG sparkline with area fill) ─────────────────
function MRRChart({ data, brandColor }: { data: any[]; brandColor: string }) {
  if (data.length < 2) return <EmptyChart label="Not enough data yet" icon="📈"/>

  const W = 560, H = 110, PAD = { t: 10, r: 20, b: 28, l: 52 }
  const cw = W - PAD.l - PAD.r
  const ch = H - PAD.t - PAD.b
  const maxMRR  = Math.max(...data.map(d => d.total_mrr_inr || 0), 1)
  const minMRR  = Math.min(...data.map(d => d.total_mrr_inr || 0))
  const range   = maxMRR - minMRR || 1
  const xStep   = cw / Math.max(data.length - 1, 1)

  const pts = data.map((d, i) => ({
    x:    PAD.l + i * xStep,
    y:    PAD.t + ch - ((d.total_mrr_inr - minMRR) / range) * ch,
    mrr:  d.total_mrr_inr,
    date: d.snapshot_date,
  }))

  const linePath  = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const areaPath  = `${linePath} L${pts[pts.length-1].x},${PAD.t+ch} L${pts[0].x},${PAD.t+ch} Z`

  // X-axis labels: show every ~10th point
  const labelStep = Math.max(1, Math.floor(data.length / 6))

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', overflow: 'visible' }} role="img" aria-label="MRR over time">
      <title>MRR over time</title>
      <defs>
        <linearGradient id="mrrGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={brandColor} stopOpacity="0.18"/>
          <stop offset="100%" stopColor={brandColor} stopOpacity="0.01"/>
        </linearGradient>
      </defs>

      {/* Y-axis grid */}
      {[0, 0.5, 1].map(f => {
        const y = PAD.t + ch * (1 - f)
        const v = minMRR + range * f
        return (
          <g key={f}>
            <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke={C.border} strokeWidth=".5" strokeDasharray={f === 0 ? 'none' : '3,3'}/>
            <text x={PAD.l - 5} y={y + 4} textAnchor="end" fontSize="9" fill={C.gray}>{fmtINR(v)}</text>
          </g>
        )
      })}

      {/* Area fill */}
      <path d={areaPath} fill="url(#mrrGrad)"/>

      {/* Line */}
      <path d={linePath} fill="none" stroke={brandColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>

      {/* Data points */}
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3" fill={brandColor} stroke="#fff" strokeWidth="1.5"/>
      ))}

      {/* X labels */}
      {pts.filter((_, i) => i % labelStep === 0 || i === pts.length - 1).map((p, i) => (
        <text key={i} x={p.x} y={H - 4} textAnchor="middle" fontSize="8.5" fill={C.gray}>
          {new Date(p.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
        </text>
      ))}
    </svg>
  )
}

// ── Plan Distribution ─────────────────────────────────────────
function PlanDistribution({ plans }: { plans: any[] }) {
  const total = plans.reduce((a, p) => a + p.org_count, 0) || 1
  return (
    <div>
      {plans.map((p: any) => {
        const color = PLAN_COLORS[p.plan] || C.gray
        const pct   = Math.round((p.org_count / total) * 100)
        return (
          <div key={p.plan} style={{ marginBottom: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }}/>
                <span style={{ fontSize: '12px', fontWeight: '500', color: C.text, textTransform: 'capitalize' }}>{p.plan}</span>
              </div>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', color: C.gray }}>{p.org_count} org{p.org_count !== 1 ? 's' : ''}</span>
                {p.paying_count > 0 && (
                  <span style={{ fontSize: '10px', fontWeight: '600', padding: '1px 7px', borderRadius: '99px', background: C.tealL, color: C.teal }}>{p.paying_count} paying</span>
                )}
                <span style={{ fontSize: '12px', fontWeight: '600', color: C.text, minWidth: '30px', textAlign: 'right' }}>{pct}%</span>
              </div>
            </div>
            <div style={{ height: '6px', background: C.bg, borderRadius: '99px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '99px', transition: 'width .8s ease' }}/>
            </div>
          </div>
        )
      })}

      {/* Free-to-paid ratio summary */}
      <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: `1px solid ${C.border}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        {[
          { l: 'Total orgs',  v: plans.reduce((a, p) => a + p.org_count, 0) },
          { l: 'Paying',      v: plans.reduce((a, p) => a + (p.paying_count || 0), 0) },
        ].map(s => (
          <div key={s.l} style={{ background: C.bg, borderRadius: '7px', padding: '8px 10px' }}>
            <div style={{ fontSize: '10px', color: C.gray, marginBottom: '2px' }}>{s.l}</div>
            <div style={{ fontSize: '16px', fontWeight: '500', color: C.text }}>{s.v}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Conversion Funnel ─────────────────────────────────────────
function ConversionFunnel({ conversion, trials, subs, churnEvents, brandColor }: any) {
  const churned = churnEvents.length
  const steps = [
    { label: 'Signed up (free trial)',      val: trials + subs + churned, color: C.border  },
    { label: 'Active on free trial',        val: trials,                  color: C.amberM  },
    { label: 'Converted to paid',           val: subs,                    color: brandColor },
    { label: 'Retained (active)',           val: subs,                    color: C.tealM   },
  ]
  const max = steps[0].val || 1

  return (
    <div>
      {steps.map((s, i) => {
        const pct      = Math.round((s.val / max) * 100)
        const prevVal  = i > 0 ? steps[i - 1].val : null
        const convRate = prevVal ? Math.round((s.val / prevVal) * 100) : null
        return (
          <div key={s.label} style={{ marginBottom: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', color: C.text }}>{s.label}</span>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                {convRate !== null && (
                  <span style={{ fontSize: '10px', color: C.gray }}>{convRate}% step rate</span>
                )}
                <span style={{ fontSize: '13px', fontWeight: '600', color: s.color === C.border ? C.text : s.color, minWidth: '24px', textAlign: 'right' }}>{s.val}</span>
              </div>
            </div>
            <div style={{ height: '7px', background: C.bg, borderRadius: '99px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: s.color === C.border ? '#D3D1C7' : s.color, borderRadius: '99px', transition: 'width .8s ease' }}/>
            </div>
          </div>
        )
      })}

      <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: `1px solid ${C.border}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        {[
          { l: 'Overall conversion', v: `${conversion?.conversion_rate_pct || 0}%` },
          { l: 'Monthly churn',      v: `${conversion?.monthly_churn_rate_pct || 0}%` },
        ].map(s => (
          <div key={s.l} style={{ background: C.bg, borderRadius: '7px', padding: '8px 10px' }}>
            <div style={{ fontSize: '10px', color: C.gray, marginBottom: '2px' }}>{s.l}</div>
            <div style={{ fontSize: '16px', fontWeight: '500', color: C.text }}>{s.v}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Subscription Health ───────────────────────────────────────
function SubscriptionHealth({ statusCounts, mrrByPlan }: { statusCounts: any[]; mrrByPlan: any[] }) {
  const statusConfig: Record<string, { color: string; bg: string; label: string }> = {
    active:     { color: C.teal,  bg: C.tealL,   label: 'Active'     },
    trialing:   { color: C.blue,  bg: C.blueL,   label: 'Trialing'   },
    past_due:   { color: C.red,   bg: C.redL,    label: 'Past due'   },
    canceled:   { color: C.gray,  bg: C.bg,      label: 'Cancelled'  },
    incomplete: { color: C.amber, bg: C.amberL,  label: 'Incomplete' },
    none:       { color: C.gray,  bg: C.bg,      label: 'No sub'     },
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '16px' }}>
        {statusCounts.map((sc: any) => {
          const cfg = statusConfig[sc.subscription_status] || statusConfig.none
          return (
            <div key={sc.subscription_status} style={{ background: cfg.bg, borderRadius: '8px', padding: '10px 12px', border: `1px solid ${cfg.color}22` }}>
              <div style={{ fontSize: '10px', fontWeight: '600', color: cfg.color, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: '4px' }}>{cfg.label}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: '20px', fontWeight: '500', color: cfg.color }}>{sc.count}</span>
                <span style={{ fontSize: '11px', color: C.gray }}>{sc.pct}%</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* MRR split */}
      {mrrByPlan.length > 0 && (
        <div>
          <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '.06em', color: C.gray, marginBottom: '8px' }}>MRR split</div>
          <div style={{ height: '10px', borderRadius: '99px', overflow: 'hidden', display: 'flex', marginBottom: '8px' }}>
            {mrrByPlan.map((p: any) => (
              <div key={p.plan} title={`${p.plan}: ${p.mrr_pct}%`} style={{ height: '100%', width: `${p.mrr_pct}%`, background: PLAN_COLORS[p.plan] || C.gray, transition: 'width .8s' }}/>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            {mrrByPlan.map((p: any) => (
              <div key={p.plan} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: PLAN_COLORS[p.plan] || C.gray, flexShrink: 0, display: 'inline-block' }}/>
                <span style={{ color: C.text, textTransform: 'capitalize' }}>{p.plan}</span>
                <span style={{ color: C.gray }}>{fmtINR(p.mrr_inr)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── MRR By Plan Table ─────────────────────────────────────────
function MRRByPlanTable({ plans, totalMRR }: { plans: any[]; totalMRR: number }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
      <thead>
        <tr style={{ background: C.bg }}>
          {['Plan', 'Subscribers', 'MRR', 'ARPA', '% of MRR'].map(h => (
            <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontSize: '10px', fontWeight: '600', letterSpacing: '.06em', textTransform: 'uppercase', color: C.gray }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {plans.map((p: any) => (
          <tr key={p.plan} style={{ borderTop: `1px solid ${C.border}` }}>
            <td style={{ padding: '9px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: PLAN_COLORS[p.plan] || C.gray, flexShrink: 0 }}/>
                <span style={{ fontWeight: '500', color: C.text, textTransform: 'capitalize' }}>{p.plan}</span>
              </div>
            </td>
            <td style={{ padding: '9px 10px', color: C.text }}>{p.subscribers}</td>
            <td style={{ padding: '9px 10px', fontWeight: '600', color: C.teal }}>{fmtINR(p.mrr_inr)}</td>
            <td style={{ padding: '9px 10px', color: C.gray }}>{fmtINR(p.arpa_inr)}</td>
            <td style={{ padding: '9px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <div style={{ flex: 1, height: '5px', background: C.bg, borderRadius: '99px', overflow: 'hidden', minWidth: '40px' }}>
                  <div style={{ height: '100%', width: `${p.mrr_pct}%`, background: PLAN_COLORS[p.plan] || C.gray, borderRadius: '99px' }}/>
                </div>
                <span style={{ fontSize: '11px', color: C.text, flexShrink: 0 }}>{p.mrr_pct}%</span>
              </div>
            </td>
          </tr>
        ))}
        <tr style={{ borderTop: `2px solid ${C.border}`, background: C.bg }}>
          <td colSpan={2} style={{ padding: '9px 10px', fontWeight: '600', color: C.text, fontSize: '11px' }}>TOTAL</td>
          <td style={{ padding: '9px 10px', fontWeight: '600', color: C.teal }}>{fmtINR(totalMRR)}</td>
          <td colSpan={2}/>
        </tr>
      </tbody>
    </table>
  )
}

// ── Upcoming Renewals ─────────────────────────────────────────
function RenewalsList({ renewals }: { renewals: any[] }) {
  return (
    <div>
      {renewals.map((r: any, i: number) => {
        const daysUntil = Math.ceil((new Date(r.renews_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        return (
          <div key={r.subscription_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: i < renewals.length - 1 ? `1px solid ${C.bg}` : 'none' }}>
            <div>
              <div style={{ fontSize: '12px', fontWeight: '500', color: C.text }}>{r.customer_email || 'Customer'}</div>
              <div style={{ fontSize: '11px', color: C.gray, marginTop: '1px' }}>Renews {fmtDate(r.renews_at)}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '13px', fontWeight: '600', color: C.teal }}>{fmt(r.amount)}</div>
              <span style={{ fontSize: '10px', fontWeight: '600', padding: '2px 7px', borderRadius: '99px', background: daysUntil <= 2 ? C.amberL : C.tealL, color: daysUntil <= 2 ? C.amber : C.teal }}>
                {daysUntil}d
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Churn Events Table ────────────────────────────────────────
function ChurnTable({ events }: { events: any[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
      <thead>
        <tr style={{ background: C.bg }}>
          {['Organisation', 'Status', 'Last MRR', 'LTV (est.)', 'Months', 'Cancelled'].map(h => (
            <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontSize: '10px', fontWeight: '600', letterSpacing: '.06em', textTransform: 'uppercase', color: C.gray, whiteSpace: 'nowrap' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {events.map((e: any, i: number) => {
          const ltv     = Math.round((e.last_mrr_inr || 0) * (e.months_as_customer || 1))
          const statusC = e.subscription_status === 'canceled' ? C.red : e.cancel_at_period_end ? C.amber : C.gray
          const statusL = e.cancel_at_period_end ? 'Cancels soon' : e.subscription_status
          return (
            <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
              <td style={{ padding: '9px 10px', fontWeight: '500', color: C.text }}>{e.org_name || 'Unknown'}</td>
              <td style={{ padding: '9px 10px' }}>
                <span style={{ fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '99px', background: statusC + '18', color: statusC, textTransform: 'capitalize' }}>{statusL}</span>
              </td>
              <td style={{ padding: '9px 10px', color: C.text }}>{fmtINR(e.last_mrr_inr || 0)}</td>
              <td style={{ padding: '9px 10px', color: C.teal, fontWeight: '500' }}>{fmtINR(ltv)}</td>
              <td style={{ padding: '9px 10px', color: C.gray }}>{e.months_as_customer || '—'}</td>
              <td style={{ padding: '9px 10px', color: C.gray, fontSize: '11px' }}>{e.canceled_at ? fmtDate(e.canceled_at) : '—'}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ── Stripe Event Feed ─────────────────────────────────────────
function StripeEventFeed({ events }: { events: any[] }) {
  const EVENT_META: Record<string, { icon: string; label: string; color: string }> = {
    'customer.subscription.created':  { icon: '🎉', label: 'New subscription',   color: C.teal  },
    'customer.subscription.updated':  { icon: '🔄', label: 'Subscription updated', color: C.blue },
    'customer.subscription.deleted':  { icon: '❌', label: 'Subscription cancelled', color: C.red },
    'invoice.payment_failed':         { icon: '⚠️', label: 'Payment failed',     color: C.amber },
  }

  return (
    <div>
      {events.map((e: any, i: number) => {
        const meta = EVENT_META[e.type] || { icon: '⚡', label: e.type, color: C.gray }
        return (
          <div key={e.id} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '8px 0', borderBottom: i < events.length - 1 ? `1px solid ${C.bg}` : 'none' }}>
            <span style={{ fontSize: '16px', flexShrink: 0, marginTop: '1px' }}>{meta.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '12px', fontWeight: '500', color: meta.color }}>{meta.label}</div>
              <div style={{ fontSize: '11px', color: C.gray, marginTop: '1px' }}>
                {fmtDate(e.created)} at {fmtTime(e.created)}
                {e.amount ? ` · ${fmt(e.amount)}` : ''}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Charges List ──────────────────────────────────────────────
function ChargesList({ charges }: { charges: any[] }) {
  return (
    <div>
      {charges.map((c: any, i: number) => (
        <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: i < charges.length - 1 ? `1px solid ${C.bg}` : 'none' }}>
          <div>
            <div style={{ fontSize: '12px', fontWeight: '500', color: C.text }}>Charge {c.id.slice(-8)}</div>
            <div style={{ fontSize: '11px', color: C.gray, marginTop: '1px' }}>{fmtDate(c.created)}</div>
          </div>
          <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: '600', color: C.teal }}>{fmt(c.amount)}</span>
            {c.receipt_url && (
              <a href={c.receipt_url} target="_blank" rel="noreferrer" style={{ fontSize: '11px', color: C.blue, textDecoration: 'none', padding: '2px 7px', background: C.blueL, borderRadius: '4px' }}>Receipt ↗</a>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────
function EmptyChart({ label, icon }: { label: string; icon: string }) {
  return (
    <div style={{ padding: '28px 20px', textAlign: 'center', color: C.gray, fontSize: '13px' }}>
      <div style={{ fontSize: '26px', marginBottom: '8px', opacity: .5 }}>{icon}</div>
      {label}
    </div>
  )
}
