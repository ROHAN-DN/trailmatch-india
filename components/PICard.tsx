/**
 * components/PICard.tsx
 * Shown below each match result with a recognised NCT ID.
 * Displays PI contact + lets coordinator log outreach attempts.
 */

import { useState, useEffect } from 'react'

interface PIContact {
  id: string; pi_name: string | null; pi_email: string | null; pi_phone: string | null
  pi_institution: string | null; pi_city: string | null; pi_state: string | null
  response_rate: number | null; times_contacted: number; verified: boolean; email_bounced: boolean
}

interface Props {
  nctId: string; trialTitle: string; patientId?: string; matchResultId?: string; brandColor?: string
}

export default function PICard({ nctId, trialTitle, patientId, matchResultId, brandColor = '#0F6E56' }: Props) {
  const [contacts, setContacts] = useState<PIContact[]>([])
  const [loading,  setLoading]  = useState(true)
  const [logging,  setLogging]  = useState<string | null>(null)
  const [logDone,  setLogDone]  = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!nctId || !nctId.startsWith('NCT')) { setLoading(false); return }
    fetch(`/api/pi-contacts?nct_id=${encodeURIComponent(nctId)}`)
      .then(r => r.json()).then(d => setContacts(d.contacts || [])).catch(() => {}).finally(() => setLoading(false))
  }, [nctId])

  async function logOutreach(piId: string, action: string) {
    setLogging(action + piId)
    try {
      await fetch('/api/pi-contacts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pi_contact_id: piId, patient_id: patientId || null, match_result_id: matchResultId || null, action }),
      })
      setLogDone(prev => ({ ...prev, [action + piId]: true }))
    } catch (e) { console.error('Outreach log failed:', e) }
    setLogging(null)
  }

  function badge(rate: number | null, contacted: number) {
    if (contacted === 0 || rate === null) return { label: 'No data yet', bg: '#F7F6F2', color: '#72706A' }
    if (rate >= 0.7) return { label: `${Math.round(rate * 100)}% responds`, bg: '#EAF3DE', color: '#27500A' }
    if (rate >= 0.4) return { label: `${Math.round(rate * 100)}% responds`, bg: '#FAEEDA', color: '#633806' }
    return { label: `${Math.round(rate * 100)}% responds`, bg: '#FCEBEB', color: '#791F1F' }
  }

  if (loading) return <div style={{ padding:'10px 14px', background:'#F7F6F2', borderRadius:'8px', marginTop:'10px', fontSize:'12px', color:'#72706A' }}>Loading PI contacts…</div>

  if (!contacts.length) return (
    <div style={{ padding:'10px 14px', background:'#F7F6F2', borderRadius:'8px', marginTop:'10px', fontSize:'12px', color:'#72706A' }}>
      No PI contact on file. Search manually on{' '}
      <a href={`https://clinicaltrials.gov/study/${nctId}`} target="_blank" rel="noreferrer" style={{ color: brandColor }}>ClinicalTrials.gov ↗</a>
    </div>
  )

  return (
    <div style={{ marginTop:'10px' }}>
      {contacts.slice(0, 2).map(c => {
        const b = badge(c.response_rate, c.times_contacted)
        const subject = encodeURIComponent(`Clinical trial inquiry — ${trialTitle.slice(0, 50)}`)
        return (
          <div key={c.id} style={{ background:'#F7F6F2', border:'1px solid #E2E0D8', borderLeft:`3px solid ${brandColor}`, borderRadius:'8px', padding:'12px 14px', marginBottom:'8px' }}>
            <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:'8px', gap:'10px' }}>
              <div>
                <div style={{ fontSize:'13px', fontWeight:'500', color:'#1C1B18' }}>
                  {c.pi_name || 'Contact name not listed'}
                  {c.verified && <span style={{ marginLeft:'7px', fontSize:'10px', background:'#EAF3DE', color:'#27500A', padding:'1px 6px', borderRadius:'99px', fontWeight:'600' }}>✓ Verified</span>}
                </div>
                {(c.pi_institution || c.pi_city) && <div style={{ fontSize:'12px', color:'#72706A', marginTop:'2px' }}>{[c.pi_institution, c.pi_city, c.pi_state].filter(Boolean).join(', ')}</div>}
              </div>
              <span style={{ fontSize:'10px', fontWeight:'600', padding:'2px 8px', borderRadius:'99px', background:b.bg, color:b.color, flexShrink:0, whiteSpace:'nowrap' }}>{b.label}</span>
            </div>
            <div style={{ display:'flex', gap:'8px', flexWrap:'wrap', marginBottom:'10px' }}>
              {c.pi_email && !c.email_bounced && (
                <a href={`mailto:${c.pi_email}?subject=${subject}`} style={{ fontSize:'12px', color:brandColor, textDecoration:'none', display:'flex', alignItems:'center', gap:'4px', padding:'4px 10px', background:'#E1F5EE', borderRadius:'6px', border:'1px solid rgba(15,110,86,.2)' }}>✉ {c.pi_email}</a>
              )}
              {c.email_bounced && <span style={{ fontSize:'12px', color:'#A32D2D', padding:'4px 10px', background:'#FEF0EE', borderRadius:'6px' }}>⚠ Email bounced</span>}
              {c.pi_phone && <a href={`tel:${c.pi_phone}`} style={{ fontSize:'12px', color:'#1C1B18', textDecoration:'none', display:'flex', alignItems:'center', gap:'4px', padding:'4px 10px', background:'#fff', borderRadius:'6px', border:'1px solid #E2E0D8' }}>📞 {c.pi_phone}</a>}
            </div>
            <div style={{ borderTop:'1px solid #E2E0D8', paddingTop:'8px' }}>
              <div style={{ fontSize:'10px', fontWeight:'600', letterSpacing:'.06em', textTransform:'uppercase', color:'#72706A', marginBottom:'6px' }}>Log outreach</div>
              <div style={{ display:'flex', gap:'6px', flexWrap:'wrap' }}>
                {[{ action:'email_sent', label:'Email sent' }, { action:'whatsapp_sent', label:'WhatsApp sent' }, { action:'phone_called', label:'Called' }, { action:'pi_responded', label:'✓ PI responded' }].map(({ action, label }) => {
                  const done = logDone[action + c.id], working = logging === action + c.id
                  return (
                    <button key={action} disabled={working} onClick={() => !done && logOutreach(c.id, action)}
                      style={{ fontSize:'11px', fontWeight:'500', padding:'4px 10px', borderRadius:'6px', cursor: done ? 'default' : 'pointer', fontFamily:'sans-serif', border:`1px solid ${done ? 'rgba(15,110,86,.3)' : '#E2E0D8'}`, background: done ? '#EAF3DE' : '#fff', color: done ? '#27500A' : '#1C1B18', opacity: working ? 0.5 : 1 }}>
                      {working ? '…' : done ? `✓ ${label}` : label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )
      })}
      {contacts.length > 2 && <div style={{ fontSize:'12px', color:'#72706A', marginTop:'4px' }}>+{contacts.length - 2} more on <a href={`https://clinicaltrials.gov/study/${nctId}`} target="_blank" rel="noreferrer" style={{ color: brandColor }}>ClinicalTrials.gov ↗</a></div>}
    </div>
  )
}
