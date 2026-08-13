/**
 * components/EnrollmentStatusDropdown.tsx
 * Tracks patient journey from match through enrollment outcome.
 * Every change is audit-logged server-side via PATCH /api/match/[jobId].
 */

import { useState } from 'react'

type Status = 'pending'|'coordinator_reviewing'|'pi_contacted'|'pre_screening_booked'|'pre_screening_done'|'enrolled'|'screen_failed'|'patient_declined'|'trial_closed'|'not_actioned'

const CFG: Record<Status, { label: string; color: string; bg: string; icon: string }> = {
  pending:               { label:'Pending review',       color:'#72706A', bg:'#F7F6F2', icon:'○'  },
  coordinator_reviewing: { label:'Reviewing',             color:'#185FA5', bg:'#E6F1FB', icon:'◎' },
  pi_contacted:          { label:'PI contacted',          color:'#185FA5', bg:'#E6F1FB', icon:'📤' },
  pre_screening_booked:  { label:'Pre-screening booked',  color:'#BA7517', bg:'#FEF3E2', icon:'📅' },
  pre_screening_done:    { label:'Pre-screening done',    color:'#BA7517', bg:'#FEF3E2', icon:'🔍' },
  enrolled:              { label:'Enrolled ✓',            color:'#0F6E56', bg:'#EAF3DE', icon:'✅' },
  screen_failed:         { label:'Screen failed',         color:'#A32D2D', bg:'#FEF0EE', icon:'✗'  },
  patient_declined:      { label:'Patient declined',      color:'#A32D2D', bg:'#FEF0EE', icon:'✗'  },
  trial_closed:          { label:'Trial closed',          color:'#72706A', bg:'#F7F6F2', icon:'■'  },
  not_actioned:          { label:'Not actioned',          color:'#72706A', bg:'#F7F6F2', icon:'–'  },
}

interface Props { jobId: string; resultId: string; currentStatus: Status; brandColor?: string; onUpdated?: (s: Status) => void }

export default function EnrollmentStatusDropdown({ jobId, resultId, currentStatus, brandColor = '#0F6E56', onUpdated }: Props) {
  const [status, setStatus]   = useState<Status>(currentStatus)
  const [open,   setOpen]     = useState(false)
  const [saving, setSaving]   = useState(false)
  const [showNote, setShowNote] = useState(false)
  const [pendingStatus, setPendingStatus] = useState<Status | null>(null)
  const [note,  setNote]      = useState('')
  const [error, setError]     = useState('')

  const cfg = CFG[status]

  async function updateStatus(newStatus: Status, noteText?: string) {
    if (newStatus === status) { setOpen(false); return }
    setSaving(true); setError('')
    try {
      const r = await fetch(`/api/match/${jobId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result_id: resultId, enrollment_status: newStatus, enrollment_notes: noteText || undefined, screen_fail_reason: newStatus === 'screen_failed' ? noteText : undefined }),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.error || 'Update failed') }
      setStatus(newStatus); setOpen(false); setShowNote(false); setNote('')
      onUpdated?.(newStatus)
    } catch (e: any) { setError(e.message) }
    setSaving(false)
  }

  function handleSelect(newStatus: Status) {
    if (newStatus === 'screen_failed' || newStatus === 'not_actioned') {
      setPendingStatus(newStatus); setShowNote(true); setOpen(false)
    } else {
      updateStatus(newStatus)
    }
  }

  const groups = [
    { label:'In progress', statuses:['pending','coordinator_reviewing','pi_contacted','pre_screening_booked','pre_screening_done'] as Status[] },
    { label:'Outcome',     statuses:['enrolled','screen_failed','patient_declined','trial_closed','not_actioned'] as Status[] },
  ]

  return (
    <div style={{ position:'relative', display:'inline-block' }}>
      <button onClick={() => setOpen(o => !o)} disabled={saving}
        style={{ display:'inline-flex', alignItems:'center', gap:'6px', padding:'4px 10px', borderRadius:'99px', border:`1px solid ${cfg.color}33`, background:cfg.bg, color:cfg.color, fontSize:'11.5px', fontWeight:'500', cursor: saving ? 'not-allowed' : 'pointer', fontFamily:'sans-serif', whiteSpace:'nowrap', opacity: saving ? 0.6 : 1 }}>
        <span>{cfg.icon}</span><span>{saving ? 'Saving…' : cfg.label}</span>
        {!saving && <span style={{ fontSize:'9px', opacity:0.7 }}>▾</span>}
      </button>

      {open && (
        <>
          <div style={{ position:'fixed', inset:0, zIndex:10 }} onClick={() => setOpen(false)}/>
          <div style={{ position:'absolute', top:'calc(100% + 4px)', left:0, zIndex:20, background:'#fff', border:'1px solid #E2E0D8', borderRadius:'10px', boxShadow:'0 4px 20px rgba(0,0,0,.12)', minWidth:'220px', overflow:'hidden' }}>
            {groups.map(g => (
              <div key={g.label}>
                <div style={{ padding:'6px 14px 4px', fontSize:'10px', fontWeight:'600', letterSpacing:'.06em', textTransform:'uppercase', color:'#72706A', background:'#F7F6F2', borderBottom:'1px solid #E2E0D8' }}>{g.label}</div>
                {g.statuses.map(s => {
                  const c = CFG[s], active = s === status
                  return (
                    <button key={s} onClick={() => handleSelect(s)}
                      style={{ width:'100%', textAlign:'left', padding:'8px 14px', fontSize:'12.5px', cursor:'pointer', background: active ? c.bg : '#fff', border:'none', borderBottom:'1px solid #F7F6F2', color: active ? c.color : '#1C1B18', fontFamily:'sans-serif', display:'flex', alignItems:'center', gap:'8px' }}>
                      <span style={{ fontSize:'13px', minWidth:'16px' }}>{c.icon}</span><span>{c.label}</span>
                      {active && <span style={{ marginLeft:'auto', fontSize:'11px', color:c.color }}>current</span>}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </>
      )}

      {showNote && pendingStatus && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.45)', zIndex:200, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
          <div style={{ background:'#fff', borderRadius:'12px', padding:'22px 24px', maxWidth:'400px', width:'100%' }}>
            <h3 style={{ margin:'0 0 6px', fontSize:'15px', fontWeight:'500' }}>{pendingStatus === 'screen_failed' ? 'Screen failure reason' : 'Why not actioned?'}</h3>
            <p style={{ fontSize:'12px', color:'#72706A', margin:'0 0 14px', lineHeight:'1.5' }}>{pendingStatus === 'screen_failed' ? 'Recording the reason helps improve future match accuracy.' : 'Optional — helps track why this match wasn\'t pursued.'}</p>
            <textarea value={note} onChange={e => setNote(e.target.value)} placeholder={pendingStatus === 'screen_failed' ? 'e.g. eGFR below threshold at screening visit' : 'e.g. Patient already enrolled elsewhere'}
              style={{ width:'100%', minHeight:'80px', padding:'10px 12px', border:'1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', fontFamily:'sans-serif', resize:'vertical', boxSizing:'border-box', outline:'none' }} autoFocus/>
            {error && <p style={{ color:'#A32D2D', fontSize:'12px', margin:'6px 0 0' }}>{error}</p>}
            <div style={{ display:'flex', gap:'8px', marginTop:'14px', justifyContent:'flex-end' }}>
              <button onClick={() => { setShowNote(false); setNote('') }} style={{ padding:'8px 16px', background:'#fff', border:'1px solid #E2E0D8', borderRadius:'7px', cursor:'pointer', fontSize:'13px', fontFamily:'sans-serif' }}>Cancel</button>
              <button onClick={() => updateStatus(pendingStatus, note)} style={{ padding:'8px 16px', background:brandColor, color:'#fff', border:'none', borderRadius:'7px', cursor:'pointer', fontSize:'13px', fontWeight:'500', fontFamily:'sans-serif' }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
