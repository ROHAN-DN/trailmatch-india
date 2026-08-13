import { useState, useEffect } from 'react'

interface TeamProps { brandColor: string; userRole: string }

export default function TeamPanel({ brandColor, userRole }: TeamProps) {
  const [members, setMembers] = useState<any[]>([])
  const [invites, setInvites] = useState<any[]>([])
  const [email,   setEmail]   = useState('')
  const [role,    setRole]    = useState('member')
  const [loading, setLoading] = useState(false)
  const [msg,     setMsg]     = useState('')

  async function load() {
    const r = await fetch('/api/team')
    const d = await r.json()
    setMembers(d.members || [])
    setInvites(d.invites  || [])
  }

  useEffect(() => { load() }, [])

  async function invite(e: React.FormEvent) {
    e.preventDefault(); setLoading(true); setMsg('')
    const r = await fetch('/api/team', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, role }) })
    setLoading(false)
    if (r.ok) { setEmail(''); setMsg('Invitation sent!'); load() }
    else { const d = await r.json(); setMsg(d.error || 'Failed to invite') }
  }

  const S = {
    card:  { background:'#fff', border:'1px solid #E2E0D8', borderRadius:'10px', padding:'18px 20px', marginBottom:'14px' } as any,
    label: { fontSize:'10px', fontWeight:'600', letterSpacing:'.06em', textTransform:'uppercase', color:'#72706A', display:'block', marginBottom:'5px' } as any,
    input: { width:'100%', padding:'9px 12px', border:'1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', fontFamily:'sans-serif', outline:'none', boxSizing:'border-box' } as any,
    btn:   (p=true) => ({ padding:'9px 18px', background: p ? brandColor : '#fff', color: p ? '#fff' : '#1C1B18', border: p ? 'none' : '1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', fontWeight:'500', cursor:'pointer', fontFamily:'sans-serif' }) as any,
    badge: (role: string) => ({ background: role==='owner'?'#EAF3DE':role==='admin'?'#E6F1FB':'#F7F6F2', color: role==='owner'?'#27500A':role==='admin'?'#1A56CC':'#72706A', fontSize:'10px', fontWeight:'600', padding:'2px 8px', borderRadius:'99px', letterSpacing:'.04em', textTransform:'uppercase' }) as any,
  }

  return (
    <div>
      <h2 style={{ margin:'0 0 18px', fontSize:'17px', fontWeight:'500' }}>Team</h2>

      {/* Members */}
      <div style={S.card}>
        <div style={{ fontSize:'13px', fontWeight:'600', marginBottom:'12px' }}>Members ({members.length})</div>
        {members.map(m => (
          <div key={m.id} style={{ display:'flex', alignItems:'center', gap:'12px', padding:'8px 0', borderBottom:'1px solid #F7F6F2' }}>
            <div style={{ width:'34px', height:'34px', background: brandColor, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:'13px', fontWeight:'500', flexShrink:0 }}>
              {(m.name||m.email).charAt(0).toUpperCase()}
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:'13px', fontWeight:'500', color:'#1C1B18' }}>{m.name || m.email}</div>
              <div style={{ fontSize:'12px', color:'#72706A' }}>{m.email}</div>
            </div>
            <span style={S.badge(m.role)}>{m.role}</span>
            <div style={{ fontSize:'11px', color:'#B4B2A9' }}>
              {m.last_login ? `Last login ${new Date(m.last_login).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}` : 'Never logged in'}
            </div>
            {['owner','admin'].includes(userRole) && m.role !== 'owner' && (
              <button style={{ ...S.btn(false), padding:'5px 10px', fontSize:'12px', color:'#A32D2D', borderColor:'#FCEBEB' }}
                onClick={async () => { if(confirm('Remove this member?')) { await fetch('/api/team', { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ user_id: m.id }) }); load() }}}>
                Remove
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Pending invites */}
      {invites.length > 0 && (
        <div style={S.card}>
          <div style={{ fontSize:'13px', fontWeight:'600', marginBottom:'12px' }}>Pending invitations</div>
          {invites.map(inv => (
            <div key={inv.id} style={{ display:'flex', alignItems:'center', gap:'12px', padding:'8px 0', borderBottom:'1px solid #F7F6F2' }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:'13px', color:'#1C1B18' }}>{inv.email}</div>
                <div style={{ fontSize:'11px', color:'#B4B2A9' }}>Expires {new Date(inv.expires_at).toLocaleDateString('en-IN')}</div>
              </div>
              <span style={S.badge(inv.role)}>{inv.role}</span>
              <button style={{ ...S.btn(false), padding:'5px 10px', fontSize:'12px' }}
                onClick={async () => { await fetch('/api/team', { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ invite_id: inv.id }) }); load() }}>
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Invite form */}
      {['owner','admin'].includes(userRole) && (
        <div style={S.card}>
          <div style={{ fontSize:'13px', fontWeight:'600', marginBottom:'14px' }}>Invite a team member</div>
          <form onSubmit={invite} style={{ display:'grid', gridTemplateColumns:'1fr 140px 100px', gap:'10px', alignItems:'end' }}>
            <div>
              <label style={S.label}>Email address</label>
              <input style={S.input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="colleague@hospital.com" required/>
            </div>
            <div>
              <label style={S.label}>Role</label>
              <select style={S.input} value={role} onChange={e => setRole(e.target.value)}>
                <option value="viewer">Viewer</option>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button type="submit" disabled={loading} style={S.btn()}>
              {loading ? 'Sending…' : 'Invite'}
            </button>
          </form>
          {msg && <p style={{ margin:'10px 0 0', fontSize:'12px', color: msg.includes('!') ? '#0F6E56' : '#A32D2D' }}>{msg}</p>}
        </div>
      )}
    </div>
  )
}
