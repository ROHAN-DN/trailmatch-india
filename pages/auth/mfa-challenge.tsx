import { useState, useEffect } from 'react'
import { useSession, signOut } from 'next-auth/react'
import { useRouter } from 'next/router'
import Head from 'next/head'

const card  = { background:'#fff', border:'1px solid #E2E0D8', borderRadius:'12px', padding:'28px 24px' } as any
const label = { display:'block', fontSize:'11px', fontWeight:'600', letterSpacing:'.05em', textTransform:'uppercase', color:'#72706A', marginBottom:'5px' } as any
const input = { width:'100%', padding:'10px 12px', border:'1px solid #E2E0D8', borderRadius:'8px', fontSize:'14px', fontFamily:'sans-serif', outline:'none', boxSizing:'border-box' } as any
const btn   = (disabled: boolean) => ({ width:'100%', padding:'11px', background: disabled ? '#B4B2A9' : '#0F6E56', color:'#fff', border:'none', borderRadius:'8px', fontSize:'14px', fontWeight:'500', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily:'sans-serif' } as any)

export default function MFAChallenge() {
  const { data: session, status, update } = useSession()
  const router = useRouter()
  const mfaStatus = (session?.user as any)?.mfaStatus as string | undefined

  const [phase, setPhase]   = useState<'loading' | 'enroll-start' | 'enroll-confirm' | 'enroll-codes' | 'verify'>('loading')
  const [qrCode, setQrCode] = useState('')
  const [secret, setSecret] = useState('')
  const [code, setCode]     = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [error, setError]   = useState('')
  const [busy, setBusy]     = useState(false)

  const destination = typeof router.query.from === 'string' ? router.query.from : '/dashboard'

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') { router.replace('/auth/signin'); return }
    if (mfaStatus === 'verified' || mfaStatus === 'not_required') { router.replace(destination); return }
    setPhase(mfaStatus === 'must_enroll' ? 'enroll-start' : 'verify')
  }, [status, mfaStatus])

  async function startEnroll() {
    setBusy(true); setError('')
    const r = await fetch('/api/mfa/setup', { method: 'POST' })
    setBusy(false)
    if (!r.ok) return setError('Could not start setup. Please try again.')
    const data = await r.json()
    setQrCode(data.qrCodeDataUrl); setSecret(data.secret)
    setPhase('enroll-confirm')
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('')
    const r = await fetch('/api/mfa/verify-setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    })
    setBusy(false)
    const data = await r.json()
    if (!r.ok) return setError(data.error || 'That code was not valid.')
    setBackupCodes(data.backupCodes)
    setPhase('enroll-codes')
    setCode('')
  }

  async function finishEnroll() {
    await update({ mfaVerified: true })
    router.replace(destination)
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('')
    const r = await fetch('/api/mfa/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    })
    setBusy(false)
    const data = await r.json()
    if (!r.ok) { setError(data.error || 'Invalid code.'); return }
    await update({ mfaVerified: true })
    router.replace(destination)
  }

  return (
    <>
      <Head><title>Verify it's you — TrialMatch India</title></Head>
      <div style={{ minHeight:'100vh', background:'#F7F6F2', display:'flex', alignItems:'center', justifyContent:'center', padding:'20px', fontFamily:'sans-serif' }}>
        <div style={{ width:'100%', maxWidth:'400px' }}>
          <div style={{ textAlign:'center', marginBottom:'20px' }}>
            <div style={{ display:'inline-block', background:'#0F6E56', padding:'10px 20px', borderRadius:'10px' }}>
              <span style={{ color:'#fff', fontSize:'20px', fontWeight:'500', letterSpacing:'-.2px' }}>TrialMatch India</span>
            </div>
          </div>

          <div style={card}>
            {phase === 'loading' && <p style={{ fontSize:'13px', color:'#72706A', textAlign:'center' }}>Loading…</p>}

            {phase === 'enroll-start' && (
              <>
                <h2 style={{ margin:'0 0 8px', fontSize:'18px', fontWeight:'500' }}>Set up two-factor authentication</h2>
                <p style={{ fontSize:'13px', color:'#72706A', lineHeight:'1.6', margin:'0 0 20px' }}>
                  Your role requires an extra step to sign in. You'll need an authenticator app
                  (Google Authenticator, Authy, or similar) on your phone.
                </p>
                <button style={btn(busy)} disabled={busy} onClick={startEnroll}>{busy ? 'Starting…' : 'Get started'}</button>
              </>
            )}

            {phase === 'enroll-confirm' && (
              <form onSubmit={confirmEnroll}>
                <h2 style={{ margin:'0 0 12px', fontSize:'18px', fontWeight:'500' }}>Scan this code</h2>
                {qrCode && <img src={qrCode} alt="Scan with your authenticator app" style={{ display:'block', margin:'0 auto 12px', border:'1px solid #E2E0D8', borderRadius:'8px' }} width={200} height={200} />}
                <p style={{ fontSize:'11px', color:'#72706A', marginBottom:'16px', textAlign:'center' }}>
                  Can't scan? Enter this key manually: <code style={{ background:'#F7F6F2', padding:'2px 6px', borderRadius:'4px' }}>{secret}</code>
                </p>
                <label style={label}>Enter the 6-digit code from your app</label>
                <input style={{ ...input, marginBottom:'12px', textAlign:'center', letterSpacing:'.2em', fontSize:'18px' }} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" autoFocus />
                {error && <p style={{ color:'#B53030', fontSize:'12px', margin:'0 0 12px' }}>{error}</p>}
                <button type="submit" style={btn(busy || code.length !== 6)} disabled={busy || code.length !== 6}>{busy ? 'Confirming…' : 'Confirm'}</button>
              </form>
            )}

            {phase === 'enroll-codes' && (
              <>
                <h2 style={{ margin:'0 0 8px', fontSize:'18px', fontWeight:'500' }}>Save your backup codes</h2>
                <p style={{ fontSize:'12px', color:'#B53030', fontWeight:'600', margin:'0 0 8px' }}>
                  These won't be shown again.
                </p>
                <p style={{ fontSize:'12px', color:'#72706A', marginBottom:'14px', lineHeight:'1.6' }}>
                  Each code works once, if you ever lose access to your authenticator app.
                </p>
                <div style={{ background:'#F7F6F2', borderRadius:'8px', padding:'14px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px', fontFamily:'monospace', fontSize:'13px', marginBottom:'18px' }}>
                  {backupCodes.map(c => <div key={c}>{c}</div>)}
                </div>
                <button style={btn(false)} onClick={finishEnroll}>I've saved these codes — continue</button>
              </>
            )}

            {phase === 'verify' && (
              <form onSubmit={verify}>
                <h2 style={{ margin:'0 0 8px', fontSize:'18px', fontWeight:'500' }}>Verify it's you</h2>
                <p style={{ fontSize:'13px', color:'#72706A', lineHeight:'1.6', margin:'0 0 18px' }}>
                  Enter the code from your authenticator app, or one of your backup codes.
                </p>
                <label style={label}>Code</label>
                <input style={{ ...input, marginBottom:'12px', textAlign:'center', letterSpacing:'.1em', fontSize:'16px' }} value={code} onChange={e => setCode(e.target.value.trim())} placeholder="000000" autoFocus />
                {error && <p style={{ color:'#B53030', fontSize:'12px', margin:'0 0 12px' }}>{error}</p>}
                <button type="submit" style={btn(busy || !code)} disabled={busy || !code}>{busy ? 'Verifying…' : 'Verify'}</button>
              </form>
            )}
          </div>

          {phase !== 'loading' && (
            <p style={{ textAlign:'center', fontSize:'12px', marginTop:'16px' }}>
              <button onClick={() => signOut({ callbackUrl: '/auth/signin' })} style={{ background:'none', border:'none', color:'#72706A', textDecoration:'underline', cursor:'pointer', fontSize:'12px', fontFamily:'sans-serif' }}>
                Sign out instead
              </button>
            </p>
          )}
        </div>
      </div>
    </>
  )
}
