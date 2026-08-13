import { describe, it, expect } from 'vitest'
import { parseCTRIBulkExport, filterCTRIBulkTrialsByDiagnosis } from '../ctri-bulk-export'

// Representative sample built from the same column names
// scripts/seed-site-twins.ts's parseCTRICsv already assumed for this
// exact site — CTRI_NUMBER, TRIAL_TITLE, etc. NOT a real downloaded
// ICTRP/CTRI export file; none was available in this environment to
// verify column names against (ctri.nic.in isn't reachable from here).
const SAMPLE_CSV_LEGACY_HEADERS = `CTRI_NUMBER,TRIAL_TITLE,Health Condition,Phase,Sponsor,Status,MIN_AGE,MAX_AGE,Inclusion Criteria,CITY,STATE
CTRI/2024/01/000123,"A Study of Drug X in Type 2 Diabetes",Type 2 Diabetes Mellitus,Phase 3,Test Pharma Ltd,Recruiting,18 Years,65 Years,"HbA1c 7-11%; on stable metformin",Mumbai,Maharashtra
CTRI/2023/11/000456,"Trial of Drug Y for Diabetic Nephropathy",Diabetic Nephropathy,Phase 2,Another Sponsor,Recruiting,21 Years,70 Years,"eGFR >= 30",Delhi,Delhi
,Incomplete row with no ID,,,,,,,,,`

// Same logical data, DIFFERENT plausible header text (WHO TRDS-style
// naming) — this is the scenario the alias matching exists for: the real
// column names could plausibly be either style, or something else
// entirely, and this parser needs to handle not knowing which in advance.
const SAMPLE_CSV_TRDS_STYLE_HEADERS = `Primary Registry and Trial Identifying Number,Public Title,Health Condition(s) or Problem(s) Studied,Phase of Trial,Primary Sponsor,Overall Status,Age Min,Age Max,Key Inclusion and Exclusion Criteria,Recruitment City,Recruitment State
CTRI/2024/02/000789,"A Study of Drug Z in Hypertension",Essential Hypertension,Phase 4,Global Pharma,Recruiting,30 Years,75 Years,"BP 140-179/90-109 mmHg",Bengaluru,Karnataka`

const SAMPLE_CSV_UNRECOGNISABLE = `col1,col2,col3
foo,bar,baz
1,2,3`

describe('parseCTRIBulkExport — with the legacy-style headers already assumed elsewhere in this codebase', () => {
  it('parses real-shaped rows and skips the blank-ID row', () => {
    const result = parseCTRIBulkExport(SAMPLE_CSV_LEGACY_HEADERS)
    expect(result.trials).toHaveLength(2)
    expect(result.looksValid).toBe(true)
    expect(result.unmappedFields).toEqual([])
  })

  it('extracts every mapped field correctly', () => {
    const result = parseCTRIBulkExport(SAMPLE_CSV_LEGACY_HEADERS)
    const t = result.trials[0]
    expect(t.ctriId).toBe('CTRI/2024/01/000123')
    expect(t.title).toBe('A Study of Drug X in Type 2 Diabetes')
    expect(t.condition).toBe('Type 2 Diabetes Mellitus')
    expect(t.phase).toBe('Phase 3')
    expect(t.eligibilityText).toContain('HbA1c 7-11%')
    expect(t.city).toBe('Mumbai')
  })

  it('normalizes the extracted CTRI ID even if surrounding cell text is noisy', () => {
    const csv = `CTRI_NUMBER,TRIAL_TITLE\n"Reg No: ctri/2024/01/000999 (verified)",Some Trial`
    const result = parseCTRIBulkExport(csv)
    expect(result.trials[0].ctriId).toBe('CTRI/2024/01/000999') // uppercased, extracted from surrounding text
  })
})

describe('parseCTRIBulkExport — with WHO TRDS-style headers (the alias matching is the point)', () => {
  it('maps a completely different plausible header vocabulary to the same logical fields', () => {
    const result = parseCTRIBulkExport(SAMPLE_CSV_TRDS_STYLE_HEADERS)
    expect(result.looksValid).toBe(true)
    expect(result.trials[0].ctriId).toBe('CTRI/2024/02/000789')
    expect(result.trials[0].title).toBe('A Study of Drug Z in Hypertension')
    expect(result.trials[0].condition).toBe('Essential Hypertension')
  })

  it('is case- and punctuation-insensitive in header matching', () => {
    const csv = `ctri number,PUBLIC-TITLE\nCTRI/2024/03/000111,Case Test Trial`
    const result = parseCTRIBulkExport(csv)
    expect(result.looksValid).toBe(true)
    expect(result.trials[0].title).toBe('Case Test Trial')
  })
})

describe('parseCTRIBulkExport — honest failure when the file structure does not match anything expected', () => {
  it('reports unmapped core fields and looksValid=false for unrecognisable headers, rather than silently returning zero trials', () => {
    const result = parseCTRIBulkExport(SAMPLE_CSV_UNRECOGNISABLE)
    expect(result.looksValid).toBe(false)
    expect(result.unmappedFields).toContain('ctriId')
    expect(result.unmappedFields).toContain('title')
    expect(result.trials).toEqual([])
  })

  it('looksValid=false when headers are recognised but no row actually contains a real CTRI-ID-shaped value', () => {
    const csv = `CTRI_NUMBER,TRIAL_TITLE\nnot-a-real-id,Some Trial\n,Another Trial`
    const result = parseCTRIBulkExport(csv)
    expect(result.looksValid).toBe(false)
    expect(result.trials).toEqual([])
    // The core fields WERE found — this CSV only has 2 columns, so the
    // other 9 logical fields are legitimately unmapped; looksValid is
    // false here because of the missing real ID-shaped data, not because
    // of a mapping failure.
    expect(result.unmappedFields).not.toContain('ctriId')
    expect(result.unmappedFields).not.toContain('title')
  })

  it('does not throw on empty input', () => {
    expect(() => parseCTRIBulkExport('')).not.toThrow()
    const result = parseCTRIBulkExport('')
    expect(result.looksValid).toBe(false)
  })

  it('does not throw on non-CSV garbage (e.g. an HTML error page returned instead of a file)', () => {
    expect(() => parseCTRIBulkExport('<html><body>404 Not Found</body></html>')).not.toThrow()
    const result = parseCTRIBulkExport('<html><body>404 Not Found</body></html>')
    expect(result.looksValid).toBe(false)
  })
})

describe('filterCTRIBulkTrialsByDiagnosis', () => {
  const trials = parseCTRIBulkExport(SAMPLE_CSV_LEGACY_HEADERS).trials

  it('matches case-insensitively against title or condition', () => {
    // Plain substring matching (same simple approach used for diagnosis
    // matching elsewhere in this codebase) — 'diabetic' is not a
    // substring of 'diabetes', so these are two separate, correct
    // single-match assertions, not one match-both assertion.
    expect(filterCTRIBulkTrialsByDiagnosis(trials, 'diabetes')).toHaveLength(1)
    expect(filterCTRIBulkTrialsByDiagnosis(trials, 'diabetic')).toHaveLength(1)
  })

  it('matches a more specific diagnosis to only the relevant trial', () => {
    const result = filterCTRIBulkTrialsByDiagnosis(trials, 'nephropathy')
    expect(result).toHaveLength(1)
    expect(result[0].ctriId).toBe('CTRI/2023/11/000456')
  })

  it('returns nothing for an unrelated diagnosis', () => {
    expect(filterCTRIBulkTrialsByDiagnosis(trials, 'melanoma')).toEqual([])
  })

  it('returns nothing for an empty diagnosis rather than matching everything', () => {
    expect(filterCTRIBulkTrialsByDiagnosis(trials, '')).toEqual([])
  })
})
