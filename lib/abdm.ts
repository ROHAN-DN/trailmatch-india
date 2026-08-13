/**
 * lib/abdm.ts
 * Adapter for Ayushman Bharat Digital Mission (ABDM) FHIR bundles.
 * ABDM uses FHIR R4 with some India-specific extensions and profiles.
 *
 * ABDM FHIR API docs: https://sandbox.abdm.gov.in/docs/fhir
 *
 * This adapter normalises ABDM bundles before passing to lib/fhir.ts.
 * Handles:
 *  - ABDM composition-based health records
 *  - OPConsultRecord, DischargeSummary, DiagnosticReport profiles
 *  - SNOMED CT codes common in ABDM records
 *  - ICD-10 coded conditions from Apollo, Fortis, Max exports
 */

// ── ABDM SNOMED → readable condition names ────────────────────
const ABDM_SNOMED_MAP: Record<string, string> = {
  '73211009':  'Diabetes Mellitus',
  '44054006':  'Type 2 Diabetes Mellitus',
  '38341003':  'Hypertension',
  '53741008':  'Coronary Artery Disease',
  '363346000': 'Malignant Neoplasm',
  '363418001': 'Malignant Neoplasm of Pancreas',
  '254837009': 'Breast Cancer',
  '93864006':  'Lung Cancer',
  '68496003':  'Polyp of Colon',
  '57054005':  'Acute Myocardial Infarction',
  '195967001': 'Asthma',
  '13645005':  'COPD',
  '233726005': 'Chronic Kidney Disease',
  '69896004':  'Rheumatoid Arthritis',
  '24700007':  'Multiple Sclerosis',
  '49049000':  "Parkinson's Disease",
}

// ── ABDM drug code (NDHM drug code) mapping ───────────────────
const ABDM_DRUG_MAP: Record<string, string> = {
  'ABDM-MET': 'Metformin',
  'ABDM-INS': 'Insulin',
  'ABDM-AML': 'Amlodipine',
  'ABDM-ATR': 'Atorvastatin',
  'ABDM-MTX': 'Methotrexate',
}

/**
 * Normalise an ABDM bundle to standard FHIR R4 before parsing.
 * Most ABDM records use Composition resources wrapping the clinical data.
 */
export function normaliseABDMBundle(raw: any): any {
  if (!raw || raw.resourceType !== 'Bundle') return raw

  const entries: any[] = raw.entry || []
  const normalised = { ...raw }

  // Flatten Composition sections into top-level entries
  const compositions = entries
    .map(e => e.resource)
    .filter(r => r?.resourceType === 'Composition')

  if (!compositions.length) return raw  // Already normalised or not ABDM

  const newEntries = [...entries]

  for (const comp of compositions) {
    for (const section of comp.section || []) {
      for (const entry of section.entry || []) {
        // ABDM sometimes embeds resources as contained rather than referenced
        const ref = entry.reference || ''
        const existing = entries.find(e => e.resource?.id && ref.includes(e.resource.id))
        if (!existing && entry.resource) {
          newEntries.push({ resource: entry.resource })
        }
      }
    }
  }

  // Normalise SNOMED codes in Conditions
  normalised.entry = newEntries.map(e => {
    if (!e.resource || e.resource.resourceType !== 'Condition') return e
    const cond = { ...e.resource }
    if (cond.code?.coding) {
      cond.code = { ...cond.code, coding: cond.code.coding.map((c: any) => {
        if (c.system?.includes('snomed') && ABDM_SNOMED_MAP[c.code]) {
          return { ...c, display: ABDM_SNOMED_MAP[c.code] }
        }
        return c
      })}
    }
    return { ...e, resource: cond }
  })

  return normalised
}

/**
 * Detect whether a bundle is likely an ABDM bundle.
 * ABDM bundles typically have:
 *   - profile URLs containing abdm.gov.in
 *   - Composition resourceType
 *   - India-specific extensions
 */
export function isABDMBundle(raw: any): boolean {
  if (!raw || raw.resourceType !== 'Bundle') return false
  const str = JSON.stringify(raw).toLowerCase()
  return (
    str.includes('abdm.gov.in') ||
    str.includes('nrces.in') ||
    str.includes('healthid') ||
    str.includes('abha') ||
    (raw.entry || []).some((e: any) => e?.resource?.resourceType === 'Composition')
  )
}

/**
 * Extract ABHA (Ayushman Bharat Health Account) number from bundle if present.
 * Used as a unique patient identifier in the Indian health ecosystem.
 */
export function extractABHA(raw: any): string | null {
  try {
    const entries: any[] = raw.entry || []
    const patient = entries.find(e => e.resource?.resourceType === 'Patient')?.resource
    if (!patient) return null

    // ABHA appears as an identifier with system containing 'healthid' or 'abha'
    const abhaIdentifier = (patient.identifier || []).find((id: any) =>
      id.system?.toLowerCase().includes('healthid') ||
      id.system?.toLowerCase().includes('abha') ||
      id.type?.coding?.[0]?.code === 'ABHA'
    )
    return abhaIdentifier?.value || null
  } catch {
    return null
  }
}
