/**
 * components/EngagementsPanel.tsx
 * Coordinator engagement inbox — incoming sponsor site engagement requests.
 * Shows when org is coordinator type (hospital/academic/cro).
 * Coordinator can Accept (interested), Decline, or ask for more info.
 *
 * Phase 2 Week 11-12: "Coordinator responds with availability + capacity"
 */

import { useState, useEffect, useRef } from 'react'

interface Props {
  brandColor: string
  orgId:      string
}

export default function EngagementsPanel({ brandColor, orgId }: Props) {
  const [requests,    setRequests]    = useState<any[]>([])
  const [loading,     setLoading]     = useState(true)
  const [responding,  setResponding]  = useState<string | null>(null)
  const [replyText,   setReplyText]   = useState('')
  const [respondStatus, setRespondStatus] = useState<'interested'|'declined'|null>(null)
  const pollRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    loadRequests()
    // Poll every 30s for real-time status updates (Week 11-12 spec)
    pollRef.current = setInterval(loadRequests, 30_000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  async function loadRequests() {
    try {
      const r = await fetch('/api/sponsor/engage')
      if (r.ok) {
        const d = await r.json()
        setRequests(d.requests || [])
      }
    } catch {}
    setLoading(false)
  }

  async function respond(requestId: string, status: 'interested' | 'declined') {
    if (!replyText.trim() && status === 'interested') return
    const r = await fetch(`/api/sponsor/engage?id=${requestId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status, coordinator_response: replyText }),
    })
    if (r.ok) {
      setResponding(null)
      setReplyText('')
      setRespondStatus(null)
      loadRequests()
    }
  }

  const statusMeta: Record<string, { bg: string; color: string; label: string; icon: string }> = {
    requested:            { bg: '#F7F6F2', color: '#5F5E5A', label: 'New request',        icon: '📩' },
    coordinator_notified: { bg: '#E6F1FB', color: '#185FA5', label: 'Awaiting response',  icon: '🔔' },
    interested:           { bg: '#E1F5EE', color: '#0F6E56', label: 'Interested',          icon: '✅' },
    declined:             { bg: '#FEF0EE', color: '#A32D2D', label: 'Declined',            icon: '❌' },
    meeting_booked:       { bg: '#EAF3DE', color: '#27500A', label: 'Meeting booked',      icon: '📅' },
    closed:               { bg: '#F7F6F2', color: '#888780', label: 'Closed',              icon: '🔒' },
  }

  const S = {
    card: { background:'#fff', border:'1px solid #E2E0D8', borderRadius:'10px', padding:'16px 20px', marginBottom:'12px' } as any,
    btn:  (primary=false, danger=false) => ({
      padding:'7px 14px', background: danger ? '#FEF0EE' : primary ? brandColor : '#fff',
      color: danger ? '#A32D2D' : primary ? '#fff' : '#1C1B18',
      border: danger ? '1px solid #F0959588' : primary ? 'none' : '1px solid #E2E0D8',
      borderRadius:'7px', fontSize:'12px', cursor:'pointer', fontFamily:'sans-serif', fontWeight:500,
    }) as any,
    badge: (bg: string, color: string) => ({
      background:bg, color, fontSize:'10px', fontWeight:600, padding:'2px 8px',
      borderRadius:'99px', letterSpacing:'.04em', textTransform:'uppercase' as any, display:'inline-flex', alignItems:'center', gap:'4px',
    }) as any,
  }

  const pending  = requests.filter(r => ['requested','coordinator_notified'].includes(r.status))
  const resolved = requests.filter(r => !['requested','coordinator_notified'].includes(r.status))

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'6px' }}>
        <div>
          <h2 style={{ margin:0, fontSize:'17px', fontWeight:500 }}>Site engagement requests</h2>
          <p style={{ margin:'3px 0 0', fontSize:'12px', color:'#72706A' }}>
            Pharma and biotech sponsors interested in your site for clinical trials.
          </p>
        </div>
        <div style={{ display:'flex', gap:'8px', alignItems:'center' }}>
          {pending.length > 0 && (
            <span style={{ background:'#FEF0EE', color:'#A32D2D', fontSize:'12px', fontWeight:600, padding:'3px 10px', borderRadius:'99px' }}>
              {pending.length} pending
            </span>
          )}
          <button style={S.btn()} onClick={loadRequests}>↻ Refresh</button>
        </div>
      </div>

      {/* Privacy note */}
      <div style={{ background:'#F7F6F2', border:'1px solid #E2E0D8', borderRadius:'8px', padding:'9px 12px', marginBottom:'16px', fontSize:'12px', color:'#72706A', lineHeight:1.6 }}>
        🔒 Sponsors cannot see your patient data. They only see aggregate patient counts. Their identity is anonymous until you respond with interest.
      </div>

      {loading ? (
        <div style={{ ...S.card, padding:'48px', textAlign:'center', color:'#72706A' }}>
          Loading engagement requests…
        </div>
      ) : requests.length === 0 ? (
        <div style={{ ...S.card, padding:'48px', textAlign:'center' }}>
          <div style={{ fontSize:'32px', marginBottom:'10px' }}>📩</div>
          <div style={{ fontWeight:500, marginBottom:'6px' }}>No engagement requests yet</div>
          <div style={{ fontSize:'12px', color:'#72706A', lineHeight:1.6, maxWidth:'360px', margin:'0 auto' }}>
            When a pharma or biotech sponsor is interested in running a trial at your site, 
            they'll send a request here. You'll also be notified via WhatsApp.
          </div>
        </div>
      ) : (
        <>
          {/* Pending requests — shown first, most prominent */}
          {pending.length > 0 && (
            <>
              <div style={{ fontSize:'11px', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', color:'#72706A', marginBottom:'8px' }}>
                Awaiting your response
              </div>
              {pending.map(req => <RequestCard key={req.id} req={req} statusMeta={statusMeta} S={S} brandColor={brandColor} onRespond={(id) => { setResponding(id); setReplyText(''); setRespondStatus(null) }} responding={responding} replyText={replyText} setReplyText={setReplyText} respondStatus={respondStatus} setRespondStatus={setRespondStatus} onSubmitResponse={respond} />)}
            </>
          )}

          {/* Resolved requests */}
          {resolved.length > 0 && (
            <>
              <div style={{ fontSize:'11px', fontWeight:600, letterSpacing:'.06em', textTransform:'uppercase', color:'#B4B2A9', marginBottom:'8px', marginTop: pending.length > 0 ? '20px' : 0 }}>
                Past requests
              </div>
              {resolved.map(req => <RequestCard key={req.id} req={req} statusMeta={statusMeta} S={S} brandColor={brandColor} onRespond={() => {}} responding={null} replyText='' setReplyText={() => {}} respondStatus={null} setRespondStatus={() => {}} onSubmitResponse={() => {}} />)}
            </>
          )}
        </>
      )}
    </div>
  )
}

function RequestCard({ req, statusMeta, S, brandColor, onRespond, responding, replyText, setReplyText, respondStatus, setRespondStatus, onSubmitResponse }: any) {
  const meta         = statusMeta[req.status] || statusMeta.requested
  const isPending    = ['requested','coordinator_notified'].includes(req.status)
  const isResponding = responding === req.id

  // Anonymous sponsor label until response
  // Identity is anonymous while pending; revealed once coordinator expresses interest
  const sponsorLabel = isPending
    ? 'A pharma / biotech sponsor (anonymous until you respond)'
    : req.sponsor_org?.name || 'Sponsor'
  const sponsorCity  = !isPending && req.sponsor_org?.city ? `· ${req.sponsor_org.city}` : ''
  const sponsorType  = !isPending && req.sponsor_org?.org_type ? req.sponsor_org.org_type : ''
  const isRevealed   = !isPending && req.sponsor_org?.name
  const trialArea    = req.protocols?.therapeutic_area || 'clinical research'
  const trialPhase   = req.protocols?.phase || 'clinical study'
  const protocolTitle = req.protocols?.title || 'Undisclosed protocol'

  return (
    <div style={{ ...S.card, borderLeft: isPending ? `3px solid ${brandColor}` : '1px solid #E2E0D8' }}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'12px', marginBottom:'10px' }}>
        <div style={{ flex:1 }}>
          <div style={{ display:'flex', alignItems:'center', gap:'8px', flexWrap:'wrap', marginBottom:'5px' }}>
            <span style={{ fontWeight:500, fontSize:'14px' }}>
              {meta.icon} {sponsorLabel}{sponsorCity && <span style={{ fontWeight:400, fontSize:'13px', color:'#72706A', marginLeft:'5px' }}>{sponsorCity}</span>}
                {sponsorType && <span style={{ fontSize:'10px', fontWeight:600, padding:'2px 6px', borderRadius:'99px', background:'#EEEDFE', color:'#3C3489', marginLeft:'5px', textTransform:'uppercase' as any }}>{sponsorType}</span>}
            </span>
            <span style={S.badge(meta.bg, meta.color)}>{meta.label}</span>
          </div>

          <div style={{ fontSize:'12.5px', color:'#1C1B18', marginBottom:'4px' }}>
            Interested in your site for a{' '}
            <strong>{trialArea}</strong> trial
            {trialPhase !== 'clinical study' && ` (${trialPhase})`}.
          </div>

          {!isPending && (
            <div style={{ fontSize:'12px', color:'#72706A' }}>
              Protocol: <strong>{protocolTitle}</strong>
            </div>
          )}

          {req.sponsor_message && (
            <div style={{ fontSize:'12.5px', color:'#1C1B18', background:'#F7F6F2', borderRadius:'7px', padding:'8px 10px', marginTop:'8px', lineHeight:1.6 }}>
              <span style={{ color:'#72706A', fontSize:'11px', display:'block', marginBottom:'3px' }}>MESSAGE FROM SPONSOR</span>
              {req.sponsor_message}
            </div>
          )}

          {req.coordinator_response && (
            <div style={{ fontSize:'12.5px', color:'#0F6E56', background:'#E1F5EE', borderRadius:'7px', padding:'8px 10px', marginTop:'8px', lineHeight:1.6 }}>
              <span style={{ fontSize:'11px', display:'block', marginBottom:'3px', fontWeight:600 }}>YOUR RESPONSE</span>
              {req.coordinator_response}
            </div>
          )}

          <div style={{ fontSize:'11px', color:'#B4B2A9', marginTop:'8px' }}>
            Received {new Date(req.created_at).toLocaleDateString('en-IN',{ day:'2-digit', month:'short', year:'numeric' })}
            {req.notified_at && ` · Notified ${new Date(req.notified_at).toLocaleDateString('en-IN',{ day:'2-digit', month:'short' })}`}
          </div>
        </div>
      </div>

      {/* Response form for pending requests */}
      {isPending && !isResponding && (
        <div style={{ display:'flex', gap:'8px', paddingTop:'10px', borderTop:'1px solid #E2E0D8' }}>
          <button style={S.btn(true)} onClick={() => onRespond(req.id)}>
            ✅ Respond to this request
          </button>
        </div>
      )}

      {isPending && isResponding && (
        <div style={{ paddingTop:'10px', borderTop:'1px solid #E2E0D8' }}>
          <div style={{ fontSize:'12px', color:'#72706A', marginBottom:'10px', lineHeight:1.6 }}>
            Your response will be shared with the sponsor.
            If interested, sharing your site's capacity and availability helps sponsors prioritise.
          </div>

          {/* Interest toggle */}
          <div style={{ display:'flex', gap:'8px', marginBottom:'10px' }}>
            <button
              style={{ ...S.btn(respondStatus==='interested'), padding:'7px 14px', fontWeight:500,
                background: respondStatus==='interested' ? '#E1F5EE' : '#fff',
                color: respondStatus==='interested' ? '#0F6E56' : '#1C1B18',
                border: respondStatus==='interested' ? `1.5px solid #0F6E56` : '1px solid #E2E0D8',
              }}
              onClick={() => setRespondStatus('interested')}
            >
              ✅ We're interested
            </button>
            <button
              style={{ ...S.btn(false, respondStatus==='declined'), padding:'7px 14px', fontWeight:500,
                background: respondStatus==='declined' ? '#FEF0EE' : '#fff',
                color: respondStatus==='declined' ? '#A32D2D' : '#1C1B18',
                border: respondStatus==='declined' ? `1.5px solid #A32D2D` : '1px solid #E2E0D8',
              }}
              onClick={() => setRespondStatus('declined')}
            >
              ❌ Not available
            </button>
          </div>

          <textarea
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            rows={3}
            placeholder={
              respondStatus === 'interested'
                ? 'Describe your site\'s capacity and availability. E.g.: "We have 40–50 qualifying patients for T2DM trials. Our PI has bandwidth for Q3 2024 start. Site initiation typically takes 4–6 weeks."'
                : 'Optional: share a reason for declining so the sponsor can plan accordingly…'
            }
            style={{ width:'100%', padding:'9px 12px', border:'1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', fontFamily:'sans-serif', resize:'vertical' as any, outline:'none', boxSizing:'border-box' as any, lineHeight:1.6, marginBottom:'10px' }}
          />

          <div style={{ display:'flex', gap:'8px' }}>
            <button
              style={{ ...S.btn(true), background: respondStatus === 'declined' ? '#A32D2D' : brandColor }}
              disabled={!respondStatus || (respondStatus === 'interested' && !replyText.trim())}
              onClick={() => respondStatus && onSubmitResponse(req.id, respondStatus)}
            >
              Send response
            </button>
            <button style={S.btn()} onClick={() => { onRespond(null); setReplyText('') }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
