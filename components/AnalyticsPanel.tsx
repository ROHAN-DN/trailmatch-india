/**
 * components/AnalyticsPanel.tsx
 * Full analytics dashboard — KPI cards, match rate by condition,
 * recruitment funnel, jobs-over-time sparklines, top trials table,
 * patient demographics.
 *
 * Uses zero external chart libraries — pure SVG + CSS.
 */

import { useState, useEffect } from 'react'

interface Props { brandColor: string }

// ── Colour palette ────────────────────────────────────────────
const C = {
  teal:   '#0F6E56',
  tealM:  '#1D9E75',
  tealL:  '#E1F5EE',
  amber:  '#BA7517',
  amberL: '#FEF3E2',
  red:    '#A32D2D',
  redL:   '#FEF0EE',
  blue:   '#1A56CC',
  blueL:  '#E6F1FB',
  gray:   '#72706A',
  border: '#E2E0D8',
  bg:     '#F7F6F2',
  text:   '#1C1B18',
}

export default function AnalyticsPanel({ brandColor }: Props) {
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [range,   setRange]   = useState<'4w' | '8w' | '12w'>('8w')

  useEffect(() => {
    fetch('/api/analytics')
      .then(r => r.json())
      .then(d => { if (d.error) setError(d.error); else setData(d) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:'60px', gap:'12px', color: C.gray }}>
      <div style={{ width:'20px', height:'20px', border:`2px solid ${C.tealL}`, borderTopColor: C.tealM, borderRadius:'50%', animation:'spin .8s linear infinite' }}/>
      Loading analytics…
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  )

  if (error) return (
    <div style={{ padding:'20px', background: C.redL, borderRadius:'10px', color: C.red, fontSize:'13px' }}>
      Failed to load analytics: {error}
    </div>
  )

  const S = data?.summary || {}
  const funnel = data?.funnel || {}
  const conditions: any[] = data?.conditions || []
  const topTrials: any[]  = data?.top_trials  || []
  const timeline: any[]   = data?.timeline    || []
  const demographics: any[] = data?.demographics || []
  const enrollFunnel = data?.enrollment_funnel || {}

  // Filter timeline by selected range
  const weeksBack = range === '4w' ? 4 : range === '8w' ? 8 : 12
  const filteredTimeline = timeline.slice(-weeksBack)

  return (
    <div style={{ fontFamily:'sans-serif' }}>

      {/* ── HEADER ─────────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'20px', flexWrap:'wrap', gap:'10px' }}>
        <div>
          <h2 style={{ margin:'0 0 3px', fontSize:'17px', fontWeight:'500', color: C.text }}>Analytics</h2>
          <p style={{ margin:0, fontSize:'13px', color: C.gray }}>Match performance, funnel metrics, and usage over time.</p>
        </div>
        <div style={{ display:'flex', gap:'6px' }}>
          {(['4w','8w','12w'] as const).map(r => (
            <button key={r} onClick={() => setRange(r)} style={{ padding:'6px 12px', fontSize:'12px', fontWeight:'500', cursor:'pointer', borderRadius:'7px', fontFamily:'sans-serif', background: range===r ? brandColor : '#fff', color: range===r ? '#fff' : C.gray, border: range===r ? 'none' : `1px solid ${C.border}`, transition:'all .15s' }}>
              {r === '4w' ? '4 weeks' : r === '8w' ? '8 weeks' : '12 weeks'}
            </button>
          ))}
        </div>
      </div>

      {/* ── KPI CARDS ──────────────────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))', gap:'10px', marginBottom:'20px' }}>
        {[
          { label:'Total patients',   val: S.total_patients   || 0,   color: C.text,  sub: 'in your workspace'     },
          { label:'Match jobs run',   val: S.total_jobs       || 0,   color: C.text,  sub: 'all time'              },
          { label:'Strong matches',   val: S.total_strong     || 0,   color: C.teal,  sub: 'across all patients'   },
          { label:'Avg match score',  val: S.avg_match_score  ? `${S.avg_match_score}%` : '—', color: C.teal, sub: 'top match per patient' },
          { label:'Jobs this month',  val: S.jobs_this_month  || 0,   color: C.amber, sub: 'current month'         },
          { label:'Top condition',    val: S.top_condition    || '—', color: C.blue,  sub: 'most patients'         },
        ].map(k => (
          <div key={k.label} style={{ background:'#fff', border:`1px solid ${C.border}`, borderRadius:'10px', padding:'14px 16px' }}>
            <div style={{ fontSize:'10px', fontWeight:'600', letterSpacing:'.06em', textTransform:'uppercase', color: C.gray, marginBottom:'6px' }}>{k.label}</div>
            <div style={{ fontSize:'22px', fontWeight:'500', color: k.color, lineHeight:'1.1', marginBottom:'3px' }}>{k.val}</div>
            <div style={{ fontSize:'11px', color: C.gray }}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* ── ENROLLMENT CONVERSION FUNNEL ──────────────────── */}
      <div style={{ background:'#fff', border:`1px solid ${C.border}`, borderRadius:'10px', padding:'18px 20px', marginBottom:'12px' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'14px' }}>
          <span style={{ fontSize:'13px', fontWeight:'600', color: C.text }}>Match → enrollment conversion</span>
          <span style={{ fontSize:'10px', color: C.gray }}>This is your proof of accuracy — share with prospects</span>
        </div>
        {(enrollFunnel.total_matched || 0) > 0 ? (
          <EnrollmentConversionFunnel data={enrollFunnel} brandColor={brandColor}/>
        ) : (
          <EmptyState label="Run matches and update enrollment status to see conversion data here"/>
        )}
      </div>

      {/* ── ROW 1: FUNNEL + CONDITION CHART ────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'320px 1fr', gap:'12px', marginBottom:'12px' }}>

        {/* Recruitment funnel */}
        <div style={{ background:'#fff', border:`1px solid ${C.border}`, borderRadius:'10px', padding:'18px 20px' }}>
          <div style={{ fontSize:'12px', fontWeight:'600', color: C.text, marginBottom:'14px' }}>Recruitment funnel</div>
          {funnel ? (
            <FunnelChart funnel={funnel} brandColor={brandColor}/>
          ) : (
            <EmptyState label="Run matches to see funnel data"/>
          )}
        </div>

        {/* Match rate by condition */}
        <div style={{ background:'#fff', border:`1px solid ${C.border}`, borderRadius:'10px', padding:'18px 20px' }}>
          <div style={{ fontSize:'12px', fontWeight:'600', color: C.text, marginBottom:'14px' }}>Match rate by condition</div>
          {conditions.length > 0 ? (
            <ConditionChart conditions={conditions} brandColor={brandColor}/>
          ) : (
            <EmptyState label="No match data yet"/>
          )}
        </div>
      </div>

      {/* ── ROW 2: JOBS TIMELINE ───────────────────────── */}
      <div style={{ background:'#fff', border:`1px solid ${C.border}`, borderRadius:'10px', padding:'18px 20px', marginBottom:'12px' }}>
        <div style={{ fontSize:'12px', fontWeight:'600', color: C.text, marginBottom:'14px' }}>Match jobs over time</div>
        {filteredTimeline.length > 0 ? (
          <TimelineChart data={filteredTimeline} brandColor={brandColor}/>
        ) : (
          <EmptyState label="No job history yet — run your first match to see this chart"/>
        )}
      </div>

      {/* ── ROW 3: TOP TRIALS + DEMOGRAPHICS ───────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 280px', gap:'12px', marginBottom:'12px' }}>

        {/* Top trials table */}
        <div style={{ background:'#fff', border:`1px solid ${C.border}`, borderRadius:'10px', padding:'18px 20px' }}>
          <div style={{ fontSize:'12px', fontWeight:'600', color: C.text, marginBottom:'14px' }}>Most frequently matched trials</div>
          {topTrials.length > 0 ? (
            <TopTrialsTable trials={topTrials} brandColor={brandColor}/>
          ) : (
            <EmptyState label="No trial matches yet"/>
          )}
        </div>

        {/* Demographics donut */}
        <div style={{ background:'#fff', border:`1px solid ${C.border}`, borderRadius:'10px', padding:'18px 20px' }}>
          <div style={{ fontSize:'12px', fontWeight:'600', color: C.text, marginBottom:'14px' }}>Patient demographics</div>
          {demographics.length > 0 ? (
            <DemographicsChart data={demographics}/>
          ) : (
            <EmptyState label="Add patients to see demographics"/>
          )}
        </div>
      </div>

      {/* ── FOOTER NOTE ────────────────────────────────── */}
      <p style={{ fontSize:'11px', color: C.gray, marginTop:'8px', lineHeight:'1.6' }}>
        Analytics update in real time as matches complete. All data is scoped to your workspace only.
      </p>
    </div>
  )
}

// ── Funnel chart ──────────────────────────────────────────────
function FunnelChart({ funnel, brandColor }: { funnel: any; brandColor: string }) {
  const steps = [
    { label: 'Total patients',    val: funnel.total_patients         || 0, color: '#E2E0D8' },
    { label: 'Patients matched',  val: funnel.patients_matched       || 0, color: brandColor },
    { label: 'Strong matches',    val: funnel.patients_with_strong_match || 0, color: C.tealM },
    { label: 'Partial only',      val: funnel.patients_partial_only  || 0, color: C.amber   },
    { label: 'No match found',    val: funnel.patients_no_match      || 0, color: C.redL    },
  ]
  const max = steps[0].val || 1

  return (
    <div>
      {steps.map((s, i) => {
        const pct = Math.round((s.val / max) * 100)
        const rate = i > 0 && steps[i-1].val > 0 ? Math.round((s.val / steps[i-1].val) * 100) : null
        return (
          <div key={s.label} style={{ marginBottom:'10px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'4px' }}>
              <span style={{ fontSize:'12px', color: C.text }}>{s.label}</span>
              <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                {rate !== null && (
                  <span style={{ fontSize:'10px', color: C.gray }}>{rate}%</span>
                )}
                <span style={{ fontSize:'13px', fontWeight:'500', color: C.text, minWidth:'28px', textAlign:'right' }}>{s.val}</span>
              </div>
            </div>
            <div style={{ height:'6px', background: C.bg, borderRadius:'99px', overflow:'hidden' }}>
              <div style={{ height:'100%', width:`${pct}%`, background: s.color === C.redL ? C.red : s.color, borderRadius:'99px', transition:'width 1s ease', opacity: s.color === C.redL ? 0.5 : 1 }}/>
            </div>
          </div>
        )
      })}

      <div style={{ marginTop:'14px', paddingTop:'12px', borderTop:`1px solid ${C.border}`, display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
        {[
          { label:'Avg matches/patient', val: funnel.avg_matches_per_patient || '—' },
          { label:'CT.gov trials',       val: funnel.total_ctgov_trials || 0       },
          { label:'CTRI trials',         val: funnel.total_ctri_trials  || 0       },
          { label:'Strong match rate',   val: funnel.patients_matched > 0 ? `${Math.round((funnel.patients_with_strong_match / funnel.patients_matched) * 100)}%` : '—' },
        ].map(s => (
          <div key={s.label} style={{ background: C.bg, borderRadius:'7px', padding:'8px 10px' }}>
            <div style={{ fontSize:'10px', color: C.gray, marginBottom:'2px' }}>{s.label}</div>
            <div style={{ fontSize:'15px', fontWeight:'500', color: C.text }}>{s.val}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Condition bar chart ───────────────────────────────────────
function ConditionChart({ conditions, brandColor }: { conditions: any[]; brandColor: string }) {
  const max = Math.max(...conditions.map((c: any) => c.patient_count), 1)
  return (
    <div style={{ overflowY:'auto', maxHeight:'280px' }}>
      {conditions.map((c: any) => {
        const matchRate = c.matched_count > 0 && c.patient_count > 0
          ? Math.round((c.results_with_matches / c.patient_count) * 100)
          : 0
        const strongRate = c.matched_count > 0
          ? Math.round((c.strong_match_total / c.matched_count) * 100)
          : 0
        return (
          <div key={c.condition} style={{ marginBottom:'12px', paddingBottom:'12px', borderBottom:`1px solid ${C.bg}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'5px' }}>
              <div>
                <span style={{ fontSize:'13px', fontWeight:'500', color: C.text }}>{c.condition}</span>
                <span style={{ marginLeft:'8px', fontSize:'11px', color: C.gray }}>{c.patient_count} patient{c.patient_count !== 1 ? 's' : ''}</span>
              </div>
              <div style={{ display:'flex', gap:'6px', flexShrink:0 }}>
                <span style={{ background: C.tealL, color: C.teal, fontSize:'10px', fontWeight:'600', padding:'2px 7px', borderRadius:'99px' }}>
                  {matchRate}% matched
                </span>
                <span style={{ background: matchRate > 50 ? C.tealL : C.amberL, color: matchRate > 50 ? C.teal : C.amber, fontSize:'10px', fontWeight:'600', padding:'2px 7px', borderRadius:'99px' }}>
                  {c.avg_top_score || '—'}% avg score
                </span>
              </div>
            </div>
            {/* Stacked bar: strong (teal) + partial (amber) */}
            <div style={{ height:'8px', background: C.bg, borderRadius:'99px', overflow:'hidden', display:'flex' }}>
              <div style={{ height:'100%', width:`${(c.strong_match_total / max) * 100}%`, background: brandColor, transition:'width .8s ease' }}/>
              <div style={{ height:'100%', width:`${(c.partial_match_total / max) * 100}%`, background: C.amber, opacity:.6, transition:'width .8s ease' }}/>
            </div>
            <div style={{ display:'flex', gap:'10px', marginTop:'4px' }}>
              <span style={{ fontSize:'10px', color: C.gray }}>
                <span style={{ display:'inline-block', width:'8px', height:'8px', borderRadius:'2px', background: brandColor, marginRight:'3px', verticalAlign:'middle' }}/>
                {c.strong_match_total} strong
              </span>
              <span style={{ fontSize:'10px', color: C.gray }}>
                <span style={{ display:'inline-block', width:'8px', height:'8px', borderRadius:'2px', background: C.amber, marginRight:'3px', verticalAlign:'middle', opacity:.7 }}/>
                {c.partial_match_total} partial
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Timeline chart (SVG line + bar) ──────────────────────────
function TimelineChart({ data, brandColor }: { data: any[]; brandColor: string }) {
  if (!data.length) return <EmptyState label="No data"/>
  const W = 600, H = 120, PAD = { t:10, r:20, b:30, l:40 }
  const cw = W - PAD.l - PAD.r
  const ch = H - PAD.t - PAD.b
  const maxJobs     = Math.max(...data.map(d => d.jobs_run), 1)
  const maxPatients = Math.max(...data.map(d => d.patients_processed || 0), 1)
  const xStep = cw / Math.max(data.length - 1, 1)

  const jobPoints = data.map((d, i) => ({
    x: PAD.l + i * xStep,
    y: PAD.t + ch - (d.jobs_run / maxJobs) * ch,
    v: d.jobs_run,
    date: d.week_start,
  }))

  const patPath = data.map((d, i) => {
    const x = PAD.l + i * xStep
    const y = PAD.t + ch - ((d.patients_processed || 0) / maxPatients) * ch
    return `${i === 0 ? 'M' : 'L'}${x},${y}`
  }).join(' ')

  return (
    <div style={{ overflowX:'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', minWidth:'300px' }} role="img" aria-label="Match jobs over time chart">
        <title>Match jobs over time</title>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map(f => {
          const y = PAD.t + ch * (1 - f)
          return (
            <g key={f}>
              <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke={C.border} strokeWidth=".5" strokeDasharray={f === 0 ? 'none' : '3,3'}/>
              <text x={PAD.l - 5} y={y + 4} textAnchor="end" fontSize="9" fill={C.gray}>{Math.round(maxJobs * f)}</text>
            </g>
          )
        })}

        {/* Patients line */}
        <path d={patPath} fill="none" stroke={C.amber} strokeWidth="1.5" strokeDasharray="4,2" opacity=".7"/>

        {/* Job bars */}
        {jobPoints.map((p, i) => {
          const barW = Math.max(xStep * 0.5, 6)
          const barH = ch - (p.y - PAD.t)
          return (
            <g key={i}>
              <rect x={p.x - barW/2} y={p.y} width={barW} height={barH} fill={brandColor} opacity=".15" rx="2"/>
              <circle cx={p.x} cy={p.y} r="4" fill={brandColor} stroke="#fff" strokeWidth="1.5"/>
              <text x={p.x} y={H - 6} textAnchor="middle" fontSize="8.5" fill={C.gray}>
                {new Date(p.date).toLocaleDateString('en-IN', { day:'2-digit', month:'short' })}
              </text>
            </g>
          )
        })}

        {/* Legend */}
        <circle cx={W - PAD.r - 90} cy={10} r="4" fill={brandColor}/>
        <text x={W - PAD.r - 84} y={14} fontSize="9" fill={C.gray}>Jobs run</text>
        <line x1={W - PAD.r - 40} y1={10} x2={W - PAD.r - 24} y2={10} stroke={C.amber} strokeWidth="1.5" strokeDasharray="3,2"/>
        <text x={W - PAD.r - 20} y={14} fontSize="9" fill={C.gray}>Patients</text>
      </svg>

      {/* Summary row below chart */}
      <div style={{ display:'flex', gap:'16px', marginTop:'8px', flexWrap:'wrap' }}>
        {[
          { label:'Total jobs', val: data.reduce((a,d) => a + d.jobs_run, 0) },
          { label:'Patients processed', val: data.reduce((a,d) => a + (d.patients_processed || 0), 0) },
          { label:'Avg success rate', val: `${Math.round(data.reduce((a,d) => a + (d.success_rate_pct || 0), 0) / Math.max(data.length, 1))}%` },
        ].map(s => (
          <div key={s.label} style={{ fontSize:'12px', color: C.gray }}>
            <span style={{ fontWeight:'600', color: C.text, marginRight:'5px' }}>{s.val}</span>{s.label}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Top trials table ──────────────────────────────────────────
function TopTrialsTable({ trials, brandColor }: { trials: any[]; brandColor: string }) {
  return (
    <div style={{ overflowX:'auto' }}>
      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'12px' }}>
        <thead>
          <tr style={{ background: C.bg }}>
            {['Trial', 'Source', 'Phase', 'Matched', 'Strong', 'Avg score'].map(h => (
              <th key={h} style={{ padding:'7px 10px', textAlign:'left', fontSize:'10px', fontWeight:'600', letterSpacing:'.06em', textTransform:'uppercase', color: C.gray, whiteSpace:'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {trials.map((t: any, i: number) => (
            <tr key={t.nct_id || i} style={{ borderTop:`1px solid ${C.border}` }}>
              <td style={{ padding:'8px 10px' }}>
                <div style={{ fontWeight:'500', color: C.text, maxWidth:'220px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {t.trial_title || t.nct_id}
                </div>
                {t.nct_id && t.nct_id.startsWith('NCT') && (
                  <a href={`https://clinicaltrials.gov/study/${t.nct_id}`} target="_blank" rel="noreferrer" style={{ fontSize:'10px', color: brandColor, textDecoration:'none' }}>
                    {t.nct_id} ↗
                  </a>
                )}
              </td>
              <td style={{ padding:'8px 10px' }}>
                <span style={{ fontSize:'10px', fontWeight:'600', padding:'2px 7px', borderRadius:'99px', background: t.source === 'CTRI' ? C.amberL : C.blueL, color: t.source === 'CTRI' ? C.amber : C.blue }}>
                  {t.source || 'Unknown'}
                </span>
              </td>
              <td style={{ padding:'8px 10px', color: C.gray }}>{t.phase || '—'}</td>
              <td style={{ padding:'8px 10px', fontWeight:'600', color: C.text }}>{t.times_matched}</td>
              <td style={{ padding:'8px 10px', color: C.teal, fontWeight:'600' }}>{t.strong_count}</td>
              <td style={{ padding:'8px 10px' }}>
                <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                  <div style={{ flex:1, height:'5px', background: C.bg, borderRadius:'99px', overflow:'hidden', minWidth:'50px' }}>
                    <div style={{ height:'100%', width:`${t.avg_score || 0}%`, background: brandColor, borderRadius:'99px' }}/>
                  </div>
                  <span style={{ fontSize:'11px', color: C.text, fontWeight:'500', flexShrink:0 }}>{t.avg_score || '—'}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Demographics donut ────────────────────────────────────────
function DemographicsChart({ data }: { data: any[] }) {
  const sexGroups: Record<string, number> = {}
  const ageGroups: Record<string, number> = {}
  data.forEach(d => {
    sexGroups[d.sex || 'Unknown'] = (sexGroups[d.sex || 'Unknown'] || 0) + d.count
    ageGroups[d.age_group] = (ageGroups[d.age_group] || 0) + d.count
  })

  const sexColors: Record<string, string> = { Male: C.blue, Female: C.tealM, Other: C.amber, Unknown: C.gray }
  const ageColors = [C.teal, C.tealM, C.blue, C.amber, '#8B5CF6', '#EC4899']
  const ageOrder  = ['Under 18','18–30','31–45','46–60','61–75','Over 75']

  return (
    <div>
      <div style={{ fontSize:'11px', fontWeight:'600', textTransform:'uppercase', letterSpacing:'.06em', color: C.gray, marginBottom:'8px' }}>By sex</div>
      {Object.entries(sexGroups).map(([sex, count]) => {
        const total = Object.values(sexGroups).reduce((a,b) => a+b, 0)
        const pct   = Math.round((count / total) * 100)
        return (
          <div key={sex} style={{ marginBottom:'7px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:'12px', marginBottom:'3px' }}>
              <span style={{ color: C.text }}>{sex}</span>
              <span style={{ color: C.gray }}>{count} ({pct}%)</span>
            </div>
            <div style={{ height:'5px', background: C.bg, borderRadius:'99px', overflow:'hidden' }}>
              <div style={{ height:'100%', width:`${pct}%`, background: sexColors[sex] || C.gray, borderRadius:'99px' }}/>
            </div>
          </div>
        )
      })}

      <div style={{ fontSize:'11px', fontWeight:'600', textTransform:'uppercase', letterSpacing:'.06em', color: C.gray, margin:'14px 0 8px' }}>By age group</div>
      {ageOrder.filter(a => ageGroups[a]).map((age, i) => {
        const total = Object.values(ageGroups).reduce((a,b) => a+b, 0)
        const pct   = Math.round(((ageGroups[age] || 0) / total) * 100)
        return (
          <div key={age} style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'6px', fontSize:'12px' }}>
            <span style={{ width:'48px', color: C.text, flexShrink:0 }}>{age}</span>
            <div style={{ flex:1, height:'5px', background: C.bg, borderRadius:'99px', overflow:'hidden' }}>
              <div style={{ height:'100%', width:`${pct}%`, background: ageColors[i % ageColors.length], borderRadius:'99px' }}/>
            </div>
            <span style={{ width:'24px', color: C.gray, textAlign:'right', flexShrink:0 }}>{ageGroups[age] || 0}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Enrollment conversion funnel ────────────────────────────────
function EnrollmentConversionFunnel({ data, brandColor }: { data: any; brandColor: string }) {
  const steps = [
    { label: 'Matches generated',  val: data.total_matched         || 0, color: '#D3D1C7' },
    { label: 'PI contacted',       val: data.pi_contacted          || 0, color: '#185FA5' },
    { label: 'Pre-screening booked', val: data.pre_screening_booked || 0, color: '#BA7517' },
    { label: 'Enrolled',           val: data.enrolled              || 0, color: brandColor },
  ]
  const max = steps[0].val || 1

  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'10px', marginBottom:'18px' }}>
        {steps.map((s, i) => {
          const pct = Math.round((s.val / max) * 100)
          const stepRate = i > 0 && steps[i-1].val > 0 ? Math.round((s.val / steps[i-1].val) * 100) : null
          return (
            <div key={s.label} style={{ textAlign:'center' }}>
              <div style={{ fontSize:'24px', fontWeight:'500', color: i === 3 ? brandColor : C.text, marginBottom:'2px' }}>{s.val}</div>
              <div style={{ fontSize:'11px', color: C.gray, marginBottom:'8px' }}>{s.label}</div>
              <div style={{ height:'6px', background: C.bg, borderRadius:'99px', overflow:'hidden', marginBottom:'4px' }}>
                <div style={{ height:'100%', width:`${pct}%`, background: s.color, borderRadius:'99px', transition:'width .8s ease' }}/>
              </div>
              {stepRate !== null && <div style={{ fontSize:'10px', color: C.gray }}>{stepRate}% of previous step</div>}
            </div>
          )
        })}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'10px', paddingTop:'14px', borderTop:`1px solid ${C.border}` }}>
        {[
          { label:'Match → PI contacted',     val: data.match_to_contacted_pct      != null ? `${data.match_to_contacted_pct}%`      : '—' },
          { label:'Contacted → enrolled',     val: data.contacted_to_enrolled_pct   != null ? `${data.contacted_to_enrolled_pct}%`   : '—' },
          { label:'Overall match → enrolled', val: data.overall_match_to_enrolled_pct != null ? `${data.overall_match_to_enrolled_pct}%` : '—' },
        ].map(s => (
          <div key={s.label} style={{ background: C.bg, borderRadius:'8px', padding:'10px 12px', textAlign:'center' }}>
            <div style={{ fontSize:'17px', fontWeight:'500', color: brandColor }}>{s.val}</div>
            <div style={{ fontSize:'10.5px', color: C.gray, marginTop:'2px' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {(data.screen_failed > 0 || data.patient_declined > 0) && (
        <div style={{ display:'flex', gap:'16px', marginTop:'12px', fontSize:'11px', color: C.gray }}>
          {data.screen_failed > 0 && <span><strong style={{ color: C.red }}>{data.screen_failed}</strong> screen failed</span>}
          {data.patient_declined > 0 && <span><strong style={{ color: C.red }}>{data.patient_declined}</strong> patient declined</span>}
        </div>
      )}
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────
function EmptyState({ label }: { label: string }) {
  return (
    <div style={{ padding:'32px 20px', textAlign:'center', color: C.gray, fontSize:'13px' }}>
      <div style={{ fontSize:'28px', marginBottom:'8px', opacity:.4 }}>📊</div>
      {label}
    </div>
  )
}
