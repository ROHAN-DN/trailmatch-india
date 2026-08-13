/**
 * components/SponsorOnboarding.tsx
 * First-run onboarding wizard for pharma / biotech sponsor orgs.
 *
 * Shown when: org.is_sponsor = true AND no protocols created yet.
 * 3 steps:
 *   1. Welcome — confirm org name + primary therapeutic area
 *   2. Upload first protocol (text or PDF) — same form as SponsorPortal
 *   3. Done — "Run your first feasibility" CTA
 *
 * Can be dismissed at any step ("Skip for now").
 * Dismissal stored in localStorage so it only shows once per browser session.
 */

import { useState, useRef } from 'react'
import type { ProtocolPhase } from '../lib/types/domain'

interface Props {
  orgName:    string
  brandColor: string
  onComplete: () => void
  onDismiss:  () => void
}

type Step = 1 | 2 | 3

const THERAPEUTIC_AREAS = [
  'Oncology', 'Cardiology', 'Metabolic Diseases / Diabetes', 'Neurology',
  'Respiratory', 'Infectious Diseases', 'Rare Diseases', 'Immunology / Rheumatology',
  'Gastroenterology', 'Dermatology', 'Ophthalmology', 'Other',
]

const PHASES: ProtocolPhase[] = ['Phase I','Phase II','Phase III','Phase IV','Phase I/II','Phase II/III']

const API_HEADERS = { 'Content-Type': 'application/json' }

export default function SponsorOnboarding({ orgName, brandColor, onComplete, onDismiss }: Props) {
  const [step,      setStep]      = useState<Step>(1)
  const [area,      setArea]      = useState('')
  const [inputMode, setInputMode] = useState<'text' | 'pdf'>('text')
  const [title,     setTitle]     = useState('')
  const [rawText,   setRawText]   = useState('')
  const [phase,     setPhase]     = useState<ProtocolPhase|''>('')
  const [parsing,   setParsing]   = useState(false)
  const [pdfName,   setPdfName]   = useState<string | null>(null)
  const [parsed,    setParsed]    = useState<any>(null)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [firstProto,setFirstProto]= useState<any>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const bc = brandColor

  // ── Styles ────────────────────────────────────────────────────────────────
  const btn = (primary = false): React.CSSProperties => ({
    padding: '10px 20px', background: primary ? bc : '#fff',
    color: primary ? '#fff' : '#1C1B18',
    border: primary ? 'none' : '1px solid #E2E0D8',
    borderRadius: '9px', fontSize: '13px', fontWeight: 500,
    cursor: 'pointer', fontFamily: 'sans-serif',
    display: 'inline-flex', alignItems: 'center', gap: '7px',
  })
  const input: React.CSSProperties = {
    width: '100%', padding: '10px 12px', border: '1px solid #E2E0D8',
    borderRadius: '8px', fontSize: '13px', fontFamily: 'sans-serif',
    outline: 'none', boxSizing: 'border-box',
  }

  // ── Handlers ──────────────────────────────────────────────────────────────
  async function handlePdfSelect(file: File) {
    if (!file.name.toLowerCase().endsWith('.pdf')) { setError('Please select a PDF file.'); return }
    if (file.size > 10 * 1024 * 1024) { setError('PDF must be under 10 MB.'); return }
    setPdfName(file.name); setError(null); setParsed(null); setParsing(true)

    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload  = () => resolve((reader.result as string).split(',')[1])
        reader.onerror = () => reject(new Error('Failed to read file'))
        reader.readAsDataURL(file)
      })
      const r = await fetch('/api/sponsor/parse-pdf', {
        method: 'POST', headers: API_HEADERS,
        body: JSON.stringify({ pdf_base64: base64, media_type: 'application/pdf' }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error?.message || 'PDF parse failed.'); setParsing(false); return }
      setParsed(d.parsed)
      if (d.parsed.title    && !title)  setTitle(d.parsed.title)
      if (d.parsed.phase    && !phase)  setPhase(d.parsed.phase)
      if (d.parsed.therapeutic_area && !area) setArea(d.parsed.therapeutic_area)
    } catch (e: any) { setError(e.message || 'Failed to process PDF') }
    setParsing(false)
  }

  async function parseTextWithAI() {
    if (!rawText.trim()) { setError('Paste your protocol text first.'); return }
    setParsing(true); setError(null); setParsed(null)
    const r = await fetch('/api/sponsor/protocols', {
      method: 'POST', headers: API_HEADERS,
      body: JSON.stringify({ title: title || 'First protocol', raw_text: rawText, phase: phase||undefined, therapeutic_area: area||undefined, parse_with_ai: true }),
    })
    const d = await r.json()
    setParsing(false)
    if (!r.ok) { setError(d.error?.message || 'Parse failed.'); return }
    setParsed(d.protocol)
    setFirstProto(d.protocol)
    if (d.protocol.title && !title) setTitle(d.protocol.title)
    if (d.protocol.phase && !phase) setPhase(d.protocol.phase)
    if (d.protocol.therapeutic_area && !area) setArea(d.protocol.therapeutic_area)
  }

  async function saveAndProceed() {
    if (!title.trim()) { setError('Please enter a protocol title.'); return }
    setSaving(true); setError(null)
    const body: any = { title, phase: phase||undefined, therapeutic_area: area||undefined, parse_with_ai: false }
    if (parsed) {
      body.inclusion_criteria = parsed.inclusion_criteria || []
      body.exclusion_criteria = parsed.exclusion_criteria || []
      body.mapped_codes       = parsed.mapped_codes
      body.raw_text           = rawText || undefined
    } else if (rawText) {
      body.raw_text           = rawText
    }
    const r = await fetch('/api/sponsor/protocols', { method: 'POST', headers: API_HEADERS, body: JSON.stringify(body) })
    const d = await r.json()
    setSaving(false)
    if (!r.ok) { setError(d.error?.message || 'Save failed.'); return }
    setFirstProto(d.protocol)
    setStep(3)
  }

  // ── Step dots ─────────────────────────────────────────────────────────────
  const StepDots = () => (
    <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginBottom: '28px' }}>
      {([1, 2, 3] as Step[]).map(s => (
        <div key={s} style={{ width: s === step ? '24px' : '8px', height: '8px', borderRadius: '99px', background: s === step ? bc : s < step ? `${bc}66` : '#E2E0D8', transition: 'all .3s' }}/>
      ))}
    </div>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: '#fff', borderRadius: '14px', padding: '32px 28px', maxWidth: '560px', width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 80px rgba(0,0,0,.22)' }}>

        {/* ── Step 1: Welcome ─────────────────────────────────────────── */}
        {step === 1 && (
          <>
            <StepDots/>
            <div style={{ textAlign: 'center', marginBottom: '24px' }}>
              <div style={{ fontSize: '36px', marginBottom: '10px' }}>👋</div>
              <h2 style={{ margin: '0 0 8px', fontSize: '20px', fontWeight: 500 }}>
                Welcome to TrialMatch India
              </h2>
              <p style={{ margin: 0, fontSize: '13px', color: '#72706A', lineHeight: 1.65 }}>
                You're set up as a sponsor organisation. In 2 minutes you'll have your first
                site feasibility study — showing which hospitals across India have the right
                patients for your trial.
              </p>
            </div>

            <div style={{ marginBottom: '14px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: '#72706A', display: 'block', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                Your primary therapeutic area
              </label>
              <select value={area} onChange={e => setArea(e.target.value)} style={{ ...input, background: '#fff' }}>
                <option value="">Select…</option>
                {THERAPEUTIC_AREAS.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              <p style={{ fontSize: '11px', color: '#B4B2A9', marginTop: '5px' }}>
                This helps us prioritise which sites to show you in feasibility results.
              </p>
            </div>

            <div style={{ background: '#EAF3DE', border: '1px solid #C0DD97', borderRadius: '9px', padding: '12px 14px', marginBottom: '20px', fontSize: '12.5px', color: '#27500A', lineHeight: 1.65 }}>
              <strong>Privacy guarantee:</strong> You will only see aggregate patient counts per site.
              No individual patient names, records, or identifiers are ever accessible to sponsor accounts.
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button style={{ ...btn(true), flex: 1, justifyContent: 'center' }}
                onClick={() => { setStep(2) }}
                disabled={!area}>
                Next: Upload a protocol →
              </button>
              <button style={btn()} onClick={onDismiss}>Skip for now</button>
            </div>
          </>
        )}

        {/* ── Step 2: Protocol upload ──────────────────────────────────── */}
        {step === 2 && (
          <>
            <StepDots/>
            <h2 style={{ margin: '0 0 6px', fontSize: '17px', fontWeight: 500 }}>Upload your first protocol</h2>
            <p style={{ margin: '0 0 18px', fontSize: '12px', color: '#72706A', lineHeight: 1.65 }}>
              Paste the eligibility criteria or upload the protocol PDF.
              Claude AI will extract all inclusion and exclusion criteria automatically.
            </p>

            {/* Input mode toggle */}
            <div style={{ display: 'flex', gap: '6px', background: '#F7F6F2', borderRadius: '8px', padding: '4px', marginBottom: '14px' }}>
              {(['text', 'pdf'] as const).map(mode => (
                <button key={mode} onClick={() => { setInputMode(mode); setError(null); setParsed(null); setPdfName(null) }}
                  style={{ flex: 1, padding: '7px', fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'sans-serif',
                    background: inputMode === mode ? '#fff' : 'transparent',
                    color: inputMode === mode ? '#1C1B18' : '#72706A',
                    border: inputMode === mode ? '1px solid #E2E0D8' : '1px solid transparent',
                    borderRadius: '6px', transition: 'all .15s' }}>
                  {mode === 'text' ? '📝 Paste text' : '📄 Upload PDF'}
                </button>
              ))}
            </div>

            {/* Title + phase */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: '10px', marginBottom: '12px' }}>
              <div>
                <label style={{ fontSize: '11px', fontWeight: 600, color: '#72706A', display: 'block', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '.05em' }}>Protocol title</label>
                <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Phase III in T2DM" style={input}/>
              </div>
              <div>
                <label style={{ fontSize: '11px', fontWeight: 600, color: '#72706A', display: 'block', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '.05em' }}>Phase</label>
                <select value={phase} onChange={e => setPhase(e.target.value as ProtocolPhase)} style={{ ...input, background: '#fff' }}>
                  <option value="">Select…</option>
                  {PHASES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>

            {/* Text mode */}
            {inputMode === 'text' && !parsed && (
              <div style={{ marginBottom: '12px' }}>
                <textarea value={rawText} onChange={e => setRawText(e.target.value)} rows={7}
                  placeholder={"Paste eligibility criteria:\n\nInclusion:\n• Age 30–70 years\n• T2DM diagnosis\n• HbA1c 8.0–11.0%\n\nExclusion:\n• Prior GLP-1 use\n• eGFR < 45 mL/min"}
                  style={{ ...input, resize: 'vertical', lineHeight: 1.6 }}/>
              </div>
            )}

            {/* PDF mode */}
            {inputMode === 'pdf' && !parsed && (
              <div style={{ marginBottom: '12px' }}>
                <div onClick={() => fileRef.current?.click()}
                  style={{ border: `2px dashed ${bc}44`, borderRadius: '9px', padding: '28px 20px', textAlign: 'center', cursor: 'pointer', background: `${bc}05`, marginBottom: '8px' }}>
                  {parsing ? (
                    <div style={{ fontSize: '13px', color: '#72706A' }}>⏳ Claude is reading the PDF…</div>
                  ) : pdfName ? (
                    <div>
                      <div style={{ fontSize: '20px', marginBottom: '5px' }}>📄</div>
                      <div style={{ fontSize: '13px', fontWeight: 500 }}>{pdfName}</div>
                      <div style={{ fontSize: '11px', color: '#72706A', marginTop: '3px' }}>Click to change</div>
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: '24px', marginBottom: '6px' }}>📄</div>
                      <div style={{ fontWeight: 500, fontSize: '13px', marginBottom: '3px' }}>Click to upload PDF</div>
                      <div style={{ fontSize: '11px', color: '#72706A' }}>Max 10 MB · Claude reads it natively</div>
                    </>
                  )}
                </div>
                <input ref={fileRef} type="file" accept=".pdf" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) handlePdfSelect(f) }}/>
              </div>
            )}

            {/* Parsed result */}
            {parsed && (
              <div style={{ background: '#EAF3DE', border: '1px solid #C0DD97', borderRadius: '9px', padding: '11px 13px', marginBottom: '12px', fontSize: '12.5px', color: '#27500A', lineHeight: 1.6 }}>
                ✓ Extracted {(parsed.inclusion_criteria||[]).length} inclusion +{' '}
                {(parsed.exclusion_criteria||[]).length} exclusion criteria
                {parsed.parse_confidence != null && (
                  <span style={{ marginLeft: '8px', fontSize: '11px', opacity: 0.8 }}>
                    ({Math.round(parsed.parse_confidence * 100)}% confidence)
                  </span>
                )}
              </div>
            )}

            {error && <div style={{ background: '#FEF0EE', border: '1px solid #F0959566', borderRadius: '8px', padding: '9px 12px', fontSize: '12.5px', color: '#A32D2D', marginBottom: '12px' }}>{error}</div>}

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {!parsed && inputMode === 'text' && (
                <button style={btn(true)} onClick={parseTextWithAI} disabled={parsing || !rawText.trim()}>
                  {parsing ? '⏳ Parsing…' : '✨ Parse with AI'}
                </button>
              )}
              {(parsed || (inputMode === 'text' && rawText.trim()) || (inputMode === 'pdf' && pdfName)) && (
                <button style={btn(true)} onClick={saveAndProceed} disabled={saving || !title.trim()}>
                  {saving ? 'Saving…' : 'Save & continue →'}
                </button>
              )}
              <button style={btn()} onClick={() => setStep(1)}>← Back</button>
              <button style={{ ...btn(), marginLeft: 'auto', color: '#72706A' }} onClick={onDismiss}>Skip</button>
            </div>
          </>
        )}

        {/* ── Step 3: Done ─────────────────────────────────────────────── */}
        {step === 3 && (
          <>
            <StepDots/>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '48px', marginBottom: '12px' }}>🎉</div>
              <h2 style={{ margin: '0 0 8px', fontSize: '18px', fontWeight: 500 }}>You're ready to go</h2>
              <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#72706A', lineHeight: 1.65 }}>
                Protocol <strong style={{ color: '#1C1B18' }}>{firstProto?.title || 'saved'}</strong> is ready.
                Run a feasibility study to see which hospitals across India have matching patients.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '22px', textAlign: 'left' }}>
                {[
                  { icon: '🔬', title: 'Site feasibility', desc: `See qualifying patient counts at India's top research sites` },
                  { icon: '📩', title: 'Site engagement', desc: 'Send engagement requests to coordinators at matching sites' },
                  { icon: '🏥', title: 'Site network', desc: '500+ India research sites with specialties and PI contacts' },
                  { icon: '📊', title: 'Real-time status', desc: 'Track engagement requests from "Notified" to "Meeting booked"' },
                ].map(f => (
                  <div key={f.title} style={{ background: '#F7F6F2', borderRadius: '9px', padding: '12px 14px' }}>
                    <div style={{ fontSize: '18px', marginBottom: '4px' }}>{f.icon}</div>
                    <div style={{ fontWeight: 500, fontSize: '13px', marginBottom: '3px' }}>{f.title}</div>
                    <div style={{ fontSize: '11.5px', color: '#72706A', lineHeight: 1.5 }}>{f.desc}</div>
                  </div>
                ))}
              </div>

              <button style={{ ...btn(true), width: '100%', justifyContent: 'center', padding: '12px' }} onClick={onComplete}>
                Run my first feasibility study →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
