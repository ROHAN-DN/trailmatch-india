import { useState } from 'react'
import MFASettingsCard from './MFASettingsCard'
import AIProviderSettingsCard from './AIProviderSettingsCard'

interface SettingsProps { org: any; usage: any; onSave: () => void; brandColor: string }

export default function SettingsPanel({ org, usage, onSave, brandColor }: SettingsProps) {
  const [name,      setName]      = useState(org?.name  || '')
  const [color,     setColor]     = useState(org?.brand_color || '#0F6E56')
  const [type,      setType]      = useState(org?.type  || 'other')
  const [city,      setCity]      = useState(org?.city  || '')
  const [retention, setRetention] = useState(org?.data_retention_months || 24)
  const [msg,       setMsg]       = useState('')

  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg('')
    const r = await fetch('/api/org', { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, brand_color: color, type, city, data_retention_months: retention }) })
    if (r.ok) { setMsg('Settings saved.'); onSave() }
    else setMsg('Failed to save.')
  }

  const S = {
    card:  { background:'#fff', border:'1px solid #E2E0D8', borderRadius:'10px', padding:'20px 22px', marginBottom:'14px' } as any,
    label: { fontSize:'10px', fontWeight:'600', letterSpacing:'.06em', textTransform:'uppercase', color:'#72706A', display:'block', marginBottom:'5px' } as any,
    input: { width:'100%', padding:'9px 12px', border:'1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', fontFamily:'sans-serif', outline:'none', boxSizing:'border-box' } as any,
    btn:   { padding:'9px 20px', background: brandColor, color:'#fff', border:'none', borderRadius:'8px', fontSize:'13px', fontWeight:'500', cursor:'pointer', fontFamily:'sans-serif' } as any,
    row:   { display:'grid', gridTemplateColumns:'1fr 1fr', gap:'14px', marginBottom:'14px' } as any,
  }

  return (
    <div>
      <h2 style={{ margin:'0 0 18px', fontSize:'17px', fontWeight:'500' }}>Settings</h2>

      <form onSubmit={save}>
        <div style={S.card}>
          <div style={{ fontSize:'13px', fontWeight:'600', marginBottom:'14px' }}>Organisation</div>
          <div style={S.row}>
            <div><label style={S.label}>Workspace name</label><input style={S.input} value={name} onChange={e=>setName(e.target.value)} required/></div>
            <div><label style={S.label}>Organisation type</label>
              <select style={S.input} value={type} onChange={e=>setType(e.target.value)}>
                {['hospital','cro','pharma','research_center','other'].map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1).replace('_',' ')}</option>)}
              </select>
            </div>
          </div>
          <div style={S.row}>
            <div><label style={S.label}>City</label><input style={S.input} value={city} onChange={e=>setCity(e.target.value)} placeholder="Bengaluru"/></div>
            <div>
              <label style={S.label}>Brand colour (for reports & emails)</label>
              <div style={{ display:'flex', gap:'10px', alignItems:'center' }}>
                <input type="color" value={color} onChange={e=>setColor(e.target.value)} style={{ width:'42px', height:'38px', border:'1px solid #E2E0D8', borderRadius:'7px', padding:'2px', cursor:'pointer' }}/>
                <input style={{ ...S.input, flex:1 }} value={color} onChange={e=>setColor(e.target.value)} pattern="^#[0-9A-Fa-f]{6}$"/>
              </div>
            </div>
          </div>
        </div>

        <div style={S.card}>
          <div style={{ fontSize:'13px', fontWeight:'600', marginBottom:'12px' }}>Usage</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'12px' }}>
            {[['Patients', `${usage?.patients||0} / ${org?.max_patients||50}`],['Team members',`${usage?.users||0} / ${org?.max_users||5}`],['Plan', org?.plan?.toUpperCase()||'TRIAL']].map(([l,v])=>(
              <div key={l} style={{ background:'#F7F6F2', borderRadius:'8px', padding:'12px 14px' }}>
                <div style={{ fontSize:'10px', color:'#72706A', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:'4px' }}>{l}</div>
                <div style={{ fontSize:'16px', fontWeight:'500', color:'#1C1B18' }}>{v}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={S.card}>
          <div style={{ fontSize:'13px', fontWeight:'600', marginBottom:'4px' }}>Data retention</div>
          <div style={{ fontSize:'12px', color:'#72706A', marginBottom:'14px', lineHeight:'1.6' }}>
            Patient records inactive beyond this period are automatically archived. Required under <strong>DPDP Act 2023</strong> (storage minimisation).
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:'12px' }}>
            <div style={{ flex:1 }}>
              <label style={S.label}>Archive inactive patients after</label>
              <select style={S.input} value={retention} onChange={e => setRetention(+e.target.value)}>
                {[6,12,24,36,60].map(m => <option key={m} value={m}>{m} months{m===24?' (recommended)':m===60?' (maximum)':''}</option>)}
              </select>
            </div>
            <div style={{ background:'#F7F6F2', borderRadius:'8px', padding:'10px 14px', flexShrink:0, textAlign:'center' as any }}>
              <div style={{ fontSize:'10px', color:'#72706A', marginBottom:'2px' }}>Current</div>
              <div style={{ fontSize:'16px', fontWeight:'500', color:'#1C1B18' }}>{retention}mo</div>
            </div>
          </div>
          <p style={{ fontSize:'11px', color:'#72706A', marginTop:'8px', lineHeight:'1.5' }}>
            Archived records are hidden but not deleted. Your DPO can permanently delete them on request.
          </p>
        </div>

        {msg && <p style={{ fontSize:'13px', color: msg.includes('saved') ? '#0F6E56' : '#A32D2D', marginBottom:'12px' }}>{msg}</p>}
        <button type="submit" style={S.btn}>Save settings</button>
      </form>

      <MFASettingsCard brandColor={brandColor} />
      <AIProviderSettingsCard org={org} brandColor={brandColor} onSave={onSave} />
    </div>
  )
}
