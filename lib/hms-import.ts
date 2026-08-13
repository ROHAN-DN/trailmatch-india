/**
 * lib/hms-import.ts
 * Insta HMS → TrialMatch patient import (Week 12-13)
 *
 * Handles two CSV shapes:
 *   A. TrialMatch own export format (round-trip import)
 *   B. Insta HMS native patient export (common field name variants)
 *
 * Returns a preview list + validated import rows.
 * Coordinator confirms before final insert.
 */

export interface HMSImportRow {
  patient_code:   string
  diagnosis:      string
  age:            number
  sex:            string
  location:       string
  medications?:   string
  comorbidities?: string
  labs?:          string
  notes?:         string
  /** Whether this row had enough data to be importable */
  valid:          boolean
  /** Human-readable reason if invalid */
  invalid_reason?: string
}

export interface HMSImportResult {
  rows:          HMSImportRow[]
  valid_count:   number
  skip_count:    number
  warnings:      string[]
  detected_format: 'trialmatch_export' | 'hms_native' | 'unknown'
}

// Flexible column name mapping for both formats
const FIELD_MAP: Record<string, keyof HMSImportRow> = {
  // TrialMatch export headers
  'patient code':      'patient_code',
  'primary diagnosis': 'diagnosis',
  'age':               'age',
  'sex':               'sex',
  'location':          'location',

  // Insta HMS native headers (common variants)
  'patient id':        'patient_code',
  'uhid':              'patient_code',
  'mr no':             'patient_code',
  'mr number':         'patient_code',
  'patient name':      'patient_code',   // we use as code, not name
  'diagnosis':         'diagnosis',
  'chief complaint':   'diagnosis',
  'icd code':          'diagnosis',
  'icd-10':            'diagnosis',
  'patient age':       'age',
  'age (years)':       'age',
  'gender':            'sex',
  'patient gender':    'sex',
  'city':              'location',
  'address':           'location',
  'current medications': 'medications',
  'medications':       'medications',
  'drug history':      'medications',
  'co-morbidities':    'comorbidities',
  'comorbidities':     'comorbidities',
  'past medical history': 'comorbidities',
  'lab values':        'labs',
  'lab results':       'labs',
  'investigations':    'labs',
  'remarks':           'notes',
  'notes':             'notes',
}

export function parseHMSCSV(csvText: string): HMSImportResult {
  // Strip BOM if present
  const text    = csvText.replace(/^\uFEFF/, '').trim()
  const lines   = text.split(/\r?\n/).filter(l => l.trim().length > 0)
  const warnings: string[] = []

  if (lines.length < 2) {
    return { rows:[], valid_count:0, skip_count:0, warnings:['CSV file appears empty or has only headers.'], detected_format:'unknown' }
  }

  // Parse headers
  const rawHeaders = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase().replace(/[_\-]/g, ' '))
  const colIndex   = new Map<keyof HMSImportRow, number>()

  for (let i = 0; i < rawHeaders.length; i++) {
    const mapped = FIELD_MAP[rawHeaders[i]]
    if (mapped && !colIndex.has(mapped)) colIndex.set(mapped, i)
  }

  // Detect format
  const hasPatientCode = colIndex.has('patient_code')
  const hasDiagnosis   = colIndex.has('diagnosis')
  const isTrialMatchExport = rawHeaders.includes('match strength') || rawHeaders.includes('trial id (nct/ctri)')
  const detected_format = isTrialMatchExport ? 'trialmatch_export' :
                          (hasPatientCode || hasDiagnosis) ? 'hms_native' : 'unknown'

  if (!hasDiagnosis) {
    warnings.push('No diagnosis column found. Using "Unknown" as placeholder — update after import.')
  }

  const rows: HMSImportRow[] = []
  let skip_count = 0

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i])
    if (cols.every(c => !c.trim())) continue   // blank row

    const get = (field: keyof HMSImportRow): string =>
      colIndex.has(field) ? (cols[colIndex.get(field)!] || '').trim() : ''

    const rawAge = get('age')
    const age    = parseInt(rawAge, 10)

    // patient_code: use UHID/MR No if available, else generate from row number
    let patient_code = get('patient_code')
    if (!patient_code) patient_code = `HMS-${String(i).padStart(4, '0')}`
    // Sanitise — remove spaces and special chars
    patient_code = patient_code.replace(/[^A-Za-z0-9\-_]/g, '-').slice(0, 50)

    const diagnosis  = get('diagnosis') || 'Unknown'
    const sex_raw    = get('sex').toLowerCase()
    const sex        = sex_raw.startsWith('m') ? 'Male' : sex_raw.startsWith('f') ? 'Female' : 'Other'

    // Validation
    let valid          = true
    let invalid_reason: string | undefined

    if (isNaN(age) || age < 0 || age > 130) {
      if (rawAge) {
        warnings.push(`Row ${i}: age "${rawAge}" is not a valid number — defaulting to 0.`)
      }
    }

    if (diagnosis === 'Unknown' && !hasDiagnosis) {
      // This is expected — not an error per row
    } else if (!diagnosis) {
      valid = false
      invalid_reason = 'Missing diagnosis'
      skip_count++
    }

    rows.push({
      patient_code,
      diagnosis,
      age:          isNaN(age) ? 0 : Math.min(130, Math.max(0, age)),
      sex,
      location:     get('location') || '',
      medications:  get('medications') || undefined,
      comorbidities:get('comorbidities') || undefined,
      labs:         get('labs') || undefined,
      notes:        get('notes') || undefined,
      valid,
      invalid_reason,
    })
  }

  const valid_count = rows.filter(r => r.valid).length
  if (lines.length - 1 - valid_count > 0) {
    warnings.push(`${lines.length - 1 - valid_count} rows were skipped due to missing required fields.`)
  }

  return { rows, valid_count, skip_count, warnings, detected_format }
}

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}
