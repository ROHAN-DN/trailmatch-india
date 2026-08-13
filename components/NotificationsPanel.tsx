/**
 * components/NotificationsPanel.tsx
 * Settings UI for WhatsApp + email notification preferences.
 * Add this as a new tab in dashboard/index.tsx.
 */

import { useState, useEffect } from 'react'

interface Props { brandColor: string }

export default function NotificationsPanel({ brandColor }: Props) {
  const [settings, setSettings] = useState<any>({
    whatsapp_number:          '',
    notify_on_match_complete: true,
    notify_on_new_trials:     true,
    notify_on_batch_complete: true,
    notify_email:             '',
    email_on_match_complete:  true,
    email_on_new_trials:      true,
  })
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [testing,  setTesting]  = useState(false)
  const [msg,      setMsg]      = useState<{ text: string; ok: boolean } | null>(null)

  useEffect(() => {
    fetch('/api/notifications')
      .then(r => r.json())
      .then(d => { if (d.settings) setSettings(d.settings) })
      .finally(() => setLoading(false))
  }, [])

  async function save(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setMsg(null)
    const r = await fetch('/api/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    })
    setSaving(false)
    if (r.ok) setMsg({ text: 'Settings saved successfully.', ok: true })
    else {
      const d = await r.json()
      setMsg({ text: d.error || 'Failed to save.', ok: false })
    }
  }

  async function testWhatsApp() {
    setTesting(true); setMsg(null)
    const r = await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'test_whatsapp' }),
    })
    setTesting(false)
    const d = await r.json()
    if (r.ok) setMsg({ text: '✅ Test message sent! Check your WhatsApp.', ok: true })
    else setMsg({ text: d.error || 'Failed to send test message.', ok: false })
  }

  async function triggerRematch() {
    if (!confirm('Manually trigger a re-match run for all patients now?')) return
    const r = await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'trigger_rematch' }),
    })
    const d = await r.json()
    setMsg({ text: r.ok ? '🔄 Re-match started — check the Jobs tab for progress.' : d.error, ok: r.ok })
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setSettings((s: any) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  const S = {
    card:     { background: '#fff', border: '1px solid #E2E0D8', borderRadius: '10px', padding: '20px 22px', marginBottom: '14px' } as any,
    label:    { fontSize: '10px', fontWeight: '600', letterSpacing: '.06em', textTransform: 'uppercase', color: '#72706A', display: 'block', marginBottom: '5px' } as any,
    input:    { width: '100%', padding: '9px 12px', border: '1px solid #E2E0D8', borderRadius: '8px', fontSize: '13px', fontFamily: 'sans-serif', outline: 'none', boxSizing: 'border-box' } as any,
    row:      { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #F7F6F2' } as any,
    toggle:   { display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontSize: '13px', color: '#1C1B18' } as any,
    btn:      (primary = true, danger = false) => ({
      padding: '9px 18px', fontFamily: 'sans-serif', fontSize: '13px', fontWeight: '500', cursor: 'pointer', borderRadius: '8px',
      background: danger ? '#FEF0EE' : primary ? brandColor : '#fff',
      color:      danger ? '#A32D2D' : primary ? '#fff' : '#1C1B18',
      border:     primary || danger ? 'none' : '1px solid #E2E0D8',
    }) as any,
    section:  { fontSize: '13px', fontWeight: '600', color: '#1C1B18', marginBottom: '12px' } as any,
    hint:     { fontSize: '11.5px', color: '#72706A', marginTop: '5px', lineHeight: '1.5' } as any,
  }

  const Toggle = ({ id, label, sublabel }: { id: string; label: string; sublabel?: string }) => (
    <div style={S.row}>
      <div>
        <div style={{ fontSize: '13px', color: '#1C1B18' }}>{label}</div>
        {sublabel && <div style={{ fontSize: '11.5px', color: '#72706A', marginTop: '2px' }}>{sublabel}</div>}
      </div>
      <label style={{ position: 'relative', display: 'inline-block', width: '42px', height: '24px', cursor: 'pointer', flexShrink: 0 }}>
        <input type="checkbox" checked={!!settings[id]} onChange={set(id)} style={{ opacity: 0, width: 0, height: 0 }}/>
        <span style={{
          position: 'absolute', inset: 0, borderRadius: '12px', transition: '.2s',
          background: settings[id] ? brandColor : '#D1D0C8',
        }}>
          <span style={{
            position: 'absolute', left: settings[id] ? '20px' : '2px', top: '2px',
            width: '20px', height: '20px', borderRadius: '50%', background: '#fff',
            transition: '.2s', boxShadow: '0 1px 3px rgba(0,0,0,.2)',
          }}/>
        </span>
      </label>
    </div>
  )

  if (loading) return <div style={{ padding: '40px', textAlign: 'center', color: '#72706A' }}>Loading…</div>

  return (
    <div>
      <h2 style={{ margin: '0 0 4px', fontSize: '17px', fontWeight: '500' }}>Notifications</h2>
      <p style={{ margin: '0 0 20px', fontSize: '13px', color: '#72706A', lineHeight: '1.5' }}>
        Configure WhatsApp and email alerts for match completions and new trial discoveries.
      </p>

      <form onSubmit={save}>

        {/* ── WHATSAPP ─────────────────────────────────────── */}
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
            <span style={{ fontSize: '22px' }}>💬</span>
            <div style={S.section}>WhatsApp Notifications</div>
            <span style={{ marginLeft: 'auto', background: '#E1F5EE', color: '#0F6E56', fontSize: '10px', fontWeight: '600', padding: '2px 9px', borderRadius: '99px', letterSpacing: '.04em' }}>
              Powered by Gupshup
            </span>
          </div>

          <div style={{ marginBottom: '14px' }}>
            <label style={S.label}>WhatsApp business number</label>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: '13px', color: '#72706A', pointerEvents: 'none' }}>🇮🇳 +91</span>
                <input
                  type="tel"
                  value={settings.whatsapp_number?.replace(/^91/, '') || ''}
                  onChange={e => setSettings((s: any) => ({ ...s, whatsapp_number: e.target.value.replace(/\D/g, '') }))}
                  placeholder="9876543210"
                  style={{ ...S.input, paddingLeft: '72px' }}
                />
              </div>
              <button
                type="button"
                onClick={testWhatsApp}
                disabled={testing || !settings.whatsapp_number}
                style={{ ...S.btn(false), whiteSpace: 'nowrap', opacity: testing || !settings.whatsapp_number ? 0.5 : 1 }}
              >
                {testing ? 'Sending…' : '📱 Test'}
              </button>
            </div>
            <p style={S.hint}>Enter coordinator's WhatsApp number. Must be registered with WhatsApp.</p>
          </div>

          <Toggle id="notify_on_match_complete" label="Match complete (single patient)" sublabel="Notify when a single patient match finishes"/>
          <Toggle id="notify_on_batch_complete" label="Batch complete" sublabel="Notify when a batch job finishes with summary stats"/>
          <Toggle id="notify_on_new_trials" label="New trials found (weekly re-match)" sublabel="Alert when weekly re-match finds trials not seen before"/>

          <div style={{ marginTop: '14px', background: '#F7F6F2', borderRadius: '8px', padding: '12px 14px' }}>
            <div style={{ fontSize: '12px', fontWeight: '600', color: '#1C1B18', marginBottom: '6px' }}>📋 Gupshup setup (3 steps)</div>
            <ol style={{ fontSize: '12px', color: '#72706A', lineHeight: '1.7', paddingLeft: '16px', margin: 0 }}>
              <li>Sign up at <strong>gupshup.io</strong> → Create a WhatsApp app</li>
              <li>Add to <code style={{ background: '#E2E0D8', padding: '1px 5px', borderRadius: '4px', fontSize: '11px' }}>.env.local</code>:
                <div style={{ fontFamily: 'monospace', fontSize: '11px', background: '#1C1B18', color: '#9FE1CB', padding: '8px 10px', borderRadius: '6px', marginTop: '5px' }}>
                  GUPSHUP_API_KEY=your_key<br/>
                  GUPSHUP_SOURCE_NUMBER=91XXXXXXXXXX<br/>
                  GUPSHUP_APP_NAME=TrialMatchIndia
                </div>
              </li>
              <li>Verify your source number in the Gupshup dashboard</li>
            </ol>
          </div>
        </div>

        {/* ── EMAIL ────────────────────────────────────────── */}
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
            <span style={{ fontSize: '22px' }}>📧</span>
            <div style={S.section}>Email Notifications</div>
          </div>

          <div style={{ marginBottom: '14px' }}>
            <label style={S.label}>Notification email address</label>
            <input
              type="email"
              value={settings.notify_email || ''}
              onChange={set('notify_email')}
              placeholder="coordinator@hospital.com"
              style={S.input}
            />
            <p style={S.hint}>PDF reports will be attached. Separate from per-request email overrides.</p>
          </div>

          <Toggle id="email_on_match_complete" label="Match complete" sublabel="Email PDF report when a single patient match finishes"/>
          <Toggle id="email_on_new_trials" label="New trials found (weekly)" sublabel="Email updated report when re-match finds new trials"/>
        </div>

        {/* ── SCHEDULED RE-MATCH ───────────────────────────── */}
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
            <span style={{ fontSize: '22px' }}>🔄</span>
            <div style={S.section}>Weekly Re-Match Schedule</div>
          </div>

          <div style={{ background: '#F7F6F2', borderRadius: '8px', padding: '14px 16px', marginBottom: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '13px', fontWeight: '500', color: '#1C1B18', marginBottom: '4px' }}>Every Sunday at 6:00 AM IST</div>
                <div style={{ fontSize: '12px', color: '#72706A', lineHeight: '1.6' }}>
                  All active patients are re-matched against both ClinicalTrials.gov and CTRI. New trials not seen in the previous match trigger instant WhatsApp + email alerts.
                </div>
              </div>
              <span style={{ background: '#E1F5EE', color: '#0F6E56', fontSize: '11px', fontWeight: '600', padding: '4px 10px', borderRadius: '99px', whiteSpace: 'nowrap' }}>
                Active
              </span>
            </div>
          </div>

          <div style={{ background: '#FEF3E2', borderRadius: '8px', padding: '12px 14px', marginBottom: '14px' }}>
            <div style={{ fontSize: '12px', fontWeight: '600', color: '#BA7517', marginBottom: '5px' }}>⚙️ Supabase setup required</div>
            <div style={{ fontSize: '12px', color: '#72706A', lineHeight: '1.6' }}>
              Run <code style={{ background: '#FEF3E2', border: '1px solid rgba(186,117,23,.2)', padding: '1px 5px', borderRadius: '4px', fontSize: '11px' }}>supabase/notifications_and_cron.sql</code> in your Supabase SQL Editor, then replace <code style={{ fontSize: '11px' }}>YOUR_VERCEL_URL</code> and <code style={{ fontSize: '11px' }}>YOUR_CRON_SECRET</code> with your values.
            </div>
            <div style={{ fontSize: '12px', color: '#72706A', marginTop: '6px' }}>
              On Supabase Free plan? Use <strong>cron-job.org</strong> (free) instead — instructions are in the SQL file.
            </div>
          </div>

          <button type="button" onClick={triggerRematch} style={{ ...S.btn(false), fontSize: '12px', padding: '7px 14px' }}>
            ▶ Trigger manual re-match now
          </button>
        </div>

        {msg && (
          <div style={{ padding: '12px 16px', borderRadius: '8px', marginBottom: '14px', fontSize: '13px', background: msg.ok ? '#EAF3DE' : '#FEF0EE', color: msg.ok ? '#27500A' : '#A32D2D', border: `1px solid ${msg.ok ? 'rgba(39,80,10,.2)' : 'rgba(165,45,45,.2)'}` }}>
            {msg.text}
          </div>
        )}

        <button type="submit" disabled={saving} style={S.btn()}>
          {saving ? 'Saving…' : 'Save notification settings'}
        </button>
      </form>
    </div>
  )
}
