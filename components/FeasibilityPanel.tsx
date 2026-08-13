/**
 * components/FeasibilityPanel.tsx
 *
 * Site feasibility module — answers "how many patients qualify at each site?"
 * Also includes protocol optimisation: tweak criteria, see count change live.
 *
 * Gated to Pro plan. Free/Starter users see an upgrade prompt instead.
 *
 * CLINICAL ACCURACY: the disclaimer banner is always shown above results
 * and is never dismissible. This is a compliance requirement, not a UX choice.
 */

import { useState, useRef, useCallback } from 'react'

interface Props { brandColor: string; userPlan: string }

interface Criterion {
  id:       string
  field:    'diagnosis' | 'age' | 'labs' | 'medications' | 'comorbidities'
  operator: 'contains' | 'not_contains' | 'gte' | 'lte' | 'between'
  value:    string | number
  label:    string
}

const C = {
  teal: '#0F6E56', tealM: '#1D9E75', tealL: '#E1F5EE',
  amber: '#BA7517', amberL: '#FEF3E2',
  red: '#A32D2D', redL: '#FEF0EE',
  gray: '#72706A', border: '#E2E0D8', bg: '#F7F6F2', text: '#1C1B18',
}

function buildLabel(field: Criterion['field'], operator: Criterion['operator'], value: string): string {
  switch (field) {
    case 'diagnosis':    return operator === 'not_contains' ? `Diagnosis excludes "${value}"` : `Diagnosis includes "${value}"`
    case 'labs':          return `Lab record mentions "${value}"`
    case 'medications':  return operator === 'not_contains' ? `Not on medication "${value}"` : `On medication "${value}"`
    case 'comorbidities': return operator === 'not_contains' ? `No comorbidity "${value}"` : `Has comorbidity "${value}"`
    default:              return ''
  }
}

export default function FeasibilityPanel({ brandColor, userPlan }: Props) {
  const [diagnosis,  setDiagnosis]  = useState('')
  const [ageMin,     setAgeMin]     = useState(18)
  const [ageMax,     setAgeMax]     = useState(80)
  const [extraCriteria, setExtraCriteria] = useState<Criterion[]>([])
  const [newField,   setNewField]   = useState<Criterion['field']>('labs')
  const [newOperator, setNewOperator] = useState<Criterion['operator']>('contains')
  const [newValue,   setNewValue]   = useState('')

  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')
  const [results,    setResults]    = useState<any[]>([])
  const [totalQualifying, setTotalQualifying] = useState(0)
  const [expandedSite, setExpandedSite] = useState<string | null>(null)

  const [tweakMode,  setTweakMode]  = useState(false)
  const [originalResults, setOriginalResults] = useState<any[] | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hasGate = userPlan !== 'pro' && userPlan !== 'enterprise'

  function buildCriteria(): { field: string; operator: string; value: any; label: string }[] {
    const criteria: any[] = []
    if (diagnosis.trim()) {
      criteria.push({ field: 'diagnosis', operator: 'contains', value: diagnosis.trim(), label: `Diagnosis includes "${diagnosis.trim()}"` })
    }
    criteria.push({ field: 'age', operator: 'between', value: [ageMin, ageMax], label: `Age ${ageMin}–${ageMax} years` })
    for (const c of extraCriteria) {
      criteria.push({ field: c.field, operator: c.operator, value: c.value, label: c.label })
    }
    return criteria
  }

  async function runFeasibility(isTweak = false) {
    setLoading(true); setError('')
    try {
      const r = await fetch('/api/feasibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ criteria: buildCriteria(), name: isTweak ? 'Optimised scenario' : undefined }),
      })
      const d = await r.json()
      if (!r.ok) {
        setError(d.error || 'Feasibility query failed')
        setLoading(false)
        return
      }
      setResults(d.results || [])
      setTotalQualifying(d.total_qualifying || 0)
      if (!isTweak) setOriginalResults(d.results || [])
    } catch (e: any) {
      setError(e.message)
    }
    setLoading(false)
  }

  const debouncedRun = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runFeasibility(true), 300)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagnosis, ageMin, ageMax, extraCriteria])

  function addCriterion() {
    if (!newValue.trim()) return
    const c: Criterion = {
      id: `c${Date.now()}`,
      field: newField,
      operator: newOperator,
      value: newValue.trim(),
      label: buildLabel(newField, newOperator, newValue.trim()),
    }
    setExtraCriteria(prev => [...prev, c])
    setNewValue('')
    if (tweakMode) setTimeout(debouncedRun, 0)
  }

  function removeCriterion(id: string) {
    setExtraCriteria(prev => prev.filter(c => c.id !== id))
    if (tweakMode) setTimeout(debouncedRun, 0)
  }

  function deltaFor(siteOrgId: string): number | null {
    if (!originalResults) return null
    const orig = originalResults.find(r => r.org_id === siteOrgId)
    const curr = results.find(r => r.org_id === siteOrgId)
    if (!orig || !curr) return curr ? curr.total_count : null
    return curr.total_count - orig.total_count
  }

  const S = {
    card:  { background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', padding: '18px 20px', marginBottom: '14px' } as any,
    label: { fontSize: '10px', fontWeight: '600', letterSpacing: '.06em', textTransform: 'uppercase', color: C.gray, display: 'block', marginBottom: '5px' } as any,
    input: { width: '100%', padding: '9px 12px', border: `1px solid ${C.border}`, borderRadius: '8px', fontSize: '13px', fontFamily: 'sans-serif', outline: 'none', boxSizing: 'border-box' } as any,
    btn:   (primary = true, disabled = false) => ({ padding: '10px 20px', background: disabled ? C.border : primary ? brandColor : '#fff', color: disabled ? C.gray : primary ? '#fff' : C.text, border: primary ? 'none' : `1px solid ${C.border}`, borderRadius: '8px', fontSize: '13px', fontWeight: '500', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'sans-serif' }) as any,
  }

  if (hasGate) {
    return (
      <div>
        <h2 style={{ margin: '0 0 4px', fontSize: '17px', fontWeight: '500', color: C.text }}>Site Feasibility</h2>
        <p style={{ margin: '0 0 20px', fontSize: '13px', color: C.gray }}>Find out how many patients qualify for a protocol at each of your sites.</p>

        <div style={{ background: '#fff', border: `1.5px solid ${brandColor}`, borderRadius: '12px', padding: '28px 24px', textAlign: 'center', maxWidth: '480px', margin: '40px auto' }}>
          <div style={{ fontSize: '36px', marginBottom: '12px' }}>🎯</div>
          <h3 style={{ margin: '0 0 8px', fontSize: '16px', fontWeight: '500', color: C.text }}>Available on the Pro plan</h3>
          <p style={{ fontSize: '13px', color: C.gray, lineHeight: '1.6', marginBottom: '4px' }}>
            Site feasibility tells you within seconds how many patients at each site match a protocol's
            criteria — the same question sponsors pay enterprise tools $50,000/year to answer.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px', flexWrap: 'wrap', gap: '10px' }}>
        <h2 style={{ margin: 0, fontSize: '17px', fontWeight: '500', color: C.text }}>Site Feasibility</h2>
        {results.length > 0 && (
          <button
            onClick={() => setTweakMode(t => !t)}
            style={{ padding: '7px 14px', background: tweakMode ? brandColor : '#fff', color: tweakMode ? '#fff' : C.text, border: tweakMode ? 'none' : `1px solid ${C.border}`, borderRadius: '8px', fontSize: '12px', fontWeight: '500', cursor: 'pointer', fontFamily: 'sans-serif' }}
          >
            {tweakMode ? '✓ Optimising protocol' : '⚙ Optimise protocol'}
          </button>
        )}
      </div>
      <p style={{ margin: '0 0 18px', fontSize: '13px', color: C.gray }}>
        Find how many patients match a protocol's eligibility criteria at each of your sites.
      </p>

      <div style={S.card}>
        <div style={{ fontSize: '13px', fontWeight: '600', marginBottom: '14px' }}>Eligibility criteria</div>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '12px', marginBottom: '14px' }}>
          <div>
            <label style={S.label}>Diagnosis (recommended)</label>
            <input style={S.input} value={diagnosis} onChange={e => { setDiagnosis(e.target.value); if (tweakMode) debouncedRun() }} placeholder="e.g. Type 2 Diabetes Mellitus"/>
          </div>
          <div>
            <label style={S.label}>Age min</label>
            <input style={S.input} type="number" value={ageMin} onChange={e => { setAgeMin(+e.target.value); if (tweakMode) debouncedRun() }}/>
          </div>
          <div>
            <label style={S.label}>Age max</label>
            <input style={S.input} type="number" value={ageMax} onChange={e => { setAgeMax(+e.target.value); if (tweakMode) debouncedRun() }}/>
          </div>
        </div>

        {extraCriteria.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
            {extraCriteria.map(c => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: C.bg, borderRadius: '7px', padding: '7px 12px' }}>
                <span style={{ fontSize: '12.5px', color: C.text }}>{c.label}</span>
                <button onClick={() => removeCriterion(c.id)} style={{ background: 'none', border: 'none', color: C.red, cursor: 'pointer', fontSize: '14px', padding: '0 4px' }}>×</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '140px 140px 1fr auto', gap: '8px', alignItems: 'end' }}>
          <div>
            <label style={S.label}>Field</label>
            <select style={S.input} value={newField} onChange={e => setNewField(e.target.value as any)}>
              <option value="labs">Lab value</option>
              <option value="medications">Medication</option>
              <option value="comorbidities">Co-morbidity</option>
              <option value="diagnosis">Diagnosis</option>
            </select>
          </div>
          <div>
            <label style={S.label}>Condition</label>
            <select style={S.input} value={newOperator} onChange={e => setNewOperator(e.target.value as any)}>
              <option value="contains">Includes</option>
              <option value="not_contains">Excludes</option>
            </select>
          </div>
          <div>
            <label style={S.label}>Value</label>
            <input style={S.input} value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="e.g. HbA1c, Metformin, Hypertension" onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCriterion() } }}/>
          </div>
          <button onClick={addCriterion} style={S.btn(false)}>+ Add</button>
        </div>

        {error && (
          <div style={{ background: C.redL, borderRadius: '8px', padding: '10px 14px', color: C.red, fontSize: '13px', marginTop: '14px' }}>{error}</div>
        )}

        {!tweakMode && (
          <button onClick={() => runFeasibility(false)} disabled={loading} style={{ ...S.btn(true, loading), width: '100%', marginTop: '16px' }}>
            {loading ? 'Running…' : '🎯 Run feasibility'}
          </button>
        )}
      </div>

      {results.length > 0 && (
        <>
          <div style={{ background: C.amberL, border: `1.5px solid ${C.amber}55`, borderRadius: '10px', padding: '12px 16px', marginBottom: '14px' }}>
            <div style={{ fontSize: '12px', fontWeight: '600', color: C.amber, marginBottom: '3px' }}>⚠ Important — read before using these results</div>
            <div style={{ fontSize: '12px', color: '#5C3A08', lineHeight: '1.6' }}>{results[0]?.disclaimer}</div>
          </div>

          <div style={{ display: 'flex', gap: '12px', marginBottom: '14px' }}>
            <div style={{ flex: 1, background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', padding: '14px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: '24px', fontWeight: '500', color: brandColor }}>{results.length}</div>
              <div style={{ fontSize: '11px', color: C.gray }}>Sites with qualifying patients</div>
            </div>
            <div style={{ flex: 1, background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', padding: '14px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: '24px', fontWeight: '500', color: brandColor }}>{totalQualifying}</div>
              <div style={{ fontSize: '11px', color: C.gray }}>Total qualifying patients</div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {results.map(site => {
              const delta = tweakMode ? deltaFor(site.org_id) : null
              return (
                <div key={site.org_id} style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', overflow: 'hidden' }}>
                  <div
                    onClick={() => setExpandedSite(p => p === site.org_id ? null : site.org_id)}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', cursor: 'pointer' }}
                  >
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: '500', color: C.text }}>{site.org_name}</div>
                      <div style={{ fontSize: '12px', color: C.gray, marginTop: '2px' }}>{site.city} · {site.total_patients_at_site} total active patients</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      {delta !== null && delta !== 0 && (
                        <span style={{ fontSize: '12px', fontWeight: '600', color: delta > 0 ? C.tealM : C.red }}>
                          {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}
                        </span>
                      )}
                      <span style={{
                        fontSize: '11px', fontWeight: '600', padding: '2px 9px', borderRadius: '99px',
                        background: site.confidence === 'high' ? '#EAF3DE' : site.confidence === 'medium' ? C.amberL : C.bg,
                        color:      site.confidence === 'high' ? '#27500A' : site.confidence === 'medium' ? C.amber  : C.gray,
                      }}>
                        {site.confidence} confidence
                      </span>
                      <div style={{ fontSize: '22px', fontWeight: '500', color: brandColor, minWidth: '40px', textAlign: 'right' }}>{site.total_count}</div>
                    </div>
                  </div>

                  {expandedSite === site.org_id && (
                    <div style={{ padding: '0 16px 14px', borderTop: `1px solid ${C.border}` }}>
                      <div style={{ fontSize: '10px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '.06em', color: C.gray, margin: '12px 0 8px' }}>Step-by-step breakdown</div>
                      {site.breakdown.map((b: any, i: number) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: '12.5px', borderBottom: i < site.breakdown.length - 1 ? `1px solid ${C.bg}` : 'none' }}>
                          <span style={{ color: C.text }}>{b.criterion}</span>
                          <span style={{ color: brandColor, fontWeight: '600' }}>{b.count}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
