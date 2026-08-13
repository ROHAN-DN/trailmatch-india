import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { GetServerSideProps } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../api/auth/[...nextauth]'
import Head from 'next/head'

export default function SignIn() {
  const [email, setEmail]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [sent, setSent]         = useState(false)
  const [error, setError]       = useState('')

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault()
    if (!email) return
    setLoading(true); setError('')
    const res = await signIn('email', { email, redirect: false, callbackUrl: '/dashboard' })
    setLoading(false)
    if (res?.error) setError('Something went wrong. Please try again.')
    else setSent(true)
  }

  async function handleGoogle() {
    setLoading(true)
    await signIn('google', { callbackUrl: '/dashboard' })
  }

  return (
    <>
      <Head>
        <title>Sign in — TrialMatch India</title>
      </Head>
      <div style={{ minHeight:'100vh', background:'#F7F6F2', display:'flex', alignItems:'center', justifyContent:'center', padding:'20px', fontFamily:'sans-serif' }}>
        <div style={{ width:'100%', maxWidth:'400px' }}>

          {/* Logo */}
          <div style={{ textAlign:'center', marginBottom:'28px' }}>
            <div style={{ display:'inline-block', background:'#0F6E56', padding:'10px 20px', borderRadius:'10px' }}>
              <span style={{ color:'#fff', fontSize:'20px', fontWeight:'500', letterSpacing:'-.2px' }}>TrialMatch India</span>
            </div>
            <p style={{ color:'#72706A', fontSize:'13px', margin:'10px 0 0', lineHeight:'1.5' }}>
              Clinical trial matching built for India —<br/>
              CTRI + CT.gov, ABDM live records, DPDP Act compliant
            </p>
          </div>

          {/* India-specific trust signals — this is the one place a first-time
              prospect lands, and the previous version said nothing that
              distinguishes this from any global tool pointing at India */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px', marginBottom:'20px' }}>
            {[
              { icon:'🇮🇳', title:'CTRI + CT.gov', desc:'India & global trial registries' },
              { icon:'🔗', title:'ABDM / ABHA', desc:'Live health records (with consent)' },
              { icon:'🔒', title:'DPDP Act 2023', desc:'Data never leaves Indian servers' },
              { icon:'📲', title:'WhatsApp-native', desc:'Coordinator & patient engagement' },
            ].map(f => (
              <div key={f.title} style={{ background:'#fff', border:'1px solid #E2E0D8', borderRadius:'9px', padding:'10px 12px', display:'flex', gap:'9px', alignItems:'flex-start' }}>
                <span style={{ fontSize:'18px', flexShrink:0 }}>{f.icon}</span>
                <div>
                  <div style={{ fontSize:'12px', fontWeight:600, color:'#1C1B18' }}>{f.title}</div>
                  <div style={{ fontSize:'11px', color:'#72706A', marginTop:'1px' }}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ background:'#fff', border:'1px solid #E2E0D8', borderRadius:'12px', padding:'28px 24px' }}>
            {sent ? (
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize:'40px', marginBottom:'12px' }}>📧</div>
                <h2 style={{ margin:'0 0 8px', fontSize:'18px', fontWeight:'500', color:'#1C1B18' }}>Check your email</h2>
                <p style={{ color:'#72706A', fontSize:'13px', lineHeight:'1.6', margin:'0 0 20px' }}>
                  We sent a sign-in link to <strong>{email}</strong>.<br/>
                  Click the link to sign in — no password needed.
                </p>
                <button onClick={() => setSent(false)} style={{ color:'#0F6E56', background:'none', border:'none', fontSize:'13px', cursor:'pointer', textDecoration:'underline' }}>
                  Use a different email
                </button>
              </div>
            ) : (
              <>
                <h2 style={{ margin:'0 0 20px', fontSize:'18px', fontWeight:'500', color:'#1C1B18' }}>Sign in</h2>

                {/* Google */}
                <button
                  onClick={handleGoogle}
                  disabled={loading}
                  style={{ width:'100%', padding:'11px 16px', background:'#fff', border:'1px solid #E2E0D8', borderRadius:'8px', display:'flex', alignItems:'center', justifyContent:'center', gap:'10px', fontSize:'14px', fontWeight:'500', color:'#1C1B18', cursor:'pointer', marginBottom:'16px', transition:'all .15s' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  Continue with Google
                </button>

                <div style={{ display:'flex', alignItems:'center', gap:'12px', margin:'0 0 16px' }}>
                  <div style={{ flex:1, height:'1px', background:'#E2E0D8' }}/>
                  <span style={{ fontSize:'12px', color:'#B4B2A9' }}>or</span>
                  <div style={{ flex:1, height:'1px', background:'#E2E0D8' }}/>
                </div>

                {/* Email */}
                <form onSubmit={handleEmail}>
                  <div style={{ marginBottom:'12px' }}>
                    <label style={{ display:'block', fontSize:'11px', fontWeight:'600', letterSpacing:'.05em', textTransform:'uppercase', color:'#72706A', marginBottom:'5px' }}>
                      Work email
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="you@hospital.com"
                      required
                      style={{ width:'100%', padding:'10px 12px', border:'1px solid #E2E0D8', borderRadius:'8px', fontSize:'14px', fontFamily:'sans-serif', outline:'none', boxSizing:'border-box' }}
                    />
                  </div>
                  {error && <p style={{ color:'#B53030', fontSize:'12px', margin:'0 0 10px' }}>{error}</p>}
                  <button
                    type="submit"
                    disabled={loading || !email}
                    style={{ width:'100%', padding:'11px', background:loading || !email ? '#B4B2A9' : '#0F6E56', color:'#fff', border:'none', borderRadius:'8px', fontSize:'14px', fontWeight:'500', cursor:loading || !email ? 'not-allowed' : 'pointer', fontFamily:'sans-serif', transition:'background .15s' }}
                  >
                    {loading ? 'Sending…' : 'Send sign-in link'}
                  </button>
                </form>
              </>
            )}
          </div>

          <p style={{ textAlign:'center', fontSize:'11px', color:'#B4B2A9', marginTop:'16px', lineHeight:'1.6' }}>
            Patient data is processed under India's DPDP Act 2023.<br/>
            De-identified. Never sold. Data residency in India.<br/>
            <span style={{ marginTop:'4px', display:'block' }}>
              For sponsors &amp; CROs: <a href="mailto:hello@trialmatch.in" style={{ color:'#0F6E56', textDecoration:'none' }}>hello@trialmatch.in</a>
            </span>
          </p>
        </div>
      </div>
    </>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions)
  if (session) return { redirect: { destination: '/dashboard', permanent: false } }
  return { props: {} }
}
