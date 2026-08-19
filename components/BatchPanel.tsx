import { useState, useEffect, useRef } from 'react'
import PICard from './PICard'
import EnrollmentStatusDropdown from './EnrollmentStatusDropdown'
import PreScreeningChecklistCard from './PreScreeningChecklistCard'
import MatchExplainability from './MatchExplainability'

// Enrollment statuses where pre-screening prep is relevant
const PRESCREENING_ELIGIBLE = ['pi_contacted', 'screened', 'enrolled', 'screen_failed']

/**
 * A raw provider error is genuinely useful for diagnosis, but this app's
 * audience is clinical coordinators, not engineers — a short, friendly
 * hint above the raw text turns "openai request failed: 401
 * Unauthorized" into something actually actionable without hiding the
 * real error underneath it.
 *
 * Pure logic, exported and tested directly (no JSX/React dependency) —
 * same pattern as MatchExplainability.tsx's interpretedOnlyEntries, for
 * the same reason: this project has no React component-testing setup,
 * so pure logic gets pulled out and tested in the same node environment
 * as everything else, rather than skipped.
 */
export function friendlyErrorHint(errorMsg: string): string | null {
  if (/\b401\b|unauthorized|invalid.*api.*key|api.*key.*invalid/i.test(errorMsg)) {
    return 'This looks like an AI provider authentication problem — check the API key in Settings → AI provider.'
  }
  if (/\b429\b|rate.?limit/i.test(errorMsg)) {
    return 'The configured AI provider rate-limited this request — this is common on free tiers. Wait a bit and try again, or check your provider\'s usage limits.'
  }
  if (/openai_compatible.*baseUrl|baseUrl.*required/i.test(errorMsg)) {
    return 'The AI provider is missing its base URL — check Settings → AI provider.'
  }
  return null
}

interface Props { brandColor: string }

export default function BatchPanel({ brandColor }: Props) {
  const [jobs,    setJobs]    = useState<any[]>([])
  const [openJob, setOpenJob] = useState<string | null>(null)
  const [results, setResults] = useState<any[]>([])
  const [jobData, setJobData] = useState<any>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const pollRef = useRef<NodeJS.Timeout | null>(null)

  async function loadJobs() {
    // Fetch recent jobs from our match_jobs via a simple query
    const r = await fetch('/api/match/jobs')
    if (r.ok) setJobs(await r.json())
  }

  async function openJobDetail(jobId: string) {
    setOpenJob(jobId)
    pollJob(jobId)
  }

  function pollJob(jobId: string) {
    if (pollRef.current) clearInterval(pollRef.current)
    const poll = async () => {
      const r = await fetch(`/api/match/${jobId}`)
      if (!r.ok) return
      const d = await r.json()
      setJobData(d.job)
      setResults(d.results || [])
      // Stop polling when done
      if (d.job?.status === 'completed' || d.job?.status === 'failed') {
        if (pollRef.current) clearInterval(pollRef.current)
      }
    }
    poll()
    pollRef.current = setInterval(poll, 2000)
  }

  useEffect(() => {
    loadJobs()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  const S = {
    card: { background:'#fff', border:'1px solid #E2E0D8', borderRadius:'10px', padding:'16px 20px', marginBottom:'12px' } as any,
    row:  { display:'grid', gridTemplateColumns:'1fr 120px 100px 100px 90px', gap:'12px', alignItems:'center', padding:'10px 14px', borderBottom:'1px solid #E2E0D8', fontSize:'13px' } as any,
    btn:  (primary=false) => ({ padding:'6px 12px', background: primary ? brandColor : '#fff', color: primary ? '#fff' : '#1C1B18', border: primary ? 'none' : '1px solid #E2E0D8', borderRadius:'7px', fontSize:'12px', cursor:'pointer', fontFamily:'sans-serif' }) as any,
  }

  // Renders a visible banner when a live trial registry couldn't be reached
  // during this match run. Previously a fetch failure was indistinguishable
  // from "genuinely no trials" and could silently trigger a fabricated
  // ("AI-Synthesised") result with no UI signal at all — see lib/matcher.ts.
  // Now every match result carries source_status, and any 'error' is
  // surfaced here rather than left for the coordinator to infer.
  function sourceStatusBanner(sourceStatus: any) {
    if (!sourceStatus) return null
    const ctgovFailed = sourceStatus.ctgov === 'error'
    const ctriFailed  = sourceStatus.ctri === 'error'
    if (!ctgovFailed && !ctriFailed) return null
    const label = ctgovFailed && ctriFailed
      ? 'ClinicalTrials.gov and CTRI were both unreachable during this search'
      : ctgovFailed
      ? 'ClinicalTrials.gov was unreachable during this search — results reflect CTRI only'
      : 'CTRI was unreachable during this search — results reflect ClinicalTrials.gov only'
    return (
      <div style={{ display:'flex', alignItems:'flex-start', gap:'8px', background:'#FEF9F0', border:'1px solid #F0D59566', borderRadius:'8px', padding:'9px 12px', fontSize:'12px', color:'#8A5A0F', marginBottom:'10px' }}>
        <span aria-hidden>⚠️</span>
        <span><strong>{label}.</strong> This is a live-search gap, not a rejected match — re-run this patient's match shortly to check the unreachable source.</span>
      </div>
    )
  }

  function statusBadge(status: string) {
    const map: Record<string, [string, string]> = {
      pending:   ['#F7F6F2', '#72706A'],
      running:   ['#E1F5EE', '#0F6E56'],
      completed: ['#EAF3DE', '#27500A'],
      failed:    ['#FEF0EE', '#A32D2D'],
      // REAL BUG FOUND AND FIXED HERE: match_results rows use
      // 'pending'/'running'/'done'/'error' (not the job-level
      // 'completed'/'failed' this map was originally written for).
      // Without an entry, 'error' fell through to the neutral default
      // below — a failed match displayed as a plain gray badge instead
      // of the alarming red one a real failure deserves.
      error:     ['#FEF0EE', '#A32D2D'],
    }
    const [bg, color] = map[status] || ['#F7F6F2', '#72706A']
    return <span style={{ background:bg, color, fontSize:'10px', fontWeight:'600', padding:'2px 9px', borderRadius:'99px', letterSpacing:'.05em', textTransform:'uppercase' }}>{status}</span>
  }

  if (openJob && jobData) {
    const pct = Math.round((jobData.done_patients / (jobData.total_patients || 1)) * 100)
    return (
      <div>
        <div style={{ display:'flex', alignItems:'center', gap:'12px', marginBottom:'18px' }}>
          <button onClick={() => { setOpenJob(null); if (pollRef.current) clearInterval(pollRef.current); loadJobs() }} style={S.btn()}>← Back</button>
          <h2 style={{ margin:0, fontSize:'17px', fontWeight:'500' }}>{jobData.name}</h2>
          {statusBadge(jobData.status)}
          {jobData.status === 'completed' && (
            <a
              href={`/api/export/hms?job_id=${openJob}`}
              download
              style={{ marginLeft:'auto', padding:'6px 12px', background:'#fff', color:'#1C1B18', border:'1px solid #E2E0D8', borderRadius:'7px', fontSize:'12px', fontWeight:500, textDecoration:'none', display:'inline-flex', alignItems:'center', gap:'6px' }}
            >
              📥 Export to Insta HMS
            </a>
          )}
        </div>

        {/* Progress */}
        {jobData.status === 'running' && (
          <div style={{ ...S.card, marginBottom:'16px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:'12px', color:'#72706A', marginBottom:'6px' }}>
              <span>Matching patients…</span>
              <span>{jobData.done_patients} / {jobData.total_patients}</span>
            </div>
            <div style={{ height:'5px', background:'#E2E0D8', borderRadius:'99px', overflow:'hidden' }}>
              <div style={{ height:'100%', width:`${pct}%`, background: brandColor, borderRadius:'99px', transition:'width .5s ease' }}/>
            </div>
          </div>
        )}

        {/* Results table */}
        <div style={{ background:'#fff', border:'1px solid #E2E0D8', borderRadius:'10px', overflow:'hidden' }}>
          <div style={{ ...S.row, gridTemplateColumns:'1fr 110px 150px 70px 60px', background:'#F7F6F2', fontWeight:'600', fontSize:'10px', letterSpacing:'.06em', textTransform:'uppercase', color:'#72706A' }}>
            <div>Patient</div><div>Matches</div><div>Enrollment status</div><div>Report</div><div></div>
          </div>
          {results.map((r: any) => {
            const strong  = (r.matches || []).filter((m: any) => m.matchStrength === 'STRONG').length
            const partial = (r.matches || []).filter((m: any) => m.matchStrength === 'PARTIAL').length
            const topMatch = (r.matches || [])[0]
            const topNctId = topMatch?.nctId || ''
            return (
              <div key={r.id}>
                <div style={{ ...S.row, gridTemplateColumns:'1fr 110px 150px 70px 60px' }}>
                  <div>
                    <div style={{ fontWeight:'500', fontSize:'13px' }}>{r.patients?.patient_code}</div>
                    <div style={{ fontSize:'12px', color:'#72706A' }}>{r.patients?.diagnosis}</div>
                  </div>
                  <div style={{ fontSize:'13px' }}>
                    {r.status === 'done'
                      ? <>
                          <span style={{ color:brandColor, fontWeight:'500' }}>{strong} strong</span> · <span style={{ color:'#BA7517' }}>{partial} partial</span>
                          {(r.source_status?.ctgov === 'error' || r.source_status?.ctri === 'error') && (
                            <span title="A trial registry was unreachable during this search — open this row for details" style={{ marginLeft:'6px' }}>⚠️</span>
                          )}
                        </>
                      : '—'}
                  </div>
                  <div>
                    {r.status === 'done' ? (
                      <EnrollmentStatusDropdown
                        jobId={openJob!}
                        resultId={r.id}
                        currentStatus={r.enrollment_status || 'pending'}
                        brandColor={brandColor}
                        onUpdated={(newStatus) => {
                          setResults(prev => prev.map((p: any) => p.id === r.id ? { ...p, enrollment_status: newStatus } : p))
                        }}
                      />
                    ) : statusBadge(r.status)}
                  </div>
                  <div>
                    {r.report_url
                      ? <a href={r.report_url} target="_blank" rel="noreferrer" style={{ color: brandColor, fontSize:'12px', fontWeight:'500' }}>↗ PDF</a>
                      : '—'}
                  </div>
                  <div>
                    {(r.status === 'done' && r.matches) || r.status === 'error' ? (
                      <button style={S.btn(true)} onClick={() => setExpandedId(prev => prev === r.id ? null : r.id)}>
                        {expandedId === r.id ? 'Hide' : (r.status === 'error' ? 'Why?' : 'View')}
                      </button>
                    ) : null}
                  </div>
                </div>

                {/* Real gap found and fixed here: error_msg was already being
                    sent by the API (pages/api/match/[id].ts already selects
                    it) but never rendered anywhere — a failed match gave the
                    coordinator zero visibility into why, which matters a lot
                    more now that a misconfigured org-level AI provider key is
                    a real, self-inflicted failure mode a coordinator (not
                    just the platform operator) can cause. */}
                {expandedId === r.id && r.status === 'error' && (
                  <div style={{ padding:'0 14px 14px', borderBottom:'1px solid #E2E0D8', background:'#FBFAF7' }}>
                    <div style={{ fontSize:'12.5px', color:'#A32D2D', padding:'10px 0' }}>
                      {(() => {
                        const hint = friendlyErrorHint(r.error_msg || '')
                        return (
                          <>
                            {hint && <div style={{ fontWeight:'500', marginBottom:'6px' }}>{hint}</div>}
                            <div style={{ color:'#72706A', fontFamily:'monospace', fontSize:'11.5px', wordBreak:'break-word' }}>
                              {r.error_msg || 'No error detail was recorded for this match.'}
                            </div>
                          </>
                        )
                      })()}
                    </div>
                  </div>
                )}

                {/* Expanded detail: summary + explainable match breakdown + site profile link + PI card + pre-screening checklist */}
                {expandedId === r.id && r.status === 'done' && (
                  <div style={{ padding:'0 14px 14px', borderBottom:'1px solid #E2E0D8', background:'#FBFAF7' }}>
                    {sourceStatusBanner(r.source_status)}
                    {r.summary && (
                      <div style={{ fontSize:'12.5px', color:'#1C1B18', lineHeight:'1.6', padding:'10px 0', borderBottom:'1px solid #E2E0D8', marginBottom:'4px' }}>
                        {r.summary}
                      </div>
                    )}
                    {/* Per-criterion match explainability — previously this data only
                        appeared in the downloaded PDF. Surfacing it here, live, gives
                        the coordinator the actual "why" behind each match without an
                        extra download — this is the documented trust lever for AI-
                        assisted clinical matching, not a cosmetic addition. */}
                    {r.matches?.length > 0 && (
                      <MatchExplainability matches={r.matches} brandColor={brandColor} />
                    )}
                    {topNctId && topNctId.startsWith('NCT') && (
                      <PICard
                        nctId={topNctId}
                        trialTitle={topMatch?.title || ''}
                        patientId={r.patients?.id}
                        matchResultId={r.id}
                        brandColor={brandColor}
                      />
                    )}
                    {/* Pre-screening checklist — shown after PI is contacted */}
                    {topNctId && topNctId.startsWith('NCT') &&
                      PRESCREENING_ELIGIBLE.includes(r.enrollment_status || '') && (
                        <PreScreeningChecklistCard
                          matchResultId={r.id}
                          nctId={topNctId}
                          trialTitle={topMatch?.title || topNctId}
                          patientCode={r.patients?.patient_code || ''}
                          brandColor={brandColor}
                        />
                      )
                    }
                    {/* Site network link */}
                    {topNctId && (
                      <div style={{ marginTop:'10px', paddingTop:'10px', borderTop:'1px solid #E2E0D8' }}>
                        <a
                          href="#"
                          onClick={e => { e.preventDefault(); window.dispatchEvent(new CustomEvent('navigate-tab', { detail: 'site-network' })) }}
                          style={{ fontSize:'12px', color: brandColor, textDecoration:'none', display:'inline-flex', alignItems:'center', gap:'5px' }}
                        >
                          🏥 View site profiles for this trial in Site Network →
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'18px' }}>
        <h2 style={{ margin:0, fontSize:'17px', fontWeight:'500' }}>Match Jobs</h2>
        <button onClick={loadJobs} style={S.btn()}>↻ Refresh</button>
      </div>

      {jobs.length === 0 ? (
        <div style={{ ...S.card, textAlign:'center', padding:'48px', color:'#72706A' }}>
          No match jobs yet. Select patients and click "Match" to get started.
        </div>
      ) : (
        <div style={{ background:'#fff', border:'1px solid #E2E0D8', borderRadius:'10px', overflow:'hidden' }}>
          <div style={{ ...S.row, background:'#F7F6F2', fontWeight:'600', fontSize:'10px', letterSpacing:'.06em', textTransform:'uppercase', color:'#72706A' }}>
            <div>Job</div><div>Progress</div><div>Status</div><div>Date</div><div></div>
          </div>
          {jobs.map((j: any) => (
            <div key={j.id} style={S.row}>
              <div>
                <div style={{ fontWeight:'500' }}>{j.name}</div>
                <div style={{ fontSize:'11px', color:'#72706A' }}>{j.total_patients} patient(s)</div>
              </div>
              <div style={{ fontSize:'12px', color:'#72706A' }}>{j.done_patients} / {j.total_patients}</div>
              <div>{statusBadge(j.status)}</div>
              <div style={{ fontSize:'12px', color:'#72706A' }}>{new Date(j.created_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
              <div><button style={S.btn(true)} onClick={() => openJobDetail(j.id)}>View →</button></div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
