/**
 * components/MatchExplainability.tsx
 *
 * Renders the full check/partial/unmet per-criterion breakdown for every
 * matched trial, live in the dashboard. This data already existed
 * (criteriaMet, criteriaPartial, criteriaFail, eligibilityDetails) and was
 * already used to build the PDF report — it was simply never rendered in
 * the web UI, meaning a coordinator had to download a PDF to see why a
 * match was suggested.
 *
 * This matters more than it looks: across the clinical-AI adoption
 * literature, explainability — not raw accuracy — is repeatedly the
 * determining factor for whether clinicians trust and act on an AI match.
 * Burying it one click behind a PDF download throws away the single
 * strongest trust lever the product has, at exactly the moment (first
 * session) it matters most.
 */

import { useState } from 'react'
import type { TrialMatch } from '../lib/types/domain'

interface Props {
  matches:    TrialMatch[]
  brandColor: string
  /** Pre-expand the top match so it's visible without an extra click */
  defaultOpenTop?: boolean
}

const STRENGTH_META: Record<string, { bg: string; color: string; label: string }> = {
  STRONG:  { bg: '#E1F5EE', color: '#0F6E56', label: 'Strong match'  },
  PARTIAL: { bg: '#FEF9F0', color: '#BA7517', label: 'Partial match' },
  LOW:     { bg: '#F7F6F2', color: '#72706A', label: 'Low match'     },
}

/**
 * lib/matcher.ts builds criteriaMet/criteriaPartial/criteriaFail as
 * `[...verifiedX, ...interpretedX]` for each bucket, where verifiedX is
 * derived 1:1 from deterministicResults (in the same PASS/FAIL/UNKNOWN
 * split) and interpretedX is the model's own judgment appended after it.
 *
 * A prefix-string filter can't isolate the interpreted tail: PASS/FAIL
 * verified entries get a "✓ Verified — " prefix, but verified UNKNOWN
 * entries do NOT (see matcher.ts's verifiedPartial) — identical in shape
 * to a genuinely-interpreted entry. Slicing off exactly as many entries
 * from the front of each bucket as deterministicResults accounts for is
 * exact, because it relies on the real construction order rather than
 * guessing from text shape.
 */
export function interpretedOnlyEntries(m: TrialMatch): string[] {
  const det = m.deterministicResults ?? []
  const verifiedMetCount     = det.filter(d => d.result === 'PASS').length
  const verifiedFailCount    = det.filter(d => d.result === 'FAIL').length
  const verifiedPartialCount = det.filter(d => d.result === 'UNKNOWN').length
  return [
    ...(m.criteriaMet     ?? []).slice(verifiedMetCount),
    ...(m.criteriaFail    ?? []).slice(verifiedFailCount),
    ...(m.criteriaPartial ?? []).slice(verifiedPartialCount),
  ]
}

export default function MatchExplainability({ matches, brandColor, defaultOpenTop = true }: Props) {
  const [openIdx, setOpenIdx] = useState<number | null>(defaultOpenTop ? 0 : null)

  if (!matches?.length) {
    // An empty array here is a legitimate outcome (genuinely zero live
    // trials, or a source was unreachable) — not an error state. The
    // deterministic explanation lives in the match result's summary text,
    // rendered by the parent above this component; this just avoids
    // rendering nothing with no visual acknowledgement at all.
    return (
      <p style={{ fontSize:'12px', color:'#B4B2A9', fontStyle:'italic', marginTop:'6px' }}>
        No trials to break down for this run — see the summary above for why.
      </p>
    )
  }

  return (
    <div style={{ marginTop: '10px' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, color: '#72706A', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '8px' }}>
        Why these matches — {matches.length} trial{matches.length !== 1 ? 's' : ''} screened
      </div>

      {matches.map((m, idx) => {
        const meta   = STRENGTH_META[m.matchStrength] || STRENGTH_META.LOW
        const isOpen = openIdx === idx
        const hasDetails = (m.eligibilityDetails?.length ?? 0) > 0
          || m.criteriaMet?.length || m.criteriaPartial?.length || m.criteriaFail?.length

        return (
          <div key={`${m.nctId}-${idx}`} style={{ border: '1px solid #E2E0D8', borderRadius: '8px', marginBottom: '8px', overflow: 'hidden' }}>
            <button
              onClick={() => setOpenIdx(isOpen ? null : idx)}
              aria-expanded={isOpen}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '9px 12px', background: isOpen ? '#FBFAF7' : '#fff', border: 'none', cursor: 'pointer', fontFamily: 'sans-serif', textAlign: 'left' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                <span style={{ fontSize: '10px', fontWeight: 600, padding: '2px 7px', borderRadius: '99px', background: meta.bg, color: meta.color, whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {meta.label}
                </span>
                {/* Source badge — every match is now guaranteed to come from a real
                    retrieved trial (see lib/matcher.ts), so showing this is safe and
                    gives the coordinator a direct way to verify the trial themselves. */}
                {m.source && (
                  <span style={{ fontSize: '10px', fontWeight: 600, padding: '2px 7px', borderRadius: '99px', background: m.source === 'CTRI' ? '#FEF0DC' : '#E1EDFB', color: m.source === 'CTRI' ? '#8A5A0F' : '#1D5BA6', whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {m.source}
                  </span>
                )}
                <span style={{ fontSize: '12.5px', fontWeight: 500, color: '#1C1B18', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {m.title || m.nctId}
                </span>
              </div>
              <span aria-hidden style={{ color: '#B4B2A9', fontSize: '12px', transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .2s', flexShrink: 0 }}>▾</span>
            </button>

            {isOpen && (
              <div style={{ padding: '12px 14px', borderTop: '1px solid #E2E0D8' }}>
                <div style={{ fontSize: '11px', color: '#72706A', marginBottom: '10px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <span>{m.nctId}{m.ctriId ? ` · ${m.ctriId}` : ''}</span>
                  {m.phase && <span>· {m.phase}</span>}
                  {m.sponsor && <span>· {m.sponsor}</span>}
                </div>

                {m.plainSummary && (
                  <p style={{ fontSize: '12.5px', color: '#1C1B18', lineHeight: 1.6, marginBottom: '12px' }}>
                    {m.plainSummary}
                  </p>
                )}

                {!hasDetails ? (
                  <p style={{ fontSize: '12px', color: '#B4B2A9', fontStyle: 'italic' }}>
                    No detailed criteria breakdown available for this match.
                  </p>
                ) : m.eligibilityDetails?.length ? (
                  <div>
                    {m.eligibilityDetails.map((d, i) => (
                      <CriterionRow key={i} status={d.status} text={d.criterion} detail={d.detail} />
                    ))}
                  </div>
                ) : (
                  <div>
                    {/*
                      Two genuinely different kinds of evidence here, and
                      the whole point of surfacing extractionSource is to
                      stop collapsing them into one "AI said so" bucket:

                      1. m.deterministicResults — every criterion that got
                         a PASS/FAIL/UNKNOWN computed in code against this
                         patient's real structured data (see
                         lib/eligibility-rules.ts). extractionSource here
                         only says whether the CRITERION TEXT ITSELF came
                         from the zero-LLM regex pass (rule_based) or from
                         Claude reading residual protocol text
                         (ai_extracted) — the evaluation of it was never
                         left to the model either way.

                      2. The model's own interpretedCriteria* judgment for
                         criteria that couldn't be reduced to a structured,
                         checkable form at all — genuinely the model's
                         reading, not independently checked against
                         anything. Isolated via interpretedOnlyEntries()
                         above, by position rather than string prefix (a
                         prefix filter can't tell a deterministic UNKNOWN
                         apart from a genuinely-interpreted entry — see
                         that function's own comment).
                    */}
                    {m.deterministicResults?.length ? (
                      <>
                        {m.deterministicResults.map((d, i) => (
                          <CriterionRow
                            key={`det-${i}`}
                            status={d.result === 'PASS' ? 'met' : d.result === 'FAIL' ? 'unmet' : 'unknown'}
                            text={d.description}
                            detail={d.evidence}
                            extractionSource={d.extractionSource}
                          />
                        ))}
                        {interpretedOnlyEntries(m).map((c, i) => (
                          <CriterionRow key={`interpreted-${i}`} status="unknown" text={c} extractionSource="ai_interpreted" />
                        ))}
                      </>
                    ) : (
                      // Fallback for match_results rows stored before this
                      // field existed on the shared type — match_results.matches
                      // is JSONB, so an older row simply won't have
                      // deterministicResults at all. Rather than silently
                      // dropping its "✓ Verified — " criteria, fall back to
                      // this component's original rendering (coarse
                      // VERIFIED/unmarked distinction only, no
                      // rule_based/ai_extracted split — that distinction
                      // genuinely doesn't exist for a row this old).
                      <>
                        {m.criteriaMet?.map((c, i) => <CriterionRow key={`met-${i}`} status="met" text={c} />)}
                        {m.criteriaPartial?.map((c, i) => <CriterionRow key={`partial-${i}`} status="partial" text={c} />)}
                        {m.criteriaFail?.map((c, i) => <CriterionRow key={`fail-${i}`} status="unmet" text={c} />)}
                      </>
                    )}
                  </div>
                )}

                {m.nextSteps && (
                  <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid #E2E0D8', fontSize: '12px', color: '#72706A', lineHeight: 1.6 }}>
                    <strong style={{ color: '#1C1B18' }}>Next steps: </strong>{m.nextSteps}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      <p style={{ fontSize: '10.5px', color: '#B4B2A9', marginTop: '6px', lineHeight: 1.5 }}>
        This breakdown is AI-generated from the trial's eligibility criteria and the patient's recorded profile.
        Final eligibility must be confirmed by the Principal Investigator at screening.
      </p>
    </div>
  )
}

type ExtractionSource = 'rule_based' | 'ai_extracted' | 'ai_interpreted'

const SOURCE_BADGE_META: Record<ExtractionSource, { label: string; bg: string; color: string; title: string }> = {
  rule_based: {
    label: 'RULE-BASED', bg: '#E1F5EE', color: '#0F6E56',
    title: 'This criterion was found by deterministic pattern-matching on the trial text (no AI involved), then evaluated in code against this patient\'s real structured clinical data.',
  },
  ai_extracted: {
    label: 'AI-EXTRACTED', bg: '#E9F1FB', color: '#1D5BA6',
    title: 'Claude found this criterion in the trial\'s protocol text (the deterministic pass alone couldn\'t parse it) — but the PASS/FAIL result itself was still computed in code against this patient\'s real structured clinical data, not judged by the model.',
  },
  ai_interpreted: {
    label: 'AI INTERPRETATION', bg: '#FEF9F0', color: '#BA7517',
    title: 'Claude\'s own reading of this criterion against the patient\'s profile — not independently checked against structured data. Confirm at screening.',
  },
}

function CriterionRow({
  status, text, detail, extractionSource,
}: {
  status: string; text: string; detail?: string; extractionSource?: ExtractionSource
}) {
  const cfg: Record<string, { icon: string; color: string }> = {
    met:     { icon: '✓', color: '#0F6E56' },
    partial: { icon: '~', color: '#BA7517' },
    unmet:   { icon: '✗', color: '#A32D2D' },
    unknown: { icon: '?', color: '#B4B2A9' },
  }
  const c = cfg[status] || cfg.unknown

  // Legacy fallback: rows stored before extractionSource existed on the
  // shared type carry only the coarse "✓ Verified — " prefix lib/matcher.ts
  // has always added to deterministic results. When extractionSource is
  // explicitly known (current matches), it takes priority and is always
  // the richer of the two.
  const legacyVerified = !extractionSource && text.startsWith('✓ Verified — ')
  const displayText = legacyVerified ? text.slice('✓ Verified — '.length) : text
  const badge = extractionSource ? SOURCE_BADGE_META[extractionSource] : null

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '5px 0' }}>
      <span aria-hidden style={{ color: c.color, fontWeight: 700, fontSize: '13px', flexShrink: 0, width: '14px', textAlign: 'center' }}>
        {c.icon}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: '12.5px', color: '#1C1B18', lineHeight: 1.5, display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
          {badge && (
            <span
              title={badge.title}
              style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '.03em', padding: '1px 6px', borderRadius: '99px', background: badge.bg, color: badge.color, flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              {badge.label}
            </span>
          )}
          {legacyVerified && (
            <span
              title="Computed from this patient's structured clinical records — not an AI judgment"
              style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '.03em', padding: '1px 6px', borderRadius: '99px', background: '#E1F5EE', color: '#0F6E56', flexShrink: 0 }}
            >
              VERIFIED
            </span>
          )}
          <span>{displayText}</span>
        </div>
        {detail && <div style={{ fontSize: '11px', color: '#72706A', marginTop: '1px' }}>{detail}</div>}
      </div>
    </div>
  )
}
