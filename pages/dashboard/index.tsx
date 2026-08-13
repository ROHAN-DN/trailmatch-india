import { useState, useEffect, useCallback } from 'react'
import { useSession, signOut } from 'next-auth/react'
import { GetServerSideProps } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../api/auth/[...nextauth]'
import Head from 'next/head'
import PatientModal from '../../components/PatientModal'
import BatchPanel  from '../../components/BatchPanel'
import TeamPanel   from '../../components/TeamPanel'
import SettingsPanel from '../../components/SettingsPanel'
import NotificationsPanel from '../../components/NotificationsPanel'
import BillingPanel from '../../components/BillingPanel'
import BillingAnalyticsPanel from '../../components/BillingAnalyticsPanel'
import AnalyticsPanel from '../../components/AnalyticsPanel'
import FHIRImportPanel from '../../components/FHIRImportPanel'
import ABDMConnector  from '../../components/ABDMConnector'
import PIDirectoryPanel from '../../components/PIDirectoryPanel'
import FeasibilityPanel from '../../components/FeasibilityPanel'
import SiteTwinNetworkPanel from '../../components/SiteTwinNetworkPanel'
import EngagementsPanel from '../../components/EngagementsPanel'
import SponsorPortal from '../../components/SponsorPortal'
import HMSImportModal from '../../components/HMSImportModal'
import SponsorOnboarding from '../../components/SponsorOnboarding'

// All coordinator tabs
type CoordinatorTab =
  | 'patients' | 'jobs' | 'analytics' | 'billing-analytics'
  | 'pi-directory' | 'site-network' | 'feasibility'
  | 'engagements' | 'team' | 'notifications' | 'billing' | 'settings'

// Sponsor-only tabs (replaces coordinator tabs entirely)
type SponsorTab = 'sponsor-portal' | 'site-network' | 'team' | 'billing' | 'settings'

type Tab = CoordinatorTab | SponsorTab

const SPONSOR_ORG_TYPES = ['pharma', 'biotech']

export default function Dashboard() {
  const { data: session } = useSession()
  const user = session?.user as any

  const [tab,        setTab]        = useState<Tab>('patients')
  const [patients,   setPatients]   = useState<any[]>([])
  const [org,        setOrg]        = useState<any>(null)
  const [usage,      setUsage]      = useState<any>(null)
  const [search,     setSearch]     = useState('')
  const [loading,    setLoading]    = useState(true)
  const [showAdd,    setShowAdd]    = useState(false)
  const [showBatch,  setShowBatch]  = useState(false)
  const [showFHIR,   setShowFHIR]   = useState(false)
  const [showABDM,   setShowABDM]   = useState(false)
  const [showHMS,    setShowHMS]    = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [selected,   setSelected]   = useState<Set<string>>(new Set())
  const [editPatient,setEditPatient]= useState<any>(null)

  const isSponsor = SPONSOR_ORG_TYPES.includes(org?.org_type || '')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [pRes, oRes] = await Promise.all([
        fetch(`/api/patients?search=${search}&limit=50`),
        fetch('/api/org'),
      ])
      const pData = await pRes.json()
      const oData = await oRes.json()
      setPatients(pData.patients || [])
      setOrg(oData.org)
      setUsage(oData.usage)
    } catch(e) { console.error(e) }
    setLoading(false)
  }, [search])

  useEffect(() => { load() }, [load])

  // Listen for internal tab navigation events (e.g. from BatchPanel "View site network" link)
  useEffect(() => {
    const handler = (e: any) => { if (e.detail) setTab(e.detail as Tab) }
    window.addEventListener('navigate-tab', handler)
    return () => window.removeEventListener('navigate-tab', handler)
  }, [])

  // Auto-redirect sponsors to their portal on first load
  useEffect(() => {
    if (isSponsor && tab === 'patients') setTab('sponsor-portal')
  }, [isSponsor])

  // Show sponsor onboarding once per browser session for new sponsors
  useEffect(() => {
    if (!isSponsor || !org?.id) return
    const key = `onboarding_seen_${org.id}`
    if (typeof window !== 'undefined' && !sessionStorage.getItem(key)) {
      setShowOnboarding(true)
    }
  }, [isSponsor, org?.id])

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected(prev => prev.size === patients.length ? new Set() : new Set(patients.map(p => p.id)))
  }

  const brandColor = org?.brand_color || '#0F6E56'
  const appName    = org?.name || 'TrialMatch India'

  const S = {
    page:    { minHeight:'100vh', background:'#F7F6F2', fontFamily:'sans-serif' } as any,
    nav:     { background:brandColor, padding:'0 24px', display:'flex', alignItems:'center', gap:'0', borderBottom:'1px solid rgba(255,255,255,.1)', overflowX:'auto' as any } as any,
    logo:    { color:'#fff', fontSize:'17px', fontWeight:'500', padding:'14px 0', marginRight:'28px', whiteSpace:'nowrap' as any } as any,
    navLink: (active: boolean) => ({ padding:'14px 12px', fontSize:'13px', fontWeight:'500', color: active ? '#fff' : 'rgba(255,255,255,.6)', cursor:'pointer', background:'none', border:'none', borderBottom: active ? '2px solid #fff' : '2px solid transparent', fontFamily:'sans-serif', whiteSpace:'nowrap' as any }) as any,
    main:    { maxWidth:'1100px', margin:'0 auto', padding:'24px 20px' } as any,
    card:    { background:'#fff', border:'1px solid #E2E0D8', borderRadius:'10px', padding:'16px 20px', marginBottom:'16px' } as any,
    btn:     (primary=true) => ({ padding:'9px 18px', background: primary ? brandColor : '#fff', color: primary ? '#fff' : '#1C1B18', border: primary ? 'none' : '1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', fontWeight:'500', cursor:'pointer', display:'inline-flex', alignItems:'center', gap:'7px', fontFamily:'sans-serif', transition:'all .15s' }) as any,
    tag:     (color='#E1F5EE', text='#0F6E56') => ({ background:color, color:text, fontSize:'10px', fontWeight:'600', padding:'2px 8px', borderRadius:'99px', letterSpacing:'.04em', textTransform:'uppercase' as any }) as any,
  }

  // ── Tab definitions by org type ───────────────────────────────────────────
  const coordinatorTabs: { id: CoordinatorTab; label: string }[] = [
    { id: 'patients',          label: 'Patients' },
    { id: 'jobs',              label: 'Jobs' },
    { id: 'analytics',         label: 'Analytics' },
    { id: 'billing-analytics', label: 'Revenue' },
    { id: 'pi-directory',      label: 'PI Directory' },
    { id: 'site-network',      label: 'Site Network' },
    { id: 'feasibility',       label: 'Feasibility' },
    { id: 'engagements',       label: 'Engagements' },
    { id: 'team',              label: 'Team' },
    { id: 'notifications',     label: 'Notifications' },
    { id: 'billing',           label: 'Billing' },
    { id: 'settings',          label: 'Settings' },
  ]

  const sponsorTabs: { id: SponsorTab; label: string }[] = [
    { id: 'sponsor-portal', label: '🔬 Sponsor Portal' },
    { id: 'site-network',   label: 'Site Network' },
    { id: 'team',           label: 'Team' },
    { id: 'billing',        label: 'Billing' },
    { id: 'settings',       label: 'Settings' },
  ]

  const navTabs = isSponsor ? sponsorTabs : coordinatorTabs

  return (
    <>
      <Head><title>{appName}</title></Head>
      <div style={S.page}>

        {/* Navbar */}
        <nav style={S.nav}>
          <span style={S.logo}>{appName}</span>
          {navTabs.map(t => (
            <button key={t.id} style={S.navLink(tab === t.id)} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
          <div style={{ flex:1, minWidth:'12px' }}/>
          <div style={{ display:'flex', alignItems:'center', gap:'10px', flexShrink:0 }}>
            {isSponsor && (
              <span style={{ ...S.tag('#FAC77533','#9C6A00'), marginRight:'4px' }}>Sponsor</span>
            )}
            <span style={{ color:'rgba(255,255,255,.7)', fontSize:'13px', whiteSpace:'nowrap' as any }}>
              {user?.email}
            </span>
            <button onClick={() => signOut({ callbackUrl:'/auth/signin' })} style={{ ...S.btn(false), fontSize:'12px', padding:'6px 12px', color:'rgba(255,255,255,.7)', background:'rgba(255,255,255,.1)', border:'1px solid rgba(255,255,255,.2)' }}>
              Sign out
            </button>
          </div>
        </nav>

        <div style={{ background:'#F7F6F2', borderBottom:'1px solid #E2E0D8', padding:'5px 24px', textAlign:'center' }}>
          <span style={{ fontSize:'11px', color:'#72706A' }}>
            ⚕️ <strong style={{ color:'#1C1B18', fontWeight:'500' }}>Decision support only</strong> — all matches must be independently verified by the Principal Investigator at each trial site before patient screening begins · Not medical advice · <span style={{ color:'#B4B2A9' }}>TrialMatch India Pvt Ltd</span>
          </span>
        </div>

        <div style={S.main}>

          {/* ── SPONSOR PORTAL TAB ──────────────────────────────── */}
          {tab === 'sponsor-portal' && (
            <SponsorPortal
              brandColor={brandColor}
              orgId={org?.id || ''}
              orgName={org?.name}
            />
          )}

          {/* ── PATIENTS TAB (coordinator only) ─────────────────── */}
          {tab === 'patients' && !isSponsor && (
            <>
              {usage && (
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))', gap:'12px', marginBottom:'20px' }}>
                  {[
                    { label:'Patients',       val: usage.patients, color: brandColor },
                    { label:'Match jobs run', val: usage.jobs,     color:'#1C1B18' },
                    { label:'Team members',   val: usage.users,    color:'#1C1B18' },
                    { label:'Plan',           val: org?.plan?.toUpperCase() || 'TRIAL', color:'#BA7517' },
                  ].map(s => (
                    <div key={s.label} style={S.card}>
                      <div style={{ fontSize:'11px', color:'#72706A', marginBottom:'4px', textTransform:'uppercase', letterSpacing:'.06em' }}>{s.label}</div>
                      <div style={{ fontSize:'22px', fontWeight:'500', color: s.color }}>{s.val}</div>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display:'flex', gap:'10px', marginBottom:'14px', flexWrap:'wrap', alignItems:'center' }}>
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search patients or diagnosis…"
                  style={{ flex:1, minWidth:'200px', padding:'9px 12px', border:'1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', fontFamily:'sans-serif', outline:'none', background:'#fff' }}
                />
                <button style={S.btn(false)} onClick={() => setShowAdd(true)}>+ Add patient</button>
                <button style={S.btn()} onClick={() => setShowBatch(true)}>⬆ Import CSV</button>
                <button style={{ ...S.btn(false) }} onClick={() => setShowFHIR(true)}>🏥 Import FHIR</button>
                <button style={{ ...S.btn(false) }} onClick={() => setShowABDM(true)}>🇮🇳 Fetch ABDM</button>
                <button style={{ ...S.btn(false) }} onClick={() => setShowHMS(true)}>📋 Import HMS</button>
                {selected.size > 0 && (
                  <button style={{ ...S.btn(), background:'#1D9E75' }} onClick={() => setShowBatch(true)}>
                    🔬 Match {selected.size} selected
                  </button>
                )}
              </div>

              <div style={{ background:'#fff', border:'1px solid #E2E0D8', borderRadius:'10px', overflow:'hidden' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'13px' }}>
                  <thead>
                    <tr style={{ background:'#F7F6F2' }}>
                      <th style={{ padding:'10px 14px', textAlign:'left', width:'32px' }}>
                        <input type="checkbox" checked={selected.size===patients.length && patients.length>0} onChange={toggleAll}/>
                      </th>
                      {['Code','Diagnosis','Age / Sex','Location','Added','Actions'].map(h => (
                        <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontSize:'10px', fontWeight:'600', letterSpacing:'.06em', textTransform:'uppercase', color:'#72706A', whiteSpace:'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={7} style={{ padding:'40px', textAlign:'center', color:'#72706A' }}>Loading…</td></tr>
                    ) : patients.length === 0 ? (
                      <tr><td colSpan={7} style={{ padding:'48px', textAlign:'center', color:'#72706A' }}>
                        No patients yet. Add a patient or import a CSV to get started.
                      </td></tr>
                    ) : patients.map(p => (
                      <tr key={p.id} style={{ borderTop:'1px solid #E2E0D8' }}>
                        <td style={{ padding:'10px 14px' }}>
                          <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)}/>
                        </td>
                        <td style={{ padding:'10px 14px', fontWeight:'500', color:'#1C1B18', fontFamily:'monospace', fontSize:'12px' }}>{p.patient_code}</td>
                        <td style={{ padding:'10px 14px', color:'#1C1B18' }}>{p.diagnosis}</td>
                        <td style={{ padding:'10px 14px', color:'#72706A' }}>{p.age}y · {p.sex}</td>
                        <td style={{ padding:'10px 14px', color:'#72706A' }}>{p.location}</td>
                        <td style={{ padding:'10px 14px', color:'#B4B2A9', fontSize:'12px' }}>
                          {new Date(p.created_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}
                        </td>
                        <td style={{ padding:'10px 14px' }}>
                          <div style={{ display:'flex', gap:'6px' }}>
                            <button style={{ ...S.btn(false), padding:'5px 10px', fontSize:'12px' }} onClick={() => setEditPatient(p)}>Edit</button>
                            <button
                              style={{ ...S.btn(), padding:'5px 10px', fontSize:'12px', background: brandColor }}
                              onClick={async () => {
                                const r = await fetch('/api/match', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ patient_ids:[p.id] }) })
                                const d = await r.json()
                                if (d.job_id) { setTab('jobs'); load() }
                              }}
                            >Match</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* ── JOBS TAB ────────────────────────────────────────── */}
          {tab === 'jobs' && !isSponsor && <BatchPanel brandColor={brandColor}/>}

          {/* ── NOTIFICATIONS TAB ───────────────────────────────── */}
          {tab === 'notifications' && !isSponsor && <NotificationsPanel brandColor={brandColor}/>}

          {/* ── ANALYTICS TAB ───────────────────────────────────── */}
          {tab === 'analytics' && !isSponsor && <AnalyticsPanel brandColor={brandColor}/>}

          {/* ── BILLING ANALYTICS TAB ───────────────────────────── */}
          {tab === 'billing-analytics' && !isSponsor && <BillingAnalyticsPanel brandColor={brandColor} userRole={user?.role || 'member'}/>}

          {/* ── PI DIRECTORY TAB ────────────────────────────────── */}
          {tab === 'pi-directory' && !isSponsor && <PIDirectoryPanel brandColor={brandColor}/>}

          {/* ── SITE NETWORK TAB (all org types) ────────────────── */}
          {tab === 'site-network' && (
            <SiteTwinNetworkPanel
              brandColor={brandColor}
              userOrgId={org?.id}
              onEngage={isSponsor ? (site) => {
                // Sponsors navigate to SponsorPortal Sites tab to engage
                setTab('sponsor-portal')
                // Small timeout to let portal render, then dispatch to Sites sub-tab
                setTimeout(() => window.dispatchEvent(new CustomEvent('sponsor-subtab', { detail: 'sites' })), 100)
              } : undefined}
            />
          )}

          {/* ── FEASIBILITY TAB ─────────────────────────────────── */}
          {tab === 'feasibility' && !isSponsor && (
            <FeasibilityPanel brandColor={brandColor} userPlan={org?.plan || 'trial'}/>
          )}

          {/* ── ENGAGEMENTS TAB (coordinators — incoming requests) ─ */}
          {tab === 'engagements' && !isSponsor && (
            <EngagementsPanel brandColor={brandColor} orgId={org?.id || ''}/>
          )}

          {/* ── BILLING TAB ─────────────────────────────────────── */}
          {tab === 'billing' && <BillingPanel brandColor={brandColor} userRole={user?.role || 'member'}/>}

          {/* ── TEAM TAB ────────────────────────────────────────── */}
          {tab === 'team' && <TeamPanel brandColor={brandColor} userRole={user?.role}/>}

          {/* ── SETTINGS TAB ────────────────────────────────────── */}
          {tab === 'settings' && <SettingsPanel org={org} usage={usage} onSave={load} brandColor={brandColor}/>}

        </div>
      </div>

      {/* ── Modals ────────────────────────────────────────────── */}
      {(showAdd || editPatient) && (
        <PatientModal
          patient={editPatient}
          onClose={() => { setShowAdd(false); setEditPatient(null) }}
          onSave={() => { setShowAdd(false); setEditPatient(null); load() }}
        />
      )}

      {showABDM && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
          <div style={{ background:'#fff', borderRadius:'12px', padding:'28px 24px', maxWidth:'520px', width:'100%', maxHeight:'90vh', overflowY:'auto' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'18px' }}>
              <div>
                <div style={{ fontSize:'17px', fontWeight:'500', color:'#1C1B18' }}>Fetch from ABDM</div>
                <div style={{ fontSize:'12px', color:'#72706A', marginTop:'2px' }}>Ayushman Bharat Digital Mission — live health records</div>
              </div>
              <button onClick={() => setShowABDM(false)} style={{ background:'none', border:'none', fontSize:'22px', cursor:'pointer', color:'#72706A', lineHeight:1 }}>×</button>
            </div>
            <ABDMConnector brandColor={brandColor} onImported={() => { setShowABDM(false); load() }}/>
          </div>
        </div>
      )}

      {showFHIR && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
          <div style={{ background:'#fff', borderRadius:'12px', padding:'28px 24px', maxWidth:'640px', width:'100%', maxHeight:'90vh', overflowY:'auto' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'18px' }}>
              <span/>
              <button onClick={() => setShowFHIR(false)} style={{ background:'none', border:'none', fontSize:'22px', cursor:'pointer', color:'#72706A', lineHeight:1 }}>×</button>
            </div>
            <FHIRImportPanel brandColor={brandColor} onImported={() => { setShowFHIR(false); load() }}/>
          </div>
        </div>
      )}

      {showBatch && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
          <div style={{ background:'#fff', borderRadius:'12px', padding:'28px 24px', maxWidth:'560px', width:'100%', maxHeight:'80vh', overflowY:'auto' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'18px' }}>
              <h2 style={{ margin:0, fontSize:'17px', fontWeight:'500' }}>Batch match patients</h2>
              <button onClick={() => setShowBatch(false)} style={{ background:'none', border:'none', fontSize:'22px', cursor:'pointer', color:'#72706A', lineHeight:1 }}>×</button>
            </div>
            <p style={{ fontSize:'13px', color:'#72706A', margin:'0 0 16px', lineHeight:1.6 }}>
              {selected.size > 0
                ? `Ready to match ${selected.size} selected patient(s).`
                : 'Select patients from the list to batch match, or import a CSV below.'}
            </p>
            {selected.size > 0 && (
              <div style={{ marginBottom:'14px' }}>
                <label style={{ display:'flex', alignItems:'center', gap:'8px', fontSize:'13px', color:'#1C1B18', marginBottom:'10px', cursor:'pointer' }}>
                  <input type="checkbox" id="sendEmail"/> Send PDF report by email
                </label>
                <input id="emailTo" type="email" placeholder="coordinator@hospital.com" style={{ width:'100%', padding:'9px 12px', border:'1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', fontFamily:'sans-serif', outline:'none', boxSizing:'border-box' as any }}/>
              </div>
            )}
            <button
              style={{ ...S.btn(), width:'100%', justifyContent:'center', padding:'12px' }}
              disabled={selected.size === 0}
              onClick={async () => {
                const sendEmail = (document.getElementById('sendEmail') as HTMLInputElement)?.checked
                const emailTo   = (document.getElementById('emailTo') as HTMLInputElement)?.value
                const r = await fetch('/api/match', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ patient_ids: [...selected], send_email: sendEmail, email_to: emailTo })
                })
                const d = await r.json()
                if (d.job_id) { setShowBatch(false); setTab('jobs'); setSelected(new Set()); load() }
              }}
            >
              🔬 Run batch match ({selected.size} patients)
            </button>
          </div>
        </div>
      )}

      {/* HMS Import Modal */}
      {showHMS && (
        <HMSImportModal
          brandColor={brandColor}
          onClose={() => setShowHMS(false)}
          onImported={(count) => { setShowHMS(false); load() }}
        />
      )}

      {/* Sponsor onboarding — shown once per browser session for new sponsor orgs */}
      {showOnboarding && isSponsor && org && (
        <SponsorOnboarding
          orgName={org.name || 'your organisation'}
          brandColor={brandColor}
          onComplete={() => {
            if (typeof window !== 'undefined') sessionStorage.setItem(`onboarding_seen_${org.id}`, '1')
            setShowOnboarding(false)
            setTab('sponsor-portal')
            window.dispatchEvent(new CustomEvent('sponsor-subtab', { detail: 'feasibility' }))
          }}
          onDismiss={() => {
            if (typeof window !== 'undefined') sessionStorage.setItem(`onboarding_seen_${org.id}`, '1')
            setShowOnboarding(false)
          }}
        />
      )}
    </>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions)
  if (!session) return { redirect: { destination: '/auth/signin', permanent: false } }
  return { props: {} }
}
