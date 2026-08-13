/**
 * components/ABDMConnector.tsx
 * Live ABDM health record fetch UI.
 *
 * Flow:
 *  1. Enter ABHA number → verify + initiate OTP
 *  2. Enter OTP → confirm + request health records
 *  3. Poll for status → show patient data on completion
 *  4. Confirm import → patient added to workspace
 */

import { useState, useEffect, useRef } from 'react'
// Inline sandbox test numbers (mirrors lib/abdm-client.ts — browser-safe)
const SANDBOX_TEST_ABHA = [
  { abha: '12-3456-7890-1234', name: 'Test Patient (Diabetes)',    otp: '123456' },
  { abha: '98-7654-3210-0001', name: 'Test Patient (Hypertension)', otp: '123456' },
  { abha: '11-2233-4455-6677', name: 'Test Patient (Oncology)',     otp: '123456' },
]

interface Props {
  brandColor: string
  onImported: (patient: any) => void
}

type Step = 'enter_abha' | 'enter_otp' | 'fetching' | 'preview' | 'done' | 'error'

const C = {
  teal: '#0F6E56', tealM: '#1D9E75', tealL: '#E1F5EE',
  amber: '#BA7517', amberL: '#FEF3E2',
  red: '#A32D2D', redL: '#FEF0EE',
  gray: '#72706A', border: '#E2E0D8', bg: '#F7F6F2', text: '#1C1B18',
}

export default function ABDMConnector({ brandColor, onImported }: Props) {
  const [step,      setStep]      = useState<Step>('enter_abha')
  const [abha,      setAbha]      = useState('')
  const [otp,       setOtp]       = useState('')
  const [loading,   setLoading]   = useState(false)
  const [sessionId, setSessionId] = useState('')
  const [patientInfo, setPatientInfo] = useState<any>(null)
  const [sandboxOTP,  setSandboxOTP]  = useState<string | null>(null)
  const [fetchStatus, setFetchStatus] = useState('')
  const [patient,   setPatient]   = useState<any>(null)
  const [error,     setError]     = useState('')
  const pollRef = useRef<NodeJS.Timeout | null>(null)

  // Format ABHA number as user types: XX-XXXX-XXXX-XXXX
  function formatABHA(raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, 14)
    if (digits.length <= 2)  return digits
    if (digits.length <= 6)  return `${digits.slice(0,2)}-${digits.slice(2)}`
    if (digits.length <= 10) return `${digits.slice(0,2)}-${digits.slice(2,6)}-${digits.slice(6)}`
    return `${digits.slice(0,2)}-${digits.slice(2,6)}-${digits.slice(6,10)}-${digits.slice(10)}`
  }

  async function initiateOTP(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const r = await fetch('/api/abdm/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ abha_number: abha }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)

      setSessionId(d.session_id)
      setPatientInfo(d.patient)
      setSandboxOTP(d.sandbox_otp || null)
      setStep('enter_otp')
    } catch (err: any) {
      setError(err.message)
    }
    setLoading(false)
  }

  async function verifyOTP(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const r = await fetch('/api/abdm/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, otp }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)

      if (d.status === 'complete') {
        // Sandbox: immediate result
        setPatient(d.patient)
        setStep('preview')
      } else if (d.status === 'pending') {
        // Live: poll for callback
        setStep('fetching')
        setFetchStatus(d.message)
        startPolling(sessionId)
      }
    } catch (err: any) {
      setError(err.message)
    }
    setLoading(false)
  }

  function startPolling(sid: string) {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/abdm/status?session_id=${sid}`)
        const d = await r.json()
        setFetchStatus(d.message)

        if (d.complete) {
          clearInterval(pollRef.current!)
          setPatient(d.patient)
          setStep('preview')
        } else if (d.failed) {
          clearInterval(pollRef.current!)
          setError(d.message)
          setStep('error')
        }
      } catch (e) {
        console.error('Poll error:', e)
      }
    }, 2000)
  }

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const S = {
    card:  { background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', padding: '20px 22px', marginBottom: '14px' } as any,
    label: { fontSize: '10px', fontWeight: '600', letterSpacing: '.06em', textTransform: 'uppercase', color: C.gray, display: 'block', marginBottom: '6px' } as any,
    input: { width: '100%', padding: '11px 14px', border: `1px solid ${C.border}`, borderRadius: '9px', fontSize: '15px', fontFamily: 'sans-serif', outline: 'none', boxSizing: 'border-box', letterSpacing: '0.06em', color: C.text } as any,
    btn:   (primary = true, disabled = false) => ({ padding: '11px 22px', background: disabled ? C.border : primary ? brandColor : '#fff', color: disabled ? C.gray : primary ? '#fff' : C.text, border: primary ? 'none' : `1px solid ${C.border}`, borderRadius: '9px', fontSize: '14px', fontWeight: '500', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'sans-serif', transition: 'all .15s', opacity: disabled ? .6 : 1 }) as any,
  }

  // ── STEP: ENTER ABHA ────────────────────────────────────────
  if (step === 'enter_abha') return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
        <span style={{ fontSize: '28px' }}>🏥</span>
        <div>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '500', color: C.text }}>Fetch from ABDM</h3>
          <p style={{ margin: '2px 0 0', fontSize: '12px', color: C.gray }}>Live health records via Ayushman Bharat Digital Mission</p>
        </div>
      </div>

      <div style={{ background: C.tealL, border: `1px solid rgba(15,110,86,.15)`, borderRadius: '8px', padding: '12px 14px', marginBottom: '18px', marginTop: '12px' }}>
        <div style={{ fontSize: '12px', color: C.teal, lineHeight: '1.6' }}>
          <strong style={{ display: 'block', marginBottom: '4px' }}>How it works</strong>
          Enter the patient's 14-digit ABHA number. They will receive an OTP on their registered mobile.
          Once verified, their health records are fetched directly from connected hospitals and imported into TrialMatch.
        </div>
      </div>

      <form onSubmit={initiateOTP}>
        <div style={{ marginBottom: '16px' }}>
          <label style={S.label}>ABHA Number (14 digits)</label>
          <input
            type="text"
            value={abha}
            onChange={e => setAbha(formatABHA(e.target.value))}
            placeholder="12-3456-7890-1234"
            style={{ ...S.input, fontFamily: 'monospace', fontSize: '18px', letterSpacing: '0.1em' }}
            maxLength={17}
            required
          />
          <div style={{ fontSize: '11.5px', color: C.gray, marginTop: '5px' }}>
            Format: XX-XXXX-XXXX-XXXX &nbsp;·&nbsp; Patient can find their ABHA number in the ABHA app or NHA Health ID card
          </div>
        </div>

        {error && (
          <div style={{ background: C.redL, border: `1px solid rgba(165,45,45,.2)`, borderRadius: '8px', padding: '11px 14px', color: C.red, fontSize: '13px', marginBottom: '14px' }}>
            {error}
          </div>
        )}

        <button type="submit" disabled={loading || abha.replace(/\D/g,'').length !== 14} style={{ ...S.btn(true, loading || abha.replace(/\D/g,'').length !== 14), width: '100%' }}>
          {loading ? 'Verifying ABHA…' : 'Verify & Send OTP →'}
        </button>
      </form>

      {/* Sandbox test numbers */}
      <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: `1px solid ${C.border}` }}>
        <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '.06em', color: C.gray, marginBottom: '8px' }}>
          Sandbox test numbers (OTP: 123456)
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {SANDBOX_TEST_ABHA.map(t => (
            <button
              key={t.abha}
              onClick={() => setAbha(t.abha)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: C.bg, border: `1px solid ${C.border}`, borderRadius: '8px', cursor: 'pointer', textAlign: 'left', fontFamily: 'sans-serif', transition: 'border-color .15s' }}
            >
              <div>
                <div style={{ fontFamily: 'monospace', fontSize: '13px', fontWeight: '600', color: C.text }}>{t.abha}</div>
                <div style={{ fontSize: '11.5px', color: C.gray }}>{t.name}</div>
              </div>
              <span style={{ fontSize: '11px', color: brandColor, fontWeight: '500' }}>Use →</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )

  // ── STEP: ENTER OTP ─────────────────────────────────────────
  if (step === 'enter_otp') return (
    <div>
      <button onClick={() => { setStep('enter_abha'); setError('') }} style={{ background: 'none', border: 'none', color: C.gray, fontSize: '13px', cursor: 'pointer', padding: '0 0 14px', fontFamily: 'sans-serif' }}>
        ← Back
      </button>

      {patientInfo && (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: '9px', padding: '14px 16px', marginBottom: '18px' }}>
          <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '.06em', color: C.gray, marginBottom: '8px' }}>Patient identified</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            {[
              ['Name',     patientInfo.name],
              ['Gender',   patientInfo.gender],
              ['Birth year', patientInfo.year_of_birth],
              ['Mobile',   patientInfo.mobile],
            ].map(([l, v]) => (
              <div key={l as string}>
                <div style={{ fontSize: '10px', color: C.gray }}>{l}</div>
                <div style={{ fontSize: '13px', fontWeight: '500', color: C.text }}>{v || '—'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {sandboxOTP && (
        <div style={{ background: C.amberL, border: `1px solid rgba(186,117,23,.2)`, borderRadius: '8px', padding: '10px 14px', marginBottom: '14px', fontSize: '12.5px', color: C.amber }}>
          <strong>Sandbox mode:</strong> Use OTP <strong style={{ fontFamily: 'monospace', fontSize: '15px', letterSpacing: '0.1em' }}>{sandboxOTP}</strong>
        </div>
      )}

      <form onSubmit={verifyOTP}>
        <div style={{ marginBottom: '16px' }}>
          <label style={S.label}>Enter OTP sent to {patientInfo?.mobile}</label>
          <input
            type="text"
            value={otp}
            onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="123456"
            style={{ ...S.input, fontFamily: 'monospace', fontSize: '24px', textAlign: 'center', letterSpacing: '0.3em' }}
            maxLength={6}
            autoFocus
            required
          />
          <div style={{ fontSize: '11.5px', color: C.gray, marginTop: '5px', textAlign: 'center' }}>
            OTP expires in 10 minutes &nbsp;·&nbsp;
            <button type="button" onClick={() => { setOtp(''); initiateOTP({ preventDefault: () => {} } as any) }} style={{ color: brandColor, background: 'none', border: 'none', cursor: 'pointer', fontSize: '11.5px', fontFamily: 'sans-serif' }}>
              Resend OTP
            </button>
          </div>
        </div>

        {error && (
          <div style={{ background: C.redL, borderRadius: '8px', padding: '10px 14px', color: C.red, fontSize: '13px', marginBottom: '14px' }}>
            {error}
          </div>
        )}

        <button type="submit" disabled={loading || otp.length < 6} style={{ ...S.btn(true, loading || otp.length < 6), width: '100%' }}>
          {loading ? 'Verifying…' : 'Verify OTP & Fetch Records →'}
        </button>
      </form>
    </div>
  )

  // ── STEP: FETCHING ──────────────────────────────────────────
  if (step === 'fetching') return (
    <div style={{ textAlign: 'center', padding: '40px 20px' }}>
      <div style={{ width: '44px', height: '44px', border: `3px solid ${C.tealL}`, borderTopColor: C.tealM, borderRadius: '50%', animation: 'spin .8s linear infinite', margin: '0 auto 18px' }}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <h3 style={{ margin: '0 0 8px', fontSize: '16px', fontWeight: '500', color: C.text }}>Fetching health records</h3>
      <p style={{ fontSize: '13px', color: C.gray, lineHeight: '1.6', maxWidth: '320px', margin: '0 auto 16px' }}>{fetchStatus}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxWidth: '280px', margin: '0 auto' }}>
        {[
          { label: 'OTP verified', done: true },
          { label: 'Consent granted', done: true },
          { label: 'Fetching from connected hospitals', done: fetchStatus.includes('parsing') || fetchStatus.includes('received') },
          { label: 'Parsing FHIR records', done: fetchStatus.includes('import') || fetchStatus.includes('complete') },
        ].map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: s.done ? C.teal : C.gray }}>
            <span style={{ width: '18px', height: '18px', borderRadius: '50%', background: s.done ? C.teal : C.bg, border: `1.5px solid ${s.done ? C.teal : C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '10px', color: '#fff' }}>
              {s.done ? '✓' : ''}
            </span>
            {s.label}
          </div>
        ))}
      </div>
    </div>
  )

  // ── STEP: PREVIEW ───────────────────────────────────────────
  if (step === 'preview' && patient) return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
        <span style={{ fontSize: '28px' }}>✅</span>
        <div>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '500', color: C.text }}>Health records fetched</h3>
          <p style={{ margin: '2px 0 0', fontSize: '12px', color: C.gray }}>Review the imported data before confirming</p>
        </div>
      </div>

      <div style={S.card}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          {[
            ['Patient code',  patient.patient_code],
            ['Age / Sex',     `${patient.age}y · ${patient.sex}`],
            ['Location',      patient.location],
            ['Diagnosis',     patient.diagnosis],
            ['Medications',   patient.medications || 'None recorded'],
            ['Lab values',    patient.labs || 'None recorded'],
            ['Co-morbidities', patient.comorbidities || 'None'],
            ['Allergies',     patient.allergies || 'None'],
          ].map(([label, value]) => (
            <div key={label as string}>
              <div style={{ fontSize: '9.5px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '.06em', color: C.gray, marginBottom: '2px' }}>{label}</div>
              <div style={{ fontSize: '13px', color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value || '—'}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ background: C.tealL, borderRadius: '8px', padding: '11px 14px', marginBottom: '16px', fontSize: '12.5px', color: C.teal, lineHeight: '1.5' }}>
        ✓ Patient record has been created in your workspace. You can now run a trial match or edit the record to add more details.
      </div>

      <div style={{ display: 'flex', gap: '10px' }}>
        <button style={{ ...S.btn(), flex: 1 }} onClick={() => onImported(patient)}>
          View patient & run match →
        </button>
        <button style={{ ...S.btn(false) }} onClick={() => { setStep('enter_abha'); setAbha(''); setOtp(''); setPatient(null) }}>
          Fetch another
        </button>
      </div>
    </div>
  )

  // ── STEP: ERROR ─────────────────────────────────────────────
  if (step === 'error') return (
    <div style={{ textAlign: 'center', padding: '32px 20px' }}>
      <div style={{ fontSize: '40px', marginBottom: '12px' }}>⚠️</div>
      <h3 style={{ margin: '0 0 8px', fontSize: '16px', fontWeight: '500', color: C.text }}>Fetch failed</h3>
      <p style={{ fontSize: '13px', color: C.gray, marginBottom: '20px', maxWidth: '320px', margin: '0 auto 20px' }}>{error}</p>
      <button style={S.btn()} onClick={() => { setStep('enter_abha'); setError(''); setOtp(''); }}>
        Try again
      </button>
    </div>
  )

  return null
}
