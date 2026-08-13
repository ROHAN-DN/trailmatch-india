/**
 * components/FHIRImportPanel.tsx
 * FHIR R4 patient import UI.
 * Supports drag-drop JSON, live field-mapping preview, validation summary,
 * and one-click import into TrialMatch patient records.
 */

import { useState, useRef } from 'react'

interface Props {
  brandColor: string
  onImported: (count: number) => void
}

interface ParsedPreview {
  index:        number
  patient_code: string
  age:          number
  sex:          string
  location:     string
  diagnosis:    string
  medications:  string
  labs:         string
  comorbidities: string
  allergies:    string
  biomarkers:   string
  valid:        boolean
  errors:       string[]
}

const C = {
  teal: '#0F6E56', tealM: '#1D9E75', tealL: '#E1F5EE',
  amber: '#BA7517', amberL: '#FEF3E2',
  red: '#A32D2D', redL: '#FEF0EE',
  gray: '#72706A', border: '#E2E0D8', bg: '#F7F6F2', text: '#1C1B18',
}

// ── Client-side FHIR preview parser (mirrors lib/fhir.ts logic) ──
function previewFHIR(raw: any): ParsedPreview[] {
  let resources: any[] = []
  if (raw.resourceType === 'Bundle' && Array.isArray(raw.entry)) {
    resources = raw.entry.map((e: any) => e.resource).filter(Boolean)
  } else if (Array.isArray(raw)) {
    resources = raw
  } else if (raw.resourceType) {
    resources = [raw]
  }

  const patients = resources.filter(r => r.resourceType === 'Patient')
  if (!patients.length) throw new Error('No Patient resources found in this file.')

  return patients.slice(0, 20).map((pt: any, i: number) => {
    const ptId   = pt.id
    const forPt  = (r: any) => {
      const ref = r.subject?.reference || r.patient?.reference || ''
      return !ptId || ref.includes(ptId) || ref === ''
    }

    const conditions = resources.filter(r => r.resourceType === 'Condition' && forPt(r))
    const meds       = resources.filter(r => (r.resourceType === 'MedicationRequest' || r.resourceType === 'MedicationStatement') && forPt(r))
    const obs        = resources.filter(r => r.resourceType === 'Observation' && forPt(r))
    const allergyRes = resources.filter(r => r.resourceType === 'AllergyIntolerance' && forPt(r))

    const getText = (cc: any) => cc?.text || cc?.coding?.[0]?.display || cc?.coding?.[0]?.code || ''

    const age = pt.birthDate ? (() => {
      const d = new Date(pt.birthDate); const t = new Date()
      let a = t.getFullYear() - d.getFullYear()
      if (t.getMonth() < d.getMonth() || (t.getMonth() === d.getMonth() && t.getDate() < d.getDate())) a--
      return Math.max(0, a)
    })() : 0

    const sex = pt.gender === 'male' ? 'Male' : pt.gender === 'female' ? 'Female' : 'Other'
    const addr = pt.address?.[0]
    const location = addr ? [addr.city, addr.state, addr.country].filter(Boolean).join(', ') || 'India' : 'India'
    const dx  = getText(conditions[0]?.code) || 'Unknown'
    const medNames = meds.filter(m => m.status !== 'stopped' && m.status !== 'cancelled').map(m => getText(m.medicationCodeableConcept)).filter(Boolean).slice(0, 6).join(', ')
    const labVals = obs.map(o => {
      const n = getText(o.code); const v = o.valueQuantity ? `${o.valueQuantity.value} ${o.valueQuantity.unit || ''}` : o.valueString || ''
      return n && v ? `${n}: ${v.trim()}` : ''
    }).filter(Boolean).slice(0, 6).join(', ')
    const comorbids = conditions.slice(1).map(c => getText(c.code)).filter(Boolean).slice(0, 4).join(', ')
    const allergyNames = allergyRes.map(a => getText(a.code)).filter(Boolean).slice(0, 4).join(', ')
    const id = (pt.id || Date.now().toString()).replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase()

    const errors: string[] = []
    if (!age) errors.push('Missing birthDate')
    if (!dx || dx === 'Unknown') errors.push('No active Condition found')

    return {
      index: i, patient_code: `FHIR-${id}`, age, sex, location,
      diagnosis: dx, medications: medNames, labs: labVals,
      comorbidities: comorbids, allergies: allergyNames, biomarkers: '',
      valid: errors.length === 0, errors,
    }
  })
}

export default function FHIRImportPanel({ brandColor, onImported }: Props) {
  const [step,     setStep]     = useState<'upload' | 'preview' | 'importing' | 'done'>('upload')
  const [dragging, setDragging] = useState(false)
  const [preview,  setPreview]  = useState<ParsedPreview[]>([])
  const [rawFHIR,  setRawFHIR]  = useState<any>(null)
  const [parseErr, setParseErr] = useState('')
  const [result,   setResult]   = useState<{ imported: number; skipped: number; warnings?: any[] } | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [consentConfirmed, setConsentConfirmed] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const S = {
    card:  { background: '#fff', border: `1px solid ${C.border}`, borderRadius: '10px', padding: '20px 22px', marginBottom: '14px' } as any,
    label: { fontSize: '10px', fontWeight: '600', letterSpacing: '.06em', textTransform: 'uppercase', color: C.gray, display: 'block', marginBottom: '5px' } as any,
    btn:   (primary = true, disabled = false) => ({ padding: '9px 18px', background: disabled ? C.border : primary ? brandColor : '#fff', color: disabled ? C.gray : primary ? '#fff' : C.text, border: primary ? 'none' : `1px solid ${C.border}`, borderRadius: '8px', fontSize: '13px', fontWeight: '500', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'sans-serif', transition: 'all .15s', opacity: disabled ? .6 : 1 }) as any,
  }

  function handleFile(file: File) {
    setParseErr('')
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const json = JSON.parse(e.target?.result as string)
        const previews = previewFHIR(json)
        setRawFHIR(json)
        setPreview(previews)
        setSelected(new Set(previews.filter(p => p.valid).map(p => p.index)))
        setStep('preview')
      } catch (err: any) {
        setParseErr(err.message.includes('JSON') ? 'File is not valid JSON. Please upload a FHIR R4 JSON bundle.' : err.message)
      }
    }
    reader.readAsText(file)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function toggleSelect(idx: number) {
    setSelected(prev => { const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n })
  }

  async function doImport() {
    if (!selected.size || !rawFHIR || !consentConfirmed) return
    setStep('importing')

    // Build a filtered bundle with only selected patients
    let filteredBundle: any = rawFHIR
    if (rawFHIR.resourceType === 'Bundle' && Array.isArray(rawFHIR.entry)) {
      const allResources = rawFHIR.entry.map((e: any) => e.resource).filter(Boolean)
      const selectedPatients = allResources
        .filter((r: any) => r.resourceType === 'Patient')
        .filter((_: any, i: number) => selected.has(i))
      const patientIds = new Set(selectedPatients.map((p: any) => p.id).filter(Boolean))
      const relatedResources = allResources.filter((r: any) => {
        if (r.resourceType === 'Patient') return false
        const ref = r.subject?.reference || r.patient?.reference || ''
        return patientIds.size === 0 || Array.from(patientIds).some(id => ref.includes(id as string))
      })
      filteredBundle = {
        resourceType: 'Bundle', type: 'collection',
        entry: [...selectedPatients, ...relatedResources].map(r => ({ resource: r })),
      }
    }

    const r = await fetch('/api/patients/fhir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fhir_bundle: filteredBundle, consent_confirmed: true }),
    })
    const d = await r.json()
    if (r.ok) {
      setResult(d)
      setStep('done')
      onImported(d.imported)
    } else {
      setParseErr(d.error || 'Import failed')
      setStep('preview')
    }
  }

  // ── STEP: UPLOAD ────────────────────────────────────────────
  if (step === 'upload') return (
    <div>
      <h3 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: '500', color: C.text }}>Import from FHIR</h3>
      <p style={{ margin: '0 0 18px', fontSize: '13px', color: C.gray, lineHeight: '1.5' }}>
        Upload a FHIR R4 JSON bundle to auto-populate patient records. Supports Epic, Cerner, Meditech, and ABDM exports.
      </p>

      {/* Drag-drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        style={{ border: `1.5px dashed ${dragging ? brandColor : C.border}`, borderRadius: '10px', padding: '40px 24px', textAlign: 'center', cursor: 'pointer', background: dragging ? C.tealL + '44' : C.bg, transition: 'all .15s', marginBottom: '14px' }}
      >
        <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}/>
        <div style={{ fontSize: '32px', marginBottom: '10px' }}>🏥</div>
        <div style={{ fontSize: '15px', fontWeight: '500', color: C.text, marginBottom: '6px' }}>
          Drop your FHIR bundle here
        </div>
        <div style={{ fontSize: '13px', color: C.gray, lineHeight: '1.5' }}>
          or <span style={{ color: brandColor, textDecoration: 'underline' }}>browse for a file</span>
          <br/>Accepts FHIR R4 JSON · up to 4 MB · up to 20 patients
        </div>
      </div>

      {parseErr && (
        <div style={{ background: C.redL, border: `1px solid rgba(165,45,45,.2)`, borderRadius: '8px', padding: '12px 14px', color: C.red, fontSize: '13px', marginBottom: '14px' }}>
          <strong>Parse error:</strong> {parseErr}
        </div>
      )}

      {/* Supported systems */}
      <div style={S.card}>
        <div style={{ ...S.label, marginBottom: '10px' }}>Supported EHR systems</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' }}>
          {[
            { name: 'Epic MyChart', flag: '✅', note: 'Health records export' },
            { name: 'Cerner PowerChart', flag: '✅', note: 'Patient summary' },
            { name: 'ABDM FHIR API', flag: '✅', note: 'Ayushman Bharat' },
            { name: 'Meditech', flag: '✅', note: 'FHIR R4 export' },
            { name: 'Practo / Qure.ai', flag: '✅', note: 'JSON export' },
            { name: 'Custom FHIR server', flag: '✅', note: 'Any R4 Bundle' },
          ].map(s => (
            <div key={s.name} style={{ background: C.bg, borderRadius: '7px', padding: '10px 12px' }}>
              <div style={{ fontSize: '12px', fontWeight: '500', color: C.text }}>{s.flag} {s.name}</div>
              <div style={{ fontSize: '11px', color: C.gray, marginTop: '2px' }}>{s.note}</div>
            </div>
          ))}
        </div>
      </div>

      {/* FHIR resource types parsed */}
      <div style={S.card}>
        <div style={{ ...S.label, marginBottom: '10px' }}>FHIR resources parsed</div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {[
            ['Patient', 'Demographics, DOB, gender, address'],
            ['Condition', 'Diagnosis, co-morbidities, severity, ICD-10'],
            ['MedicationRequest', 'Current medications + dosage'],
            ['Observation', 'Lab values (LOINC codes), biomarkers'],
            ['AllergyIntolerance', 'Drug and food allergies'],
            ['Procedure', 'Prior treatments + dates'],
          ].map(([name, desc]) => (
            <div key={name} title={desc} style={{ background: C.tealL, color: C.teal, fontSize: '11px', fontWeight: '600', padding: '4px 10px', borderRadius: '6px', cursor: 'default' }}>
              {name}
            </div>
          ))}
        </div>
        <p style={{ margin: '10px 0 0', fontSize: '11.5px', color: C.gray, lineHeight: '1.6' }}>
          FHIR data is parsed client-side for preview, then sent securely to your workspace. No data leaves your account.
        </p>
      </div>
    </div>
  )

  // ── STEP: PREVIEW ───────────────────────────────────────────
  if (step === 'preview') {
    const validCount   = preview.filter(p => p.valid).length
    const invalidCount = preview.filter(p => !p.valid).length

    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '500', color: C.text }}>
            Preview — {preview.length} patient{preview.length !== 1 ? 's' : ''} found
          </h3>
          <span style={{ background: C.tealL, color: C.teal, fontSize: '11px', fontWeight: '600', padding: '3px 9px', borderRadius: '99px' }}>{validCount} valid</span>
          {invalidCount > 0 && <span style={{ background: C.amberL, color: C.amber, fontSize: '11px', fontWeight: '600', padding: '3px 9px', borderRadius: '99px' }}>{invalidCount} with warnings</span>}
        </div>

        {parseErr && (
          <div style={{ background: C.redL, border: `1px solid rgba(165,45,45,.2)`, borderRadius: '8px', padding: '12px 14px', color: C.red, fontSize: '13px', marginBottom: '14px' }}>
            {parseErr}
          </div>
        )}

        {/* Patient cards */}
        <div style={{ maxHeight: '480px', overflowY: 'auto', marginBottom: '14px' }}>
          {preview.map(p => (
            <div key={p.index} style={{ background: '#fff', border: `1px solid ${p.valid ? C.border : C.amber}`, borderRadius: '10px', padding: '14px 16px', marginBottom: '10px', opacity: selected.has(p.index) ? 1 : 0.55, transition: 'opacity .15s' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                <input
                  type="checkbox"
                  checked={selected.has(p.index)}
                  onChange={() => toggleSelect(p.index)}
                  disabled={!p.valid}
                  style={{ marginTop: '3px', flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '12px', fontWeight: '600', color: C.text }}>{p.patient_code}</span>
                    <span style={{ fontSize: '12px', color: C.gray }}>{p.age}y · {p.sex} · {p.location}</span>
                    {!p.valid && (
                      <span style={{ background: C.amberL, color: C.amber, fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '99px' }}>⚠ Review needed</span>
                    )}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '6px' }}>
                    {[
                      { label: 'Diagnosis',     val: p.diagnosis      },
                      { label: 'Medications',   val: p.medications    },
                      { label: 'Lab values',    val: p.labs           },
                      { label: 'Co-morbidities', val: p.comorbidities },
                      { label: 'Allergies',     val: p.allergies      },
                      { label: 'Biomarkers',    val: p.biomarkers     },
                    ].map(f => f.val ? (
                      <div key={f.label}>
                        <div style={{ fontSize: '9.5px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '.06em', color: C.gray, marginBottom: '2px' }}>{f.label}</div>
                        <div style={{ fontSize: '12px', color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.val}</div>
                      </div>
                    ) : null)}
                  </div>

                  {p.errors.length > 0 && (
                    <div style={{ marginTop: '8px', padding: '6px 10px', background: C.amberL, borderRadius: '6px', fontSize: '11.5px', color: C.amber }}>
                      {p.errors.map((e, i) => <div key={i}>⚠ {e}</div>)}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ background: consentConfirmed ? C.tealL : C.amberL, border: `1px solid ${consentConfirmed ? 'rgba(15,110,86,.2)' : 'rgba(186,117,23,.3)'}`, borderRadius: '8px', padding: '12px 14px', marginBottom: '14px' }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={consentConfirmed}
              onChange={e => setConsentConfirmed(e.target.checked)}
              style={{ marginTop: '3px', flexShrink: 0, width: '15px', height: '15px', cursor: 'pointer', accentColor: C.teal }}
            />
            <span style={{ fontSize: '12px', color: consentConfirmed ? C.teal : '#5C3A08', lineHeight: '1.6' }}>
              <strong>Consent confirmation (required):</strong> I confirm that all selected patients have consented
              to their de-identified health information being used for clinical trial matching, separately from
              any consent given for their general treatment.
            </span>
          </label>
        </div>

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button style={S.btn(true, selected.size === 0 || !consentConfirmed)} disabled={selected.size === 0 || !consentConfirmed} onClick={doImport}>
            Import {selected.size} patient{selected.size !== 1 ? 's' : ''}
          </button>
          <button style={S.btn(false)} onClick={() => { setStep('upload'); setPreview([]); setRawFHIR(null); setParseErr('') }}>
            ← Back
          </button>
          <span style={{ fontSize: '12px', color: C.gray, marginLeft: 'auto' }}>
            {selected.size} of {validCount} valid patients selected
          </span>
        </div>
      </div>
    )
  }

  // ── STEP: IMPORTING ─────────────────────────────────────────
  if (step === 'importing') return (
    <div style={{ textAlign: 'center', padding: '48px 24px' }}>
      <div style={{ width: '36px', height: '36px', border: `3px solid ${C.tealL}`, borderTopColor: C.tealM, borderRadius: '50%', animation: 'spin .8s linear infinite', margin: '0 auto 16px' }}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ fontSize: '16px', fontWeight: '500', color: C.text, marginBottom: '8px' }}>Importing patients…</div>
      <div style={{ fontSize: '13px', color: C.gray }}>Parsing FHIR resources and creating patient records.</div>
    </div>
  )

  // ── STEP: DONE ──────────────────────────────────────────────
  if (step === 'done' && result) return (
    <div style={{ textAlign: 'center', padding: '40px 24px' }}>
      <div style={{ fontSize: '48px', marginBottom: '14px' }}>✅</div>
      <h3 style={{ margin: '0 0 8px', fontSize: '18px', fontWeight: '500', color: C.text }}>
        {result.imported} patient{result.imported !== 1 ? 's' : ''} imported
      </h3>
      <p style={{ fontSize: '13px', color: C.gray, lineHeight: '1.6', marginBottom: '20px', maxWidth: '360px', margin: '0 auto 20px' }}>
        FHIR records have been added to your patient list.
        {result.skipped > 0 && ` ${result.skipped} patient${result.skipped !== 1 ? 's' : ''} were skipped due to validation issues.`}
      </p>

      {result.warnings && result.warnings.length > 0 && (
        <div style={{ background: C.amberL, border: `1px solid rgba(186,117,23,.2)`, borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', textAlign: 'left' }}>
          <div style={{ fontSize: '12px', fontWeight: '600', color: C.amber, marginBottom: '6px' }}>Skipped patients</div>
          {result.warnings.map((w: any) => (
            <div key={w.index} style={{ fontSize: '12px', color: C.amber, marginBottom: '4px' }}>
              {w.code}: {w.errors.join(', ')}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
        <button style={S.btn()} onClick={() => { onImported(result.imported) }}>
          View patients →
        </button>
        <button style={S.btn(false)} onClick={() => { setStep('upload'); setPreview([]); setRawFHIR(null); setResult(null) }}>
          Import another file
        </button>
      </div>
    </div>
  )

  return null
}
