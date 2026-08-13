import { useState, useEffect } from 'react'
import StructuredRowsEditor, { type FieldConfig } from './StructuredRowsEditor'

interface ModalProps { patient?: any; onClose: () => void; onSave: () => void }

// Field configs for the five structured categories — see lib/clinical-data.ts
// for the matching Zod schemas these need to satisfy on submit.
const LAB_FIELDS: FieldConfig[] = [
  { key: 'test_name', label: 'Test', type: 'text', placeholder: 'HbA1c', width: '32%' },
  { key: 'value',     label: 'Value', type: 'text', placeholder: '9.2 (numbers compare automatically)', width: '30%' },
  { key: 'unit',      label: 'Unit', type: 'text', placeholder: '%', width: '16%' },
  { key: 'collected_date', label: 'Date', type: 'date', width: '22%' },
]
const MED_FIELDS: FieldConfig[] = [
  { key: 'name',   label: 'Medication', type: 'text', placeholder: 'Metformin', width: '32%' },
  { key: 'dose',   label: 'Dose', type: 'text', placeholder: '500mg', width: '20%' },
  { key: 'status', label: 'Status', type: 'select', options: ['active', 'discontinued', 'unknown'], width: '24%' },
  { key: 'start_date', label: 'Since', type: 'date', width: '24%' },
]
const BIOMARKER_FIELDS: FieldConfig[] = [
  { key: 'marker', label: 'Marker', type: 'text', placeholder: 'EGFR', width: '28%' },
  { key: 'status', label: 'Result', type: 'select', options: ['positive', 'negative', 'unknown', 'not_tested'], width: '26%' },
  { key: 'value',  label: 'Detail', type: 'text', placeholder: '30% / Exon 19 deletion', width: '26%' },
  { key: 'tested_date', label: 'Date', type: 'date', width: '20%' },
]
const COMORBIDITY_FIELDS: FieldConfig[] = [
  { key: 'condition', label: 'Condition', type: 'text', placeholder: 'Hypertension', width: '40%' },
  { key: 'status', label: 'Status', type: 'select', options: ['active', 'resolved', 'unknown'], width: '28%' },
  { key: 'diagnosed_date', label: 'Since', type: 'date', width: '28%' },
]
const ALLERGY_FIELDS: FieldConfig[] = [
  { key: 'substance', label: 'Substance', type: 'text', placeholder: 'Sulfa drugs', width: '32%' },
  { key: 'reaction',  label: 'Reaction', type: 'text', placeholder: 'Rash', width: '32%' },
  { key: 'severity',  label: 'Severity', type: 'select', options: ['mild', 'moderate', 'severe', 'unknown'], width: '32%' },
]

// A lab's "value" is entered as one free-typed field for simplicity, then
// classified into the structured column that actually supports comparison:
// a parseable number goes to value_numeric (so a future rule engine can do
// `value_numeric >= 45` directly), anything else goes to value_text.
// A trailing % is stripped before the numeric check since it's an extremely
// common way to type a lab value and shouldn't force it into value_text.
function parseLabValue(raw: string): { value_numeric?: number; value_text?: string } {
  const trimmed = (raw || '').trim()
  if (!trimmed) return {}
  const cleaned = trimmed.replace(/%$/, '')
  const num = Number(cleaned)
  return Number.isFinite(num) && cleaned !== '' ? { value_numeric: num } : { value_text: trimmed }
}

export default function PatientModal({ patient, onClose, onSave }: ModalProps) {
  const isEdit = !!patient
  const [form, setForm] = useState({
    patient_code:'', age:'', sex:'', location:'', diagnosis:'', stage:'',
    ecog_status:'', notes:'',
    ...(patient || {}),
  })
  const [labs,          setLabs]          = useState<any[]>([])
  const [medications,   setMedications]   = useState<any[]>([])
  const [biomarkers,    setBiomarkers]    = useState<any[]>([])
  const [comorbidities, setComorbidities] = useState<any[]>([])
  const [allergies,     setAllergies]     = useState<any[]>([])
  const [loadingClinical, setLoadingClinical] = useState(isEdit)

  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState('')
  const [consentGiven, setConsentGiven] = useState(false)
  const [consentError, setConsentError] = useState(false)

  // Edit mode: load this patient's existing structured clinical data.
  // Displaying a lab-value number as text in the row editor: value_numeric
  // and value_text are never both set (see migration 017's CHECK
  // constraint), so ?? cleanly picks whichever one is actually populated.
  useEffect(() => {
    if (!isEdit) return
    let cancelled = false
    fetch(`/api/patients/${patient.id}/clinical`)
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(data => {
        if (cancelled) return
        setLabs((data.labs || []).map((l: any) => ({ ...l, value: l.value_numeric ?? l.value_text ?? '' })))
        setMedications(data.medications || [])
        setBiomarkers(data.biomarkers || [])
        setComorbidities(data.comorbidities || [])
        setAllergies(data.allergies || [])
      })
      .catch(() => { if (!cancelled) setError('Could not load this patient\'s existing clinical data — you can still edit the fields below, but re-check them before saving.') })
      .finally(() => { if (!cancelled) setLoadingClinical(false) })
    return () => { cancelled = true }
  }, [isEdit, patient?.id])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!isEdit && !consentGiven) { setConsentError(true); return }
    setLoading(true); setError(''); setConsentError(false)

    const url    = isEdit ? `/api/patients?id=${patient.id}` : '/api/patients'
    const method = isEdit ? 'PATCH' : 'POST'

    // Drop rows where the identifying field was left blank — a row added
    // via "+ Add" and never filled in shouldn't be sent (it would fail the
    // server's Zod validation, e.g. LabInput requires a non-empty test_name).
    const structured_labs = labs
      .filter(l => l.test_name?.trim())
      .map(l => ({ test_name: l.test_name.trim(), unit: l.unit || undefined, collected_date: l.collected_date || undefined, ...parseLabValue(l.value) }))
      .filter(l => l.value_numeric !== undefined || l.value_text !== undefined)
    const structured_medications = medications
      .filter(m => m.name?.trim())
      .map(m => ({ name: m.name.trim(), dose: m.dose || undefined, status: m.status || 'active', start_date: m.start_date || undefined }))
    const structured_biomarkers = biomarkers
      .filter(b => b.marker?.trim())
      .map(b => ({ marker: b.marker.trim(), status: b.status || 'unknown', value: b.value || undefined, tested_date: b.tested_date || undefined }))
    const structured_comorbidities = comorbidities
      .filter(c => c.condition?.trim())
      .map(c => ({ condition: c.condition.trim(), status: c.status || 'active', diagnosed_date: c.diagnosed_date || undefined }))
    const structured_allergies = allergies
      .filter(a => a.substance?.trim())
      .map(a => ({ substance: a.substance.trim(), reaction: a.reaction || undefined, severity: a.severity || 'unknown' }))

    const payload = {
      ...form, age: +form.age,
      structured_labs, structured_medications, structured_biomarkers, structured_comorbidities, structured_allergies,
      ...(!isEdit ? { consent_given: true } : {}),
    }
    const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    setLoading(false)
    if (r.ok) onSave()
    else { const d = await r.json(); setError(d.error?.fieldErrors ? 'Please check all required fields.' : d.error || 'Save failed') }
  }

  const S = {
    overlay:{ position:'fixed' as any, inset:0, background:'rgba(0,0,0,.5)', zIndex:200, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' },
    modal:  { background:'#fff', borderRadius:'12px', padding:'24px', maxWidth:'640px', width:'100%', maxHeight:'90vh', overflowY:'auto' as any },
    label:  { fontSize:'10px', fontWeight:'600' as any, letterSpacing:'.06em', textTransform:'uppercase' as any, color:'#72706A', display:'block', marginBottom:'5px' },
    input:  { width:'100%', padding:'9px 12px', border:'1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', fontFamily:'sans-serif', outline:'none', boxSizing:'border-box' as any },
    grid:   { display:'grid', gridTemplateColumns:'1fr 1fr', gap:'12px', marginBottom:'12px' },
    btn:    (p=true) => ({ padding:'10px 20px', background:p?'#0F6E56':'#fff', color:p?'#fff':'#1C1B18', border:p?'none':'1px solid #E2E0D8', borderRadius:'8px', fontSize:'13px', fontWeight:'500' as any, cursor:'pointer', fontFamily:'sans-serif' }),
    section:{ marginBottom:'18px', paddingTop:'14px', borderTop:'1px solid #EFEDE6' },
    sectionTitle: { fontSize:'12.5px', fontWeight:'600' as any, color:'#1C1B18', marginBottom:'8px' },
  }

  const F = ({ label, id, type='text', required=false, ...rest }: any) => (
    <div>
      <label style={S.label}>{label}{required && ' *'}</label>
      <input id={id} type={type} value={form[id]} onChange={set(id)} required={required} style={S.input} {...rest}/>
    </div>
  )

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'20px' }}>
          <h2 style={{ margin:0, fontSize:'17px', fontWeight:'500' }}>{isEdit ? 'Edit patient' : 'Add patient'}</h2>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:'22px', cursor:'pointer', color:'#72706A', lineHeight:1 }}>×</button>
        </div>
        <form onSubmit={submit}>

          {!isEdit && (
            <div style={{ background:'#E1F5EE', border:'1px solid rgba(15,110,86,.2)', borderRadius:'8px', padding:'11px 14px', marginBottom:'16px', fontSize:'12px', color:'#0F6E56', lineHeight:'1.6' }}>
              <strong style={{ display:'block', marginBottom:'3px' }}>⚠ De-identification required</strong>
              Enter a <strong>de-identified code only</strong> (e.g. PT-001) — never the patient's name, Aadhaar number, phone number, or date of birth.
            </div>
          )}

          <div style={S.grid}>
            <F label="Patient code" id="patient_code" required placeholder="PT-001"/>
            <div>
              <label style={S.label}>Sex *</label>
              <select value={form.sex} onChange={set('sex')} required style={S.input}>
                <option value="">Select</option>
                <option>Male</option><option>Female</option><option>Other</option>
              </select>
            </div>
          </div>
          <div style={S.grid}>
            <F label="Age" id="age" type="number" required placeholder="54"/>
            <F label="Location" id="location" required placeholder="Bengaluru, Karnataka"/>
          </div>
          <div style={{ marginBottom:'12px' }}>
            <F label="Primary diagnosis" id="diagnosis" required placeholder="Type 2 Diabetes Mellitus"/>
          </div>
          <div style={S.grid}>
            <F label="Stage / Severity" id="stage" placeholder="Moderate"/>
            <div>
              <label style={S.label}>ECOG status</label>
              <select value={form.ecog_status || ''} onChange={set('ecog_status')} style={S.input}>
                <option value="">Not recorded</option>
                <option>ECOG 0</option><option>ECOG 1</option><option>ECOG 2</option>
                <option>ECOG 3</option><option>ECOG 4</option><option>ECOG 5</option>
              </select>
            </div>
          </div>

          {loadingClinical ? (
            <p style={{ fontSize:'12px', color:'#72706A', padding:'10px 0' }}>Loading existing clinical data…</p>
          ) : (
            <>
              <div style={S.section}>
                <div style={S.sectionTitle}>Lab values</div>
                <StructuredRowsEditor rows={labs} onChange={setLabs} fields={LAB_FIELDS} addLabel="Add lab"
                  emptyRow={{ test_name:'', value:'', unit:'', collected_date:'' }}/>
              </div>

              <div style={S.section}>
                <div style={S.sectionTitle}>Medications</div>
                <StructuredRowsEditor rows={medications} onChange={setMedications} fields={MED_FIELDS} addLabel="Add medication"
                  emptyRow={{ name:'', dose:'', status:'active', start_date:'' }}/>
              </div>

              <div style={S.section}>
                <div style={S.sectionTitle}>Biomarkers / genetic</div>
                <StructuredRowsEditor rows={biomarkers} onChange={setBiomarkers} fields={BIOMARKER_FIELDS} addLabel="Add biomarker"
                  emptyRow={{ marker:'', status:'unknown', value:'', tested_date:'' }}/>
              </div>

              <div style={S.section}>
                <div style={S.sectionTitle}>Co-morbidities</div>
                <StructuredRowsEditor rows={comorbidities} onChange={setComorbidities} fields={COMORBIDITY_FIELDS} addLabel="Add condition"
                  emptyRow={{ condition:'', status:'active', diagnosed_date:'' }}/>
              </div>

              <div style={S.section}>
                <div style={S.sectionTitle}>Allergies</div>
                <StructuredRowsEditor rows={allergies} onChange={setAllergies} fields={ALLERGY_FIELDS} addLabel="Add allergy"
                  emptyRow={{ substance:'', reaction:'', severity:'unknown' }}/>
              </div>
            </>
          )}

          <div style={{ marginBottom:'16px', paddingTop:'14px', borderTop:'1px solid #EFEDE6' }}>
            <label style={S.label}>Additional notes</label>
            <textarea value={form.notes} onChange={set('notes')} style={{ ...S.input, minHeight:'60px', resize:'vertical', lineHeight:'1.5' }} placeholder="Travel constraints, prior trial participation, anything the structured fields above don't capture…"/>
          </div>
          {error && <p style={{ color:'#A32D2D', fontSize:'12px', margin:'0 0 12px' }}>{error}</p>}

          {!isEdit && (
            <div style={{ background: consentError ? '#FEF0EE' : '#FAEEDA', border:`1px solid ${consentError ? 'rgba(165,45,45,.3)' : 'rgba(186,117,23,.2)'}`, borderRadius:'8px', padding:'12px 14px', marginBottom:'14px' }}>
              <label style={{ display:'flex', alignItems:'flex-start', gap:'10px', cursor:'pointer' }}>
                <input type="checkbox" checked={consentGiven} onChange={e => { setConsentGiven(e.target.checked); if (e.target.checked) setConsentError(false) }} style={{ marginTop:'3px', flexShrink:0, width:'15px', height:'15px', cursor:'pointer', accentColor:'#0F6E56' }}/>
                <span style={{ fontSize:'12px', color: consentError ? '#A32D2D' : '#5C3A08', lineHeight:'1.6' }}>
                  <strong>Consent confirmation (required):</strong> I confirm this patient has been informed that their de-identified health information will be used for clinical trial matching and has given their consent. No personally identifiable information has been entered above.
                </span>
              </label>
              {consentError && <p style={{ color:'#A32D2D', fontSize:'11.5px', margin:'7px 0 0', fontWeight:'500' }}>✗ You must confirm patient consent before saving this record.</p>}
            </div>
          )}

          <div style={{ display:'flex', gap:'10px', justifyContent:'flex-end' }}>
            <button type="button" onClick={onClose} style={S.btn(false)}>Cancel</button>
            <button type="submit" disabled={loading} style={S.btn()}>{loading ? 'Saving…' : isEdit ? 'Save changes' : 'Add patient'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
