/**
 * components/SiteTwinNetworkPanel.tsx
 * India Site Twin Network — searchable, filterable directory of 500+ research sites.
 *
 * Coordinator: read-only, "My site" badge if their org is linked.
 * Sponsor: same view + "Engage site" button (via onEngage prop).
 */

import { useState, useEffect, useCallback } from 'react'

interface Props {
  brandColor: string
  onEngage?:  (site: any) => void   // provided for sponsor context; nil for coordinators
  userOrgId?: string                // to highlight "my site"
}

const SPECIALTIES = [
  'Oncology','Cardiology','Metabolic','Neurology','Respiratory',
  'Gastroenterology','Rheumatology','Infectious','Dermatology','Rare Disease',
]

const INDIA_STATES = [
  'Karnataka','Maharashtra','Tamil Nadu','Delhi','Telangana','West Bengal',
  'Gujarat','Rajasthan','Uttar Pradesh','Kerala','Andhra Pradesh','Punjab',
]

export default function SiteTwinNetworkPanel({ brandColor, onEngage, userOrgId }: Props) {
  const [sites,       setSites]       = useState<any[]>([])
  const [total,       setTotal]       = useState(0)
  const [loading,     setLoading]     = useState(true)
  const [page,        setPage]        = useState(1)
  const [totalPages,  setTotalPages]  = useState(1)
  const [search,      setSearch]      = useState('')
  const [city,        setCity]        = useState('')
  const [state,       setState]       = useState('')
  const [specialty,   setSpecialty]   = useState('')
  const [partnerOnly, setPartnerOnly] = useState(false)
  const [selectedSite,setSelectedSite]= useState<any>(null)
  const [siteDetail,  setSiteDetail]  = useState<any>(null)
  const [detailLoading,setDetailLoading] = useState(false)

  const loadSites = useCallback(async (p = 1) => {
    setLoading(true)
    const params = new URLSearchParams({
      page:     String(p),
      limit:    '24',
      ...(search      ? { search }                   : {}),
      ...(city        ? { city }                     : {}),
      ...(state       ? { state }                    : {}),
      ...(specialty   ? { specialty }                : {}),
      ...(partnerOnly ? { is_partner: 'true' }       : {}),
    })
    try {
      const r = await fetch(`/api/site-twins?${params}`)
      if (r.ok) {
        const d = await r.json()
        setSites(d.sites || [])
        setTotal(d.total || 0)
        setTotalPages(d.total_pages || 1)
        setPage(p)
      }
    } catch {}
    setLoading(false)
  }, [search, city, state, specialty, partnerOnly])

  useEffect(() => { loadSites(1) }, [loadSites])

  async function openSiteDetail(site: any) {
    setSelectedSite(site)
    setDetailLoading(true)
    try {
      const r = await fetch(`/api/site-twins?id=${site.id}`)
      if (r.ok) setSiteDetail(await r.json())
    } catch {}
    setDetailLoading(false)
  }

  function closeSiteDetail() {
    setSelectedSite(null)
    setSiteDetail(null)
  }

  const S = {
    card:     { background:'#fff', border:'1px solid #E2E0D8', borderRadius:'10px', padding:'16px 20px', marginBottom:'12px' } as any,
    siteCard: (mysite: boolean) => ({
      background:'#fff', border: mysite ? `1.5px solid ${brandColor}` : '1px solid #E2E0D8',
      borderRadius:'10px', padding:'14px 16px', cursor:'pointer', transition:'box-shadow .15s',
      position:'relative',
    }) as any,
    badge:    (bg='#E1F5EE', color='#0F6E56') => ({ background:bg, color, fontSize:'10px', fontWeight:600, padding:'2px 7px', borderRadius:'99px', letterSpacing:'.04em', textTransform:'uppercase' as any, display:'inline-block' }) as any,
    filter:   { padding:'7px 11px', border:'1px solid #E2E0D8', borderRadius:'7px', fontSize:'13px', fontFamily:'sans-serif', background:'#fff', color:'#1C1B18', outline:'none' } as any,
    btn:      (primary=false) => ({ padding:'7px 14px', background: primary ? brandColor : '#fff', color: primary ? '#fff' : '#1C1B18', border: primary ? 'none' : '1px solid #E2E0D8', borderRadius:'7px', fontSize:'12px', cursor:'pointer', fontFamily:'sans-serif', fontWeight:500 }) as any,
  }

  // Site detail drawer
  if (selectedSite) {
    const site = siteDetail?.site || selectedSite
    const pis  = siteDetail?.pi_contacts || []
    return (
      <div>
        <div style={{ display:'flex', alignItems:'center', gap:'12px', marginBottom:'20px' }}>
          <button style={S.btn()} onClick={closeSiteDetail}>← Back</button>
          <h2 style={{ margin:0, fontSize:'17px', fontWeight:500 }}>{site.institution_name}</h2>
          {site.is_partner && <span style={S.badge()}>Partner</span>}
          {site.is_verified && <span style={S.badge('#E6F1FB','#185FA5')}>Verified</span>}
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))', gap:'12px', marginBottom:'18px' }}>
          {[
            { label:'Location',       val: [site.city, site.state].filter(Boolean).join(', ') || 'India' },
            { label:'Active trials',  val: site.active_trials || 0 },
            { label:'PI count',       val: site.pi_count || 0 },
            { label:'Total patients', val: site.total_patients ? `${site.total_patients}` : 'Private' },
          ].map(s => (
            <div key={s.label} style={S.card}>
              <div style={{ fontSize:'11px', color:'#72706A', marginBottom:'4px', textTransform:'uppercase', letterSpacing:'.06em' }}>{s.label}</div>
              <div style={{ fontSize:'18px', fontWeight:500, color:'#1C1B18' }}>{s.val}</div>
            </div>
          ))}
        </div>

        {site.specialties?.length > 0 && (
          <div style={{ ...S.card, marginBottom:'14px' }}>
            <div style={{ fontSize:'12px', color:'#72706A', marginBottom:'8px', fontWeight:600 }}>Specialties</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'6px' }}>
              {site.specialties.map((sp: string) => (
                <span key={sp} style={S.badge('#F1EFE8','#5F5E5A')}>{sp}</span>
              ))}
            </div>
          </div>
        )}

        {/* PI contacts */}
        {pis.length > 0 && (
          <div style={{ ...S.card }}>
            <div style={{ fontSize:'14px', fontWeight:500, marginBottom:'12px' }}>Principal investigators at this site</div>
            {pis.map((pi: any, i: number) => (
              <div key={i} style={{ padding:'10px 0', borderBottom: i < pis.length-1 ? '1px solid #E2E0D8' : 'none' }}>
                <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'4px' }}>
                  <span style={{ fontWeight:500, fontSize:'13px' }}>{pi.pi_name}</span>
                  {pi.verified && <span style={S.badge()}>Verified</span>}
                  {pi.response_rate > 0.7 && <span style={S.badge('#EAF3DE','#27500A')}>Responds quickly</span>}
                </div>
                <div style={{ fontSize:'12px', color:'#72706A', display:'flex', gap:'14px', flexWrap:'wrap' }}>
                  {pi.specialty && <span>📋 {pi.specialty}</span>}
                  {pi.pi_email  && <a href={`mailto:${pi.pi_email}`} style={{ color: brandColor }}>✉ {pi.pi_email}</a>}
                  {pi.pi_phone  && <a href={`tel:${pi.pi_phone}`}   style={{ color: brandColor }}>📞 {pi.pi_phone}</a>}
                  {pi.avg_response_hours > 0 && <span>⏱ avg {pi.avg_response_hours}h response</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Engage button for sponsors */}
        {onEngage && (
          <div style={{ marginTop:'16px' }}>
            {site.is_partner ? (
              <button style={{ ...S.btn(true), padding:'11px 22px' }} onClick={() => onEngage(site)}>
                📩 Engage this site
              </button>
            ) : (
              <div style={{ background:'#FEF9F0', border:'1px solid #FAC775', borderRadius:'9px', padding:'14px 16px' }}>
                <div style={{ fontWeight:500, fontSize:'13px', marginBottom:'4px' }}>This site is not yet a TrialMatch partner</div>
                <div style={{ fontSize:'12px', color:'#72706A', marginBottom:'10px', lineHeight:1.6 }}>
                  Invite their research coordinator to join TrialMatch to enable direct engagement.
                </div>
                <button style={S.btn(true)} onClick={() => onEngage(site)}>
                  📨 Get invite link
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'16px', flexWrap:'wrap', gap:'10px' }}>
        <div>
          <h2 style={{ margin:0, fontSize:'17px', fontWeight:500 }}>India Site Twin Network</h2>
          <div style={{ fontSize:'12px', color:'#72706A', marginTop:'2px' }}>
            {loading ? 'Loading…' : `${total.toLocaleString('en-IN')} research sites across India`}
          </div>
        </div>
        <label style={{ display:'flex', alignItems:'center', gap:'7px', fontSize:'12px', color:'#72706A', cursor:'pointer' }}>
          <input type="checkbox" checked={partnerOnly} onChange={e => setPartnerOnly(e.target.checked)} style={{ accentColor: brandColor }}/>
          TrialMatch partners only
        </label>
      </div>

      {/* Search + filters */}
      <div style={{ display:'flex', gap:'8px', marginBottom:'16px', flexWrap:'wrap' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search sites…"
          style={{ ...S.filter, flex:1, minWidth:'180px' }}
        />
        <input
          value={city}
          onChange={e => setCity(e.target.value)}
          placeholder="City"
          style={{ ...S.filter, width:'130px' }}
        />
        <select value={state} onChange={e => setState(e.target.value)} style={S.filter}>
          <option value="">All states</option>
          {INDIA_STATES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={specialty} onChange={e => setSpecialty(e.target.value)} style={S.filter}>
          <option value="">All specialties</option>
          {SPECIALTIES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ padding:'48px', textAlign:'center', color:'#72706A' }}>Loading sites…</div>
      ) : sites.length === 0 ? (
        <div style={{ ...S.card, padding:'48px', textAlign:'center', color:'#72706A' }}>
          No sites match your filters. Try broadening your search.
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))', gap:'12px', marginBottom:'20px' }}>
          {sites.map(site => {
            const isMySite = site.org_id === userOrgId
            return (
              <div key={site.id} style={S.siteCard(isMySite)} onClick={() => openSiteDetail(site)}>
                {isMySite && (
                  <div style={{ position:'absolute', top:'10px', right:'10px' }}>
                    <span style={S.badge()}>My site</span>
                  </div>
                )}
                <div style={{ fontWeight:500, fontSize:'13px', color:'#1C1B18', marginBottom:'4px', paddingRight: isMySite ? '64px' : 0 }}>
                  {site.institution_name}
                </div>
                <div style={{ fontSize:'12px', color:'#72706A', marginBottom:'10px' }}>
                  {[site.city, site.state].filter(Boolean).join(', ') || 'India'}
                </div>

                <div style={{ display:'flex', gap:'6px', flexWrap:'wrap', marginBottom:'10px' }}>
                  {site.is_partner && <span style={S.badge()}>Partner</span>}
                  {site.is_verified && <span style={S.badge('#E6F1FB','#185FA5')}>Verified</span>}
                  {(site.specialties || []).slice(0,2).map((sp: string) => (
                    <span key={sp} style={S.badge('#F1EFE8','#5F5E5A')}>{sp}</span>
                  ))}
                </div>

                <div style={{ display:'flex', gap:'16px', fontSize:'12px', color:'#72706A' }}>
                  <span>🔬 {site.active_trials || 0} trials</span>
                  <span>👤 {site.pi_count || 0} PIs</span>
                  {site.total_patients > 0 && <span>🏥 {site.total_patients} patients</span>}
                </div>

                {onEngage && (
                  <div style={{ marginTop:'10px', paddingTop:'10px', borderTop:'1px solid #F1EFE8' }}>
                    <button
                      style={{ ...S.btn(site.is_partner), fontSize:'11px', padding:'5px 10px', width:'100%', justifyContent:'center' }}
                      onClick={e => { e.stopPropagation(); onEngage(site) }}
                    >
                      {site.is_partner ? '📩 Engage' : '📨 Invite to TrialMatch'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display:'flex', justifyContent:'center', gap:'8px', marginTop:'8px' }}>
          <button style={S.btn()} onClick={() => loadSites(page-1)} disabled={page<=1}>← Prev</button>
          <span style={{ fontSize:'13px', color:'#72706A', display:'flex', alignItems:'center', padding:'0 10px' }}>
            Page {page} of {totalPages}
          </span>
          <button style={S.btn()} onClick={() => loadSites(page+1)} disabled={page>=totalPages}>Next →</button>
        </div>
      )}
    </div>
  )
}
