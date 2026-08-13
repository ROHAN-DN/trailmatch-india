import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'

const S = {
  card:  { background:'#fff', border:'1px solid #E2E0D8', borderRadius:'10px', padding:'20px 22px', marginBottom:'14px' } as any,
  label: { fontSize:'10px', fontWeight:'600', letterSpacing:'.06em', textTransform:'uppercase', color:'#72706A', display:'block', marginBottom:'5px' } as any,
  input: { width:'100%', padding:'9px 12px', border:'1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', fontFamily:'sans-serif', outline:'none', boxSizing:'border-box' } as any,
}

interface Props { brandColor: string }

export default function MFASettingsCard({ brandColor }: Props) {
  const { data: session, update } = useSession()
  const mfaStatus = (session?.user as any)?.mfaStatus as string | undefined

  const [stage, setStage]           = useState<'idle' | 'enrolling' | 'confirming' | 'backup-codes' | 'disabling'>('idle')
  const [qrCode, setQrCode]         = useState('')
  const [secret, setSecret]         = useState('')
  const [code, setCode]             = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [msg, setMsg]               = useState('')
  const [busy, setBusy]             = useState(false)

  const isEnabled = mfaStatus === 'verified' || mfaStatus === 'must_verify'
  const btnStyle  = { padding:'9px 20px', background: brandColor, color:'#fff', border:'none', borderRadius:'8px', fontSize:'13px', fontWeight:'500', cursor:'pointer', fontFamily:'sans-serif' } as any
  const btnGhost  = { ...btnStyle, background:'transparent', color:'#72706A', border:'1px solid #E2E0D8' } as any

  async function startEnroll() {
    setBusy(true); setMsg('')
    const r = await fetch('/api/mfa/setup', { method: 'POST' })
    setBusy(false)
    if (!r.ok) return setMsg('Could not start MFA setup. Please try again.')
    const data = await r.json()
    setQrCode(data.qrCodeDataUrl); setSecret(data.secret)
    setStage('confirming')
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg('')
    const r = await fetch('/api/mfa/verify-setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    })
    setBusy(false)
    const data = await r.json()
    if (!r.ok) return setMsg(data.error || 'That code was not valid.')
    setBackupCodes(data.backupCodes)
    setStage('backup-codes')
    setCode('')
  }

  async function finishEnroll() {
    // Enrolling and confirming a real code already proves current
    // possession — no reason to immediately force a second, separate
    // verification right after. update() triggers the jwt callback with
    // trigger:'update', which is what actually flips token.mfaVerified
    // (see pages/api/auth/[...nextauth].ts).
    await update({ mfaVerified: true })
    setStage('idle')
    window.location.reload() // simplest reliable way to pick up the refreshed session everywhere in the app, not just this component's local state
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg('')
    const r = await fetch('/api/mfa/disable', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    })
    setBusy(false)
    const data = await r.json()
    if (!r.ok) return setMsg(data.error || 'Could not disable MFA.')
    setStage('idle'); setCode('')
    window.location.reload()
  }

  return (
    <div style={S.card}>
      <div style={{ fontSize:'13px', fontWeight:'600', marginBottom:'4px' }}>Two-factor authentication</div>
      <div style={{ fontSize:'12px', color:'#72706A', marginBottom:'14px', lineHeight:'1.6' }}>
        Adds a second step (a code from an authenticator app) when signing in. {mfaStatus === 'must_enroll' && (
          <strong>Required for your role — you'll be asked to set this up the next time you sign in.</strong>
        )}
      </div>

      {stage === 'idle' && (
        isEnabled ? (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'14px' }}>
              <span style={{ background:'#E1F5EE', color:'#0F6E56', fontSize:'11px', fontWeight:'700', padding:'3px 10px', borderRadius:'99px' }}>ENABLED</span>
            </div>
            <button style={btnGhost} onClick={() => setStage('disabling')}>Disable two-factor authentication</button>
          </>
        ) : (
          <button style={btnStyle} disabled={busy} onClick={startEnroll}>
            {busy ? 'Starting…' : 'Set up two-factor authentication'}
          </button>
        )
      )}

      {stage === 'confirming' && (
        <form onSubmit={confirmEnroll}>
          <p style={{ fontSize:'12px', color:'#1C1B18', marginBottom:'10px' }}>
            Scan this code with an authenticator app (Google Authenticator, Authy, or similar), then enter the 6-digit code it shows.
          </p>
          {qrCode && <img src={qrCode} alt="Scan with your authenticator app" style={{ display:'block', margin:'0 0 12px', border:'1px solid #E2E0D8', borderRadius:'8px' }} width={180} height={180} />}
          <p style={{ fontSize:'11px', color:'#72706A', marginBottom:'12px' }}>
            Can't scan? Enter this key manually: <code style={{ background:'#F7F6F2', padding:'2px 6px', borderRadius:'4px' }}>{secret}</code>
          </p>
          <label style={S.label}>6-digit code</label>
          <input style={{ ...S.input, marginBottom:'10px', maxWidth:'160px' }} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" autoFocus />
          <div style={{ display:'flex', gap:'10px' }}>
            <button type="submit" style={btnStyle} disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Confirm'}</button>
            <button type="button" style={btnGhost} onClick={() => { setStage('idle'); setCode(''); setMsg('') }}>Cancel</button>
          </div>
        </form>
      )}

      {stage === 'backup-codes' && (
        <div>
          <p style={{ fontSize:'12px', color:'#A32D2D', fontWeight:'600', marginBottom:'8px' }}>
            Save these backup codes now — they won't be shown again.
          </p>
          <p style={{ fontSize:'11px', color:'#72706A', marginBottom:'12px' }}>
            Each works once, if you ever lose access to your authenticator app.
          </p>
          <div style={{ background:'#F7F6F2', borderRadius:'8px', padding:'14px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px', fontFamily:'monospace', fontSize:'13px', marginBottom:'14px' }}>
            {backupCodes.map(c => <div key={c}>{c}</div>)}
          </div>
          <button style={btnStyle} onClick={finishEnroll}>I've saved these codes — done</button>
        </div>
      )}

      {stage === 'disabling' && (
        <form onSubmit={disable}>
          <label style={S.label}>Enter a current 6-digit code to confirm</label>
          <input style={{ ...S.input, marginBottom:'10px', maxWidth:'160px' }} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" autoFocus />
          <div style={{ display:'flex', gap:'10px' }}>
            <button type="submit" style={{ ...btnStyle, background:'#A32D2D' }} disabled={busy || code.length !== 6}>{busy ? 'Disabling…' : 'Disable'}</button>
            <button type="button" style={btnGhost} onClick={() => { setStage('idle'); setCode(''); setMsg('') }}>Cancel</button>
          </div>
        </form>
      )}

      {msg && <p style={{ fontSize:'12px', color:'#A32D2D', marginTop:'12px' }}>{msg}</p>}
    </div>
  )
}
