/**
 * components/PIDirectoryPanel.tsx
 * Standalone searchable PI directory — search by city, specialty, institution.
 * Coordinators use this to find contacts independent of a specific match.
 */

import { useState, useEffect, useCallback } from 'react'

interface Props { brandColor: string }

const SPECIALTIES = [
  'oncology', 'endocrinology', 'cardiology', 'neurology', 'nephrology',
  'pulmonology', 'rheumatology', 'gastroenterology', 'infectious_disease',
  'psychiatry', 'dermatology', 'ophthalmology', 'orthopaedics',
  'paediatrics', 'obstetrics', 'urology', 'general',
]

export default function PIDirectoryPanel({ brandColor }: Props) {
  const [contacts,  setContacts]  = useState<any[]>([])
  const [total,     setTotal]     = useState(0)
  const [loading,   setLoading]   = useState(true)
  const [search,    setSearch]    = useState('')
  const [city,      setCity]      = useState('')
  const [specialty, setSpecialty] = useState('')
  const [page,      setPage]      = useState(1)

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (search)    params.set('search', search)
    if (city)      params.set('city', city)
    if (specialty) params.set('specialty', specialty)
    params.set('page', String(page))

    try {
      const r = await fetch(`/api/pi-contacts?${params}`)
      const d = await r.json()
      setContacts(d.contacts || [])
      setTotal(d.total || 0)
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [search, city, specialty, page])

  useEffect(() => { load() }, [load])

  const S = {
    card:  { background:'#fff', border:'1px solid #E2E0D8', borderRadius:'10px', padding:'16px 20px', marginBottom:'14px' } as any,
    input: { padding:'9px 12px', border:'1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', fontFamily:'sans-serif', outline:'none' } as any,
    btn:   (p=false) => ({ padding:'8px 14px', background:p?brandColor:'#fff', color:p?'#fff':'#1C1B18', border:p?'none':'1px solid #E2E0D8', borderRadius:'7px', fontSize:'12px', fontWeight:'500', cursor:'pointer', fontFamily:'sans-serif' }) as any,
  }

  function responseBadge(rate: number | null, contacted: number) {
    if (!contacted || rate === null) return { label:'No data yet', bg:'#F7F6F2', color:'#72706A' }
    if (rate >= 0.7) return { label:`${Math.round(rate*100)}% responds`, bg:'#EAF3DE', color:'#27500A' }
    if (rate >= 0.4) return { label:`${Math.round(rate*100)}% responds`, bg:'#FAEEDA', color:'#633806' }
    return { label:`${Math.round(rate*100)}% responds`, bg:'#FCEBEB', color:'#791F1F' }
  }

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'18px', flexWrap:'wrap', gap:'10px' }}>
        <div>
          <h2 style={{ margin:'0 0 3px', fontSize:'17px', fontWeight:'500' }}>PI Directory</h2>
          <p style={{ margin:0, fontSize:'13px', color:'#72706A' }}>
            {total > 0 ? `${total.toLocaleString('en-IN')} verified contacts across India` : 'Search principal investigators by city, specialty, or institution'}
          </p>
        </div>
      </div>

      {/* Search filters */}
      <div style={{ ...S.card, display:'flex', gap:'10px', flexWrap:'wrap', alignItems:'center' }}>
        <input
          style={{ ...S.input, flex:1, minWidth:'200px' }}
          placeholder="Search by name, institution, or trial..."
          value={search}
          onChange={e => { setPage(1); setSearch(e.target.value) }}
        />
        <input
          style={{ ...S.input, width:'160px' }}
          placeholder="City (e.g. Bengaluru)"
          value={city}
          onChange={e => { setPage(1); setCity(e.target.value) }}
        />
        <select
          style={{ ...S.input, width:'180px' }}
          value={specialty}
          onChange={e => { setPage(1); setSpecialty(e.target.value) }}
        >
          <option value="">All specialties</option>
          {SPECIALTIES.map(s => <option key={s} value={s}>{s.replace('_',' ').replace(/\b\w/g, c => c.toUpperCase())}</option>)}
        </select>
        {(search || city || specialty) && (
          <button style={S.btn(false)} onClick={() => { setSearch(''); setCity(''); setSpecialty(''); setPage(1) }}>
            Clear filters
          </button>
        )}
      </div>

      {/* Results */}
      {loading ? (
        <div style={{ padding:'48px', textAlign:'center', color:'#72706A' }}>Searching…</div>
      ) : contacts.length === 0 ? (
        <div style={{ ...S.card, padding:'48px', textAlign:'center', color:'#72706A' }}>
          No PI contacts found. Try a different city or specialty, or run the seeding script if the directory is empty.
        </div>
      ) : (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(320px, 1fr))', gap:'12px' }}>
            {contacts.map((c: any) => {
              const badge = responseBadge(c.response_rate, c.times_contacted)
              const subject = encodeURIComponent(`Clinical trial inquiry — ${(c.trial_title || '').slice(0, 50)}`)
              return (
                <div key={c.id} style={{ background:'#fff', border:'1px solid #E2E0D8', borderLeft:`3px solid ${brandColor}`, borderRadius:'10px', padding:'14px 16px' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'8px', gap:'8px' }}>
                    <div>
                      <div style={{ fontSize:'13.5px', fontWeight:'500', color:'#1C1B18' }}>
                        {c.pi_name || 'Contact name not listed'}
                        {c.verified && <span style={{ marginLeft:'7px', fontSize:'10px', background:'#EAF3DE', color:'#27500A', padding:'1px 6px', borderRadius:'99px', fontWeight:'600' }}>✓</span>}
                      </div>
                      <div style={{ fontSize:'12px', color:'#72706A', marginTop:'2px' }}>
                        {[c.pi_institution, c.pi_city].filter(Boolean).join(', ') || 'Location not specified'}
                      </div>
                    </div>
                    <span style={{ fontSize:'10px', fontWeight:'600', padding:'2px 8px', borderRadius:'99px', background:badge.bg, color:badge.color, flexShrink:0, whiteSpace:'nowrap' }}>
                      {badge.label}
                    </span>
                  </div>

                  <div style={{ fontSize:'11.5px', color:'#72706A', marginBottom:'10px', lineHeight:'1.4', maxHeight:'32px', overflow:'hidden' }}>
                    {c.trial_title}
                  </div>

                  {c.specialty && (
                    <span style={{ display:'inline-block', fontSize:'10px', fontWeight:'500', padding:'2px 8px', borderRadius:'6px', background:'#F7F6F2', color:'#72706A', marginBottom:'10px', textTransform:'capitalize' }}>
                      {c.specialty.replace('_',' ')}
                    </span>
                  )}

                  <div style={{ display:'flex', gap:'8px', flexWrap:'wrap' }}>
                    {c.pi_email && !c.email_bounced && (
                      <a href={`mailto:${c.pi_email}?subject=${subject}`} style={{ fontSize:'11.5px', color:brandColor, textDecoration:'none', padding:'4px 9px', background:'#E1F5EE', borderRadius:'6px', border:'1px solid rgba(15,110,86,.2)' }}>
                        ✉ Email
                      </a>
                    )}
                    {c.pi_phone && (
                      <a href={`tel:${c.pi_phone}`} style={{ fontSize:'11.5px', color:'#1C1B18', textDecoration:'none', padding:'4px 9px', background:'#fff', borderRadius:'6px', border:'1px solid #E2E0D8' }}>
                        📞 Call
                      </a>
                    )}
                    {c.nct_id && c.nct_id.startsWith('NCT') && (
                      <a href={`https://clinicaltrials.gov/study/${c.nct_id}`} target="_blank" rel="noreferrer" style={{ fontSize:'11.5px', color:'#72706A', textDecoration:'none', padding:'4px 9px', background:'#fff', borderRadius:'6px', border:'1px solid #E2E0D8' }}>
                        ↗ Trial
                      </a>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Pagination */}
          {total > 20 && (
            <div style={{ display:'flex', justifyContent:'center', gap:'10px', marginTop:'18px' }}>
              <button style={S.btn(false)} disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Previous</button>
              <span style={{ fontSize:'12px', color:'#72706A', padding:'8px 0' }}>Page {page} of {Math.ceil(total / 20)}</span>
              <button style={S.btn(false)} disabled={page >= Math.ceil(total / 20)} onClick={() => setPage(p => p + 1)}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
