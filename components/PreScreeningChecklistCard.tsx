/**
 * components/PreScreeningChecklistCard.tsx — Production rewrite
 *
 * Additions over prototype:
 *  - WhatsApp send modal with phone input and send confirmation
 *  - Confidence indicator on low-confidence AI items (< 0.6)
 *  - PDF download link (triggers match report with checklist section)
 *  - Loading skeleton to prevent layout shift
 *  - Accessible labels on all checkboxes and buttons
 *  - Error state with retry
 */

import { useState, useEffect, useCallback } from 'react'

interface ChecklistItem {
  category:    string
  item:        string
  required:    boolean
  notes?:      string
  confidence?: number
}

interface ChecklistData {
  id:           string
  checklist:    ChecklistItem[]
  status:       'generated' | 'reviewed' | 'completed'
  nct_id:       string
  trial_title?: string
  generated_at: string
  reviewed_at?: string
}

interface Props {
  matchResultId: string
  nctId:         string
  trialTitle:    string
  patientCode:   string
  brandColor:    string
  jobId?:        string
}

const CAT_ORDER = ['labs', 'documents', 'medications', 'preparation', 'questions']
const CAT_LABELS: Record<string,string> = {
  labs:        'Lab tests & investigations',
  documents:   'Documents to carry',
  medications: 'Medication information',
  preparation: 'Day-of preparation',
  questions:   'Questions for the PI',
}
const CAT_ICONS: Record<string,string> = {
  labs:'🧪', documents:'📄', medications:'💊', preparation:'📋', questions:'❓',
}

export default function PreScreeningChecklistCard({ matchResultId, nctId, trialTitle, patientCode, brandColor, jobId }: Props) {
  const [open,        setOpen]        = useState(false)
  const [loading,     setLoading]     = useState(false)
  const [checklist,   setChecklist]   = useState<ChecklistData | null>(null)
  const [fetchErr,    setFetchErr]    = useState<string | null>(null)
  const [checked,     setChecked]     = useState<Set<number>>(new Set())
  const [saving,      setSaving]      = useState(false)
  const [showWA,      setShowWA]      = useState(false)
  const [waPhone,     setWaPhone]     = useState('')
  const [waSending,   setWASending]   = useState(false)
  const [waResult,    setWAResult]    = useState<{ok:boolean;msg:string}|null>(null)

  const fetchChecklist = useCallback(async (force = false) => {
    setLoading(true); setFetchErr(null)
    try {
      const url = `/api/prescreening?match_result_id=${matchResultId}&nct_id=${encodeURIComponent(nctId)}${force ? '&force=1' : ''}`
      const r   = await fetch(url)
      const d   = await r.json()
      if (!r.ok) { setFetchErr(d.error?.message || 'Failed to load checklist.'); return }
      setChecklist(d.checklist)
    } catch { setFetchErr('Network error. Please try again.') }
    setLoading(false)
  }, [matchResultId, nctId])

  useEffect(() => { if (open && !checklist && !loading) fetchChecklist() }, [open, checklist, loading, fetchChecklist])

  const items   = checklist?.checklist || []
  const reqItems = items.filter(i => i.required)
  const doneReq  = items.filter((i, idx) => i.required && checked.has(idx)).length
  const allDone  = reqItems.length > 0 && doneReq === reqItems.length

  const toggle = (idx: number) => setChecked(p => { const n = new Set(p); n.has(idx) ? n.delete(idx) : n.add(idx); return n })

  const markReviewed = async () => {
    if (!checklist?.id) return
    setSaving(true)
    const r = await fetch(`/api/prescreening?id=${checklist.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify({ status: 'reviewed' }),
    })
    if (r.ok) { const d = await r.json(); setChecklist(d.checklist) }
    setSaving(false)
  }

  const [waDeepLink,  setWaDeepLink]  = useState<string | null>(null)

  const sendWA = async () => {
    const phone = waPhone.replace(/\D/g, '')
    if (phone.length < 10) { setWAResult({ ok: false, msg: 'Enter a valid 10-digit number.' }); return }
    setWASending(true); setWAResult(null); setWaDeepLink(null)
    const r = await fetch('/api/prescreening/whatsapp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify({
        checklist_id: checklist?.id,
        phone:        phone.startsWith('91') ? phone : `91${phone.slice(-10)}`,
        patient_code: patientCode,
        trial_title:  trialTitle,
      }),
    })
    const d = await r.json()
    setWASending(false)

    if (!r.ok) {
      setWAResult({ ok: false, msg: d.error?.message || 'Could not prepare the message. Please try again.' })
      return
    }

    // The API always returns a deep link now — automatic delivery is a bonus,
    // not a requirement, since cold patient numbers can't receive a Business
    // API message without an approved template.
    if (d.auto_sent) {
      setWAResult({ ok: true, msg: 'Sent automatically — you can also open WhatsApp below to confirm.' })
    } else {
      setWAResult({ ok: true, msg: 'Tap below to open WhatsApp and send from your own number.' })
    }
    setWaDeepLink(d.deep_link)
    // Modal stays open so the coordinator can tap the deep link button
  }

  const grouped = CAT_ORDER.reduce<Record<string,{item:ChecklistItem;idx:number}[]>>((acc, cat) => {
    const g = items.map((item, idx) => ({ item, idx })).filter(x => x.item.category === cat)
    if (g.length) acc[cat] = g
    return acc
  }, {})

  const statusCfg = {
    generated: { label: 'Generated', bg: '#FEF9F0', color: '#BA7517' },
    reviewed:  { label: 'Reviewed',  bg: '#EAF3DE', color: '#27500A' },
    completed: { label: 'Completed', bg: '#E1F5EE', color: '#0F6E56' },
  }

  const B = (primary=false, c=brandColor): React.CSSProperties => ({
    padding:'7px 13px', background: primary ? c : '#fff', color: primary ? '#fff' : '#1C1B18',
    border: primary ? 'none' : '1px solid #E2E0D8', borderRadius:'7px', fontSize:'12px',
    fontWeight:500, cursor:'pointer', fontFamily:'sans-serif', display:'inline-flex', alignItems:'center', gap:'5px',
  })

  return (
    <>
      <div style={{ border:`1px solid ${brandColor}22`, borderRadius:'9px', marginTop:'10px', overflow:'hidden' }}>
        <button
          onClick={() => setOpen(o => !o)} aria-expanded={open}
          style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 14px', background:`${brandColor}0A`, border:'none', cursor:'pointer', fontFamily:'sans-serif', textAlign:'left' }}
        >
          <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
            <span aria-hidden>📋</span>
            <span style={{ fontSize:'13px', fontWeight:500, color:brandColor }}>Pre-screening checklist</span>
            {checklist && (() => { const s = statusCfg[checklist.status]; return <span style={{ fontSize:'10px', fontWeight:600, padding:'2px 7px', borderRadius:'99px', background:s.bg, color:s.color, textTransform:'uppercase', letterSpacing:'.04em' }}>{s.label}</span> })()}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
            {items.length > 0 && <span style={{ fontSize:'11px', color:'#72706A' }}>{doneReq}/{reqItems.length} done</span>}
            <span aria-hidden style={{ color:'#B4B2A9', fontSize:'13px', transform:open?'rotate(180deg)':'none', transition:'transform .2s', display:'inline-block' }}>▾</span>
          </div>
        </button>

        {open && (
          <div style={{ padding:'14px 16px' }}>

            {loading && (
              <div>
                {[80,60,90,70].map((w,i) => <div key={i} style={{ height:'11px', background:'#F1EFE8', borderRadius:'6px', marginBottom:'9px', width:`${w}%` }}/>)}
                <div style={{ fontSize:'12px', color:'#72706A', textAlign:'center', marginTop:'6px' }}>Claude is generating…</div>
              </div>
            )}

            {fetchErr && !loading && (
              <div style={{ background:'#FEF0EE', border:'1px solid #F0959566', borderRadius:'8px', padding:'11px 13px', marginBottom:'10px' }}>
                <div style={{ fontSize:'12.5px', color:'#A32D2D', marginBottom:'8px' }}>{fetchErr}</div>
                <button onClick={() => fetchChecklist()} style={B()}>Retry</button>
              </div>
            )}

            {!loading && !fetchErr && checklist && (
              <>
                {reqItems.length > 0 && (
                  <div style={{ marginBottom:'14px' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', fontSize:'11px', color:'#72706A', marginBottom:'4px' }}>
                      <span>Required items ticked</span>
                      <span style={{ fontWeight:500, color:allDone ? '#0F6E56' : '#1C1B18' }}>{doneReq} / {reqItems.length}</span>
                    </div>
                    <div style={{ height:'4px', background:'#E2E0D8', borderRadius:'99px', overflow:'hidden' }}>
                      <div style={{ height:'100%', width:`${reqItems.length ? Math.round((doneReq/reqItems.length)*100) : 0}%`, background:allDone ? '#0F6E56' : brandColor, borderRadius:'99px', transition:'width .3s' }}/>
                    </div>
                  </div>
                )}

                {CAT_ORDER.filter(c => grouped[c]).map(cat => (
                  <div key={cat} style={{ marginBottom:'10px' }}>
                    <div style={{ fontSize:'11px', fontWeight:600, color:'#72706A', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:'7px', display:'flex', alignItems:'center', gap:'5px' }}>
                      <span>{CAT_ICONS[cat]}</span><span>{CAT_LABELS[cat]}</span>
                    </div>
                    {grouped[cat].map(({ item, idx }) => {
                      const done    = checked.has(idx)
                      const lowConf = (item.confidence ?? 1) < 0.6
                      return (
                        <label key={idx} style={{ display:'flex', alignItems:'flex-start', gap:'9px', padding:'7px 0', borderBottom:'1px solid #F1EFE8', cursor:'pointer', opacity:done?0.5:1 }}>
                          <input type="checkbox" checked={done} onChange={() => toggle(idx)} style={{ marginTop:'2px', accentColor:brandColor, width:'14px', height:'14px', flexShrink:0, cursor:'pointer' }}/>
                          <div style={{ flex:1 }}>
                            <div style={{ fontSize:'13px', color:'#1C1B18', lineHeight:1.5, textDecoration:done?'line-through':'none' }}>{item.item}</div>
                            {item.notes && <div style={{ fontSize:'11px', color:'#72706A', marginTop:'2px' }}>{item.notes}</div>}
                            {lowConf && <div style={{ fontSize:'10px', color:'#BA7517', marginTop:'2px' }}>⚠ Verify this applies to your patient</div>}
                          </div>
                          <span style={{ fontSize:'10px', fontWeight:600, padding:'2px 7px', borderRadius:'99px', whiteSpace:'nowrap', flexShrink:0, background:item.required?'#FEF0EE':'#F7F6F2', color:item.required?'#A32D2D':'#72706A' }}>
                            {item.required ? 'Required' : 'Optional'}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                ))}

                <div style={{ display:'flex', gap:'7px', flexWrap:'wrap', marginTop:'12px', paddingTop:'10px', borderTop:'1px solid #E2E0D8' }}>
                  {checklist.status === 'generated' && (
                    <button onClick={markReviewed} disabled={saving} style={B(true)}>
                      {saving ? 'Saving…' : '✓ Mark reviewed'}
                    </button>
                  )}
                  {checklist.status === 'reviewed' && (
                    <span style={{ fontSize:'12px', color:'#0F6E56', display:'flex', alignItems:'center', gap:'5px' }}>
                      ✓ Reviewed
                      {checklist.reviewed_at && <span style={{ color:'#B4B2A9' }}>· {new Date(checklist.reviewed_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}</span>}
                    </span>
                  )}
                  <button onClick={() => { setShowWA(true); setWAResult(null); setWaDeepLink(null) }} style={B()}>📲 Send via WhatsApp</button>
                  {jobId && (
                    <a href={`/api/reports/generate?job_id=${jobId}&include_prescreening=1&nct_id=${encodeURIComponent(nctId)}`} target="_blank" rel="noreferrer" style={{ ...B(), textDecoration:'none' }}>
                      📄 PDF
                    </a>
                  )}
                  <button onClick={() => fetchChecklist(true)} style={{ ...B(), marginLeft:'auto', color:'#72706A' }}>↻ Regenerate</button>
                </div>
              </>
            )}

            {!loading && !fetchErr && !checklist && (
              <div style={{ textAlign:'center', padding:'16px 0' }}>
                <div style={{ fontSize:'24px', marginBottom:'8px' }}>📋</div>
                <div style={{ fontSize:'13px', color:'#72706A', marginBottom:'12px' }}>No checklist yet for this trial visit.</div>
                <button onClick={() => fetchChecklist()} style={B(true)}>✨ Generate with AI</button>
              </div>
            )}
          </div>
        )}
      </div>

      {showWA && (
        <div role="dialog" aria-modal="true" aria-labelledby="wa-dlg-title" style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:200, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
          <div style={{ background:'#fff', borderRadius:'12px', padding:'22px 24px', maxWidth:'420px', width:'100%', boxShadow:'0 20px 60px rgba(0,0,0,.18)' }}>
            <h2 id="wa-dlg-title" style={{ margin:'0 0 5px', fontSize:'15px', fontWeight:500 }}>Send checklist via WhatsApp</h2>
            <p style={{ fontSize:'12px', color:'#72706A', margin:'0 0 14px', lineHeight:1.6 }}>
              Enter the patient's WhatsApp number. This is not stored — used only for this send.
            </p>
            <label style={{ fontSize:'11px', fontWeight:600, color:'#72706A', display:'block', marginBottom:'5px', textTransform:'uppercase', letterSpacing:'.05em' }}>
              Mobile number
            </label>
            <div style={{ display:'flex', gap:'7px', marginBottom:'12px' }}>
              <span style={{ padding:'9px 11px', background:'#F7F6F2', border:'1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', color:'#1C1B18', flexShrink:0 }}>+91</span>
              <input type="tel" value={waPhone} onChange={e => { setWaPhone(e.target.value); setWAResult(null) }}
                onKeyDown={e => e.key === 'Enter' && sendWA()} placeholder="9XXXXXXXXX" maxLength={12} autoFocus
                style={{ flex:1, padding:'9px 12px', border:'1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', fontFamily:'sans-serif', outline:'none' }}/>
            </div>
            {waResult && (
              <div style={{ padding:'8px 12px', borderRadius:'7px', fontSize:'12.5px', marginBottom:'12px', background:waResult.ok?'#EAF3DE':'#FEF0EE', color:waResult.ok?'#0F6E56':'#A32D2D' }}>
                {waResult.ok ? '✓ ' : '✗ '}{waResult.msg}
              </div>
            )}
            <div style={{ display:'flex', gap:'8px', flexWrap:'wrap' }}>
              {!waDeepLink ? (
                <button onClick={sendWA} disabled={waSending || !waPhone.replace(/\D/g,'')} style={{ ...B(true), flex:1, justifyContent:'center' }}>
                  {waSending ? 'Preparing…' : '📲 Prepare message'}
                </button>
              ) : (
                <a
                  href={waDeepLink}
                  target="_blank"
                  rel="noreferrer"
                  style={{ ...B(true), flex:1, justifyContent:'center', textDecoration:'none' }}
                  onClick={() => setTimeout(() => { setShowWA(false); setWaPhone(''); setWAResult(null); setWaDeepLink(null) }, 400)}
                >
                  💬 Open in WhatsApp →
                </a>
              )}
              <button onClick={() => { setShowWA(false); setWaPhone(''); setWAResult(null); setWaDeepLink(null) }} style={B()}>
                {waDeepLink ? 'Close' : 'Cancel'}
              </button>
            </div>
            <p style={{ fontSize:'10.5px', color:'#B4B2A9', marginTop:'10px', lineHeight:1.5 }}>
              {waDeepLink
                ? 'This opens WhatsApp on your device with the message ready — review it, then hit send from your own number.'
                : 'We\'ll prepare the message and, where possible, try sending it automatically. You can also send it yourself from your own WhatsApp.'}
            </p>
          </div>
        </div>
      )}
    </>
  )
}
