/**
 * lib/fhir.ts
 * FHIR R4 patient data parser.
 * Maps FHIR resources to the TrialMatch Patient schema.
 *
 * Supports:
 *  - Patient resource (demographics)
 *  - Condition resource (diagnosis, ICD-10/SNOMED codes)
 *  - MedicationRequest / MedicationStatement (current meds)
 *  - Observation (lab values — LOINC codes)
 *  - AllergyIntolerance (allergies)
 *  - Procedure (prior treatments)
 *
 * Works with:
 *  - Direct FHIR JSON file upload
 *  - FHIR Bundle (collection of resources)
 *  - Epic/Cerner/Meditech exports
 *  - ABDM (Ayushman Bharat Digital Mission) FHIR bundles
 */

import type { Patient } from './matcher'

// ── FHIR type stubs (minimal — avoids a heavy fhirpath dep) ──
interface FHIRResource   { resourceType: string; id?: string }
interface FHIRBundle     { resourceType: 'Bundle'; entry?: { resource: FHIRResource }[] }
interface FHIRPatient    extends FHIRResource { resourceType: 'Patient'; name?: any[]; birthDate?: string; gender?: string; address?: any[] }
interface FHIRCondition  extends FHIRResource { resourceType: 'Condition'; code?: { coding?: any[]; text?: string }; clinicalStatus?: any; severity?: any; onsetDateTime?: string }
interface FHIRMedRequest extends FHIRResource { resourceType: 'MedicationRequest' | 'MedicationStatement'; medicationCodeableConcept?: { coding?: any[]; text?: string }; medicationReference?: any; status?: string; dosageInstruction?: any[] }
interface FHIRObservation extends FHIRResource { resourceType: 'Observation'; code?: { coding?: any[]; text?: string }; valueQuantity?: { value: number; unit: string }; valueString?: string; valueCodeableConcept?: { text?: string }; status?: string; effectiveDateTime?: string }
interface FHIRAllergy   extends FHIRResource { resourceType: 'AllergyIntolerance'; code?: { coding?: any[]; text?: string }; clinicalStatus?: any }
interface FHIRProcedure extends FHIRResource { resourceType: 'Procedure'; code?: { coding?: any[]; text?: string }; status?: string; performedDateTime?: string; performedPeriod?: { start?: string; end?: string } }

// ── LOINC codes → lab name mapping (common ones) ─────────────
const LOINC_MAP: Record<string, string> = {
  '4548-4':  'HbA1c',       '2160-0':  'Creatinine',    '33914-3': 'eGFR',
  '2345-7':  'Glucose',     '2093-3':  'Total Cholesterol', '2085-9': 'HDL',
  '13457-7': 'LDL',         '2571-8':  'Triglycerides',  '718-7':   'Hemoglobin',
  '4544-3':  'Hematocrit',  '6690-2':  'WBC',            '777-3':   'Platelets',
  '2823-3':  'Potassium',   '2951-2':  'Sodium',         '2028-9':  'CO2',
  '1920-8':  'AST',         '1742-6':  'ALT',            '1975-2':  'Total Bilirubin',
  '2532-0':  'LDH',         '10334-1': 'PSA',            '731-0':   'Lymphocytes',
  '1988-5':  'CRP',         '4537-7':  'ESR',            '6301-6':  'INR/PT',
  '3094-0':  'BUN',
}

// ── ICD-10 prefix → readable category (for fallback) ─────────
const ICD_PREFIX_MAP: Record<string, string> = {
  'E11': 'Type 2 Diabetes Mellitus', 'E10': 'Type 1 Diabetes Mellitus',
  'I10': 'Hypertension', 'I21': 'Myocardial Infarction', 'I25': 'Coronary Artery Disease',
  'C34': 'Lung Cancer', 'C50': 'Breast Cancer', 'C18': 'Colon Cancer',
  'C61': 'Prostate Cancer', 'C92': 'Leukemia', 'C81': 'Hodgkin Lymphoma',
  'M05': 'Rheumatoid Arthritis', 'M32': 'Systemic Lupus Erythematosus',
  'N18': 'Chronic Kidney Disease', 'J44': 'COPD', 'J45': 'Asthma',
  'G35': 'Multiple Sclerosis', 'G20': "Parkinson's Disease",
  'F32': 'Major Depressive Disorder', 'F20': 'Schizophrenia',
  'K50': "Crohn's Disease", 'K51': 'Ulcerative Colitis',
}

// ── Main parser ───────────────────────────────────────────────
export function parseFHIRBundle(raw: any): Partial<Patient>[] {
  // Accept either a Bundle or a single resource array
  let resources: FHIRResource[] = []

  if (raw.resourceType === 'Bundle' && Array.isArray(raw.entry)) {
    resources = raw.entry.map((e: any) => e.resource).filter(Boolean)
  } else if (Array.isArray(raw)) {
    resources = raw
  } else if (raw.resourceType) {
    resources = [raw]
  }

  // Group by patient (support multi-patient bundles)
  const patients = resources.filter(r => r.resourceType === 'Patient') as FHIRPatient[]

  if (!patients.length) {
    throw new Error('No Patient resources found in FHIR data. Make sure you\'re uploading a valid FHIR R4 Patient bundle.')
  }

  return patients.map((pt, idx) => parseSinglePatient(pt, resources, patients.length, idx))
}

function parseSinglePatient(pt: FHIRPatient, allResources: FHIRResource[], totalPatientsInBundle: number, bundleIndex: number): Partial<Patient> {
  const ptId = pt.id

  // Filter resources that belong to this patient.
  //
  // SAFETY: in a multi-patient bundle, a resource with no subject/patient
  // reference at all is ambiguous and must NOT be attached to every patient —
  // doing so would silently merge one patient's conditions/medications/labs
  // into another's record. We only allow the "no reference = belongs to me"
  // fallback when there is exactly one patient in the whole bundle, where
  // the ambiguity doesn't exist by construction.
  const forPatient = (r: any) => {
    const subject = r.subject?.reference || r.patient?.reference || ''
    if (subject) {
      // Has an explicit reference — only match if it's specifically this patient.
      return !!ptId && subject.includes(ptId)
    }
    // No reference on the resource at all.
    if (totalPatientsInBundle === 1) return true
    // Multi-patient bundle with an unreferenced resource — exclude it rather
    // than guess. Better to under-extract than to cross-contaminate records.
    return false
  }

  const conditions  = allResources.filter(r => r.resourceType === 'Condition'            && forPatient(r)) as FHIRCondition[]
  const medications = allResources.filter(r => (r.resourceType === 'MedicationRequest' || r.resourceType === 'MedicationStatement') && forPatient(r)) as FHIRMedRequest[]
  const labs        = allResources.filter(r => r.resourceType === 'Observation'          && forPatient(r)) as FHIRObservation[]
  const allergies   = allResources.filter(r => r.resourceType === 'AllergyIntolerance'   && forPatient(r)) as FHIRAllergy[]
  const procedures  = allResources.filter(r => r.resourceType === 'Procedure'            && forPatient(r)) as FHIRProcedure[]

  return {
    patient_code:     generatePatientCode(pt, bundleIndex),
    age:              calcAge(pt.birthDate),
    sex:              mapGender(pt.gender),
    location:         extractLocation(pt),
    diagnosis:        extractPrimaryDiagnosis(conditions),
    stage:            extractStage(conditions),
    medications:      extractMedications(medications),
    labs:             extractLabs(labs),
    comorbidities:    extractComorbidities(conditions),
    prior_treatments: extractProcedures(procedures),
    allergies:        extractAllergies(allergies),
    biomarkers:       extractBiomarkers(labs),
  }
}

// ── Extractors ────────────────────────────────────────────────

function generatePatientCode(pt: FHIRPatient, bundleIndex: number): string {
  // Prefer the real FHIR resource ID. If absent, use a timestamp + the
  // patient's position in the bundle (NOT Date.now() alone — a synchronous
  // .map() over multiple ID-less patients can produce identical timestamps,
  // which would otherwise generate duplicate patient_code values and silently
  // overwrite one patient's record with another's on the unique constraint).
  const id = pt.id
    ? pt.id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase()
    : `${Date.now().toString().slice(-5)}${bundleIndex}`
  return `FHIR-${id}`
}

function calcAge(birthDate?: string): number {
  if (!birthDate) return 0
  const today = new Date()
  const dob   = new Date(birthDate)
  let age = today.getFullYear() - dob.getFullYear()
  if (today.getMonth() < dob.getMonth() || (today.getMonth() === dob.getMonth() && today.getDate() < dob.getDate())) age--
  return Math.max(0, age)
}

function mapGender(g?: string): 'Male' | 'Female' | 'Other' {
  if (!g) return 'Other'
  const lower = g.toLowerCase()
  if (lower === 'male')   return 'Male'
  if (lower === 'female') return 'Female'
  return 'Other'
}

function extractLocation(pt: FHIRPatient): string {
  const addr = pt.address?.[0]
  if (!addr) return 'India'
  const parts = [addr.city, addr.state, addr.country].filter(Boolean)
  return parts.join(', ') || 'India'
}

function codeableConceptText(cc?: { coding?: any[]; text?: string }): string {
  if (!cc) return ''
  if (cc.text) return cc.text

  // Try LOINC or ICD codes first
  for (const coding of cc.coding || []) {
    if (coding.display) return coding.display
    if (coding.system?.includes('loinc') && LOINC_MAP[coding.code]) return LOINC_MAP[coding.code]
    if (coding.system?.includes('icd') || coding.system?.includes('ICD')) {
      const prefix = (coding.code || '').slice(0, 3)
      if (ICD_PREFIX_MAP[prefix]) return ICD_PREFIX_MAP[prefix]
    }
    if (coding.code) return coding.code
  }
  return ''
}

function extractPrimaryDiagnosis(conditions: FHIRCondition[]): string {
  // Prioritise active conditions, then the first one found
  const active = conditions.filter(c => {
    const status = c.clinicalStatus?.coding?.[0]?.code || ''
    return status === 'active' || status === ''
  })
  const primary = active[0] || conditions[0]
  if (!primary) return 'Unknown diagnosis'
  return codeableConceptText(primary.code) || 'Unknown diagnosis'
}

function extractStage(conditions: FHIRCondition[]): string {
  const stages: string[] = []
  for (const c of conditions) {
    if (c.severity?.coding?.[0]?.display) stages.push(c.severity.coding[0].display)
    else if (c.severity?.text) stages.push(c.severity.text)
  }
  return stages.slice(0, 2).join(', ')
}

function extractMedications(meds: FHIRMedRequest[]): string {
  const names: string[] = []
  for (const med of meds) {
    if (med.status === 'stopped' || med.status === 'cancelled') continue
    const name = codeableConceptText(med.medicationCodeableConcept)
    if (name && !names.includes(name)) names.push(name)
    if (names.length >= 8) break
  }
  return names.join(', ')
}

function extractLabs(obs: FHIRObservation[]): string {
  const labParts: string[] = []
  for (const o of obs) {
    if (o.status === 'cancelled' || o.status === 'entered-in-error') continue
    const name = codeableConceptText(o.code)
    if (!name) continue

    let value = ''
    if (o.valueQuantity) {
      value = `${o.valueQuantity.value} ${o.valueQuantity.unit || ''}`
    } else if (o.valueString) {
      value = o.valueString
    } else if (o.valueCodeableConcept?.text) {
      value = o.valueCodeableConcept.text
    }

    if (value) labParts.push(`${name}: ${value.trim()}`)
    if (labParts.length >= 8) break
  }
  return labParts.join(', ')
}

function extractComorbidities(conditions: FHIRCondition[]): string {
  if (conditions.length <= 1) return ''
  // All conditions except the first (primary) are comorbidities
  return conditions
    .slice(1)
    .filter(c => {
      const status = c.clinicalStatus?.coding?.[0]?.code || ''
      return status === 'active' || status === ''
    })
    .map(c => codeableConceptText(c.code))
    .filter(Boolean)
    .slice(0, 5)
    .join(', ')
}

function extractProcedures(procs: FHIRProcedure[]): string {
  return procs
    .filter(p => p.status === 'completed')
    .map(p => {
      const name = codeableConceptText(p.code)
      const date = p.performedDateTime || p.performedPeriod?.end
      if (date) {
        const yr = new Date(date).getFullYear()
        return `${name} (${yr})`
      }
      return name
    })
    .filter(Boolean)
    .slice(0, 5)
    .join(', ')
}

function extractAllergies(allergies: FHIRAllergy[]): string {
  return allergies
    .filter(a => {
      const status = a.clinicalStatus?.coding?.[0]?.code || ''
      return status === 'active' || status === ''
    })
    .map(a => codeableConceptText(a.code))
    .filter(Boolean)
    .slice(0, 5)
    .join(', ')
}

function extractBiomarkers(obs: FHIRObservation[]): string {
  const biomarkerKeywords = [
    'BRCA', 'HER2', 'PDL1', 'PD-L1', 'EGFR', 'ALK', 'ROS1', 'KRAS',
    'BRAF', 'MSI', 'TMB', 'ER ', 'PR ', 'PSA', 'CEA', 'CA-125', 'AFP',
    'BCR-ABL', 'JAK2', 'FLT3', 'IDH1', 'IDH2', 'TP53', 'PIK3CA',
  ]
  const found: string[] = []
  for (const o of obs) {
    const name = codeableConceptText(o.code) || ''
    if (biomarkerKeywords.some(k => name.toUpperCase().includes(k))) {
      let val = ''
      if (o.valueQuantity) val = `${o.valueQuantity.value}${o.valueQuantity.unit || ''}`
      else if (o.valueString) val = o.valueString
      else if (o.valueCodeableConcept?.text) val = o.valueCodeableConcept.text
      found.push(val ? `${name}: ${val}` : name)
    }
    if (found.length >= 5) break
  }
  return found.join(', ')
}

// ── Validate a parsed patient has minimum required fields ─────
export function validateFHIRPatient(p: Partial<Patient>): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!p.age || p.age <= 0)         errors.push('Missing or invalid age (birthDate in FHIR)')
  if (!p.sex)                        errors.push('Missing gender')
  if (!p.diagnosis || p.diagnosis === 'Unknown diagnosis') errors.push('No active Condition resource found')
  return { valid: errors.length === 0, errors }
}
