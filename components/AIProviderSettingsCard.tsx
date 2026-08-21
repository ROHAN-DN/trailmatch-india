import { useState } from 'react'
import { friendlyErrorHint } from './BatchPanel'

const S = {
  card:  { background:'#fff', border:'1px solid #E2E0D8', borderRadius:'10px', padding:'20px 22px', marginBottom:'14px' } as any,
  label: { fontSize:'10px', fontWeight:'600', letterSpacing:'.06em', textTransform:'uppercase', color:'#72706A', display:'block', marginBottom:'5px' } as any,
  input: { width:'100%', padding:'9px 12px', border:'1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', fontFamily:'sans-serif', outline:'none', boxSizing:'border-box' } as any,
  row:   { display:'grid', gridTemplateColumns:'1fr 1fr', gap:'14px', marginBottom:'14px' } as any,
}

interface Props {
  org: any
  brandColor: string
  onSave: () => void
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic:         'Anthropic (Claude)',
  openai:            'OpenAI (GPT)',
  google:            'Google (Gemini)',
  openai_compatible: 'Other (OpenAI-compatible endpoint)',
}

const PROVIDER_MODEL_HINTS: Record<string, string> = {
  anthropic:         'e.g. claude-sonnet-5 — leave blank to use the platform default',
  openai:            'e.g. gpt-4o — leave blank to use the platform default',
  google:            'e.g. gemini-2.0-flash — leave blank to use the platform default',
  openai_compatible: 'the exact model id your endpoint expects — required',
}

export default function AIProviderSettingsCard({ org, brandColor, onSave }: Props) {
  const originalProvider = org?.llm_provider || ''
  const [provider, setProvider] = useState<string>(originalProvider)
  const [apiKey,   setApiKey]   = useState('')
  const [model,    setModel]    = useState(org?.llm_model || '')
  const [baseUrl,  setBaseUrl]  = useState(org?.llm_base_url || '')
  const [msg,      setMsg]      = useState('')
  const [busy,     setBusy]     = useState(false)
  const [testBusy,   setTestBusy]   = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; hint?: string | null } | null>(null)

  const isConfigured = !!org?.llm_api_key_configured
  // REAL BUG FOUND AND FIXED HERE: a key from one provider can never be
  // reused for a different one, so "leave blank to keep the current
  // key" is only actually true when the selected provider matches what
  // was already configured. Switching providers must require a fresh
  // key — otherwise this form would happily save "now using Google"
  // while silently leaving an OpenAI-shaped key in storage, which the
  // settings page would then misreport as configured right up until a
  // real match attempt fails against it. Enforced server-side too
  // (pages/api/org/index.ts) — this UI check is just the fast path that
  // stops the confusing state from being reachable in the first place.
  const keyBlankIsSafe = isConfigured && provider === originalProvider
  const hasUsableKey = !!apiKey || keyBlankIsSafe
  const canTest = !!provider && hasUsableKey && (provider !== 'openai_compatible' || !!baseUrl)
  const btnStyle = { padding:'9px 20px', background: brandColor, color:'#fff', border:'none', borderRadius:'8px', fontSize:'13px', fontWeight:'500', cursor:'pointer', fontFamily:'sans-serif' } as any
  const btnGhost = { ...btnStyle, background:'transparent', color:'#72706A', border:'1px solid #E2E0D8' } as any

  async function testConnection() {
    setTestBusy(true); setTestResult(null)
    try {
      const r = await fetch('/api/org/test-llm-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          apiKey:  apiKey || undefined,   // omitted, not blank — lets the server reuse the stored key when safe
          model:   model || undefined,
          baseUrl: baseUrl || undefined,
        }),
      })
      const data = await r.json()
      if (!r.ok) {
        // 400/401/403/429 from validation, auth, or rate limiting — not a provider-side failure
        setTestResult({ success: false, message: data.error || `Request failed (${r.status}).` })
      } else if (data.success) {
        setTestResult({ success: true, message: `Connected successfully — ${data.model} responded.` })
      } else {
        setTestResult({ success: false, message: data.error || 'The provider rejected the request.', hint: friendlyErrorHint(data.error || '') })
      }
    } catch (e: any) {
      setTestResult({ success: false, message: e?.message || 'Could not reach the test endpoint.' })
    }
    setTestBusy(false)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(''); setTestResult(null)
    const body: Record<string, any> = { llm_provider: provider || null }
    if (provider) {
      if (apiKey)  body.llm_api_key  = apiKey   // only sent when actually being set/rotated — never sent blank
      body.llm_model    = model || null
      body.llm_base_url = baseUrl || null
    }
    const r = await fetch('/api/org', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setBusy(false)
    const data = await r.json()
    if (!r.ok) return setMsg(data.error || 'Could not save AI provider settings.')
    setApiKey('') // never leave a submitted key sitting in a form field after save
    setMsg(provider ? 'Saved. This org now uses its own configured provider.' : 'Reset — this org will use the platform default provider.')
    onSave()
  }

  return (
    <div style={S.card}>
      <div style={{ fontSize:'13px', fontWeight:'600', marginBottom:'4px' }}>AI provider</div>
      <div style={{ fontSize:'12px', color:'#72706A', marginBottom:'14px', lineHeight:'1.6' }}>
        Which AI provider this org's trial matching uses. {isConfigured
          ? <>Currently using <strong>{PROVIDER_LABELS[org.llm_provider] || org.llm_provider}</strong>{org.llm_model ? <> ({org.llm_model})</> : null}.</>
          : <>Not configured — using the platform default.</>
        } Your API key is encrypted before storage and is never shown again once saved, including to you.
      </div>

      <form onSubmit={save}>
        <div style={S.row}>
          <div>
            <label style={S.label}>Provider</label>
            <select style={S.input} value={provider} onChange={e => { setProvider(e.target.value); setTestResult(null) }}>
              <option value="">Use platform default</option>
              {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          {provider && (
            <div>
              <label style={S.label}>Model</label>
              <input
                style={S.input}
                value={model}
                onChange={e => { setModel(e.target.value); setTestResult(null) }}
                placeholder={PROVIDER_MODEL_HINTS[provider]}
                required={provider === 'openai_compatible'}
              />
            </div>
          )}
        </div>

        {provider && (
          <div style={S.row}>
            <div>
              <label style={S.label}>
                API key {keyBlankIsSafe && <span style={{ fontWeight:'400', textTransform:'none' }}>(leave blank to keep the current one)</span>}
                {provider && provider !== originalProvider && originalProvider && <span style={{ fontWeight:'400', textTransform:'none', color:'#A32D2D' }}> — required: switching from {PROVIDER_LABELS[originalProvider] || originalProvider}, the previous key can't carry over</span>}
              </label>
              <input
                style={S.input}
                type="password"
                value={apiKey}
                onChange={e => { setApiKey(e.target.value); setTestResult(null) }}
                placeholder={keyBlankIsSafe ? '••••••••••••••••' : 'Paste your API key'}
                required={!keyBlankIsSafe}
                autoComplete="off"
              />
            </div>
            {provider === 'openai_compatible' && (
              <div>
                <label style={S.label}>Base URL</label>
                <input
                  style={S.input}
                  value={baseUrl}
                  onChange={e => { setBaseUrl(e.target.value); setTestResult(null) }}
                  placeholder="e.g. https://api.groq.com/openai/v1"
                  required
                />
              </div>
            )}
          </div>
        )}

        <div style={{ display:'flex', gap:'10px', alignItems:'center', flexWrap:'wrap' }}>
          <button type="submit" disabled={busy} style={btnStyle}>{busy ? 'Saving…' : 'Save'}</button>
          {provider && (
            <button type="button" disabled={testBusy || !canTest} style={{ ...btnGhost, opacity: canTest ? 1 : 0.5 }} onClick={testConnection}>
              {testBusy ? 'Testing…' : 'Test connection'}
            </button>
          )}
          {isConfigured && (
            <button
              type="button"
              disabled={busy}
              style={btnGhost}
              onClick={() => { setProvider(''); setApiKey(''); setModel(''); setBaseUrl(''); setTestResult(null) }}
            >
              Reset to platform default
            </button>
          )}
          {msg && <span style={{ fontSize:'12px', color:'#72706A' }}>{msg}</span>}
        </div>

        {testResult && (
          <div style={{
            marginTop: '12px', padding: '10px 12px', borderRadius: '8px', fontSize: '12.5px',
            background: testResult.success ? '#EAF3DE' : '#FEF0EE',
            color:      testResult.success ? '#27500A' : '#A32D2D',
          }}>
            <div style={{ fontWeight: 500 }}>{testResult.success ? '✓ ' : '✕ '}{testResult.message}</div>
            {testResult.hint && <div style={{ marginTop: '4px' }}>{testResult.hint}</div>}
          </div>
        )}
      </form>
    </div>
  )
}
