import { describe, it, expect } from 'vitest'
import { generateReportPDF } from '../pdf'
import type { Patient, MatchResult } from '../matcher'

const patient: Patient = {
  patient_code: 'PT-TEST-001',
  age:          55,
  sex:          'F',
  location:     'Bengaluru, Karnataka',
  diagnosis:    'Type 2 Diabetes Mellitus',
  labs:         'HbA1c: 9.2%, eGFR: 68',
}

function result(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    summary: 'One strong match found.',
    trialsSearched: 5, ctgovCount: 3, ctriCount: 2,
    matches: [{
      rank: 1, matchStrength: 'STRONG', matchScore: 90,
      source: 'ClinicalTrials.gov', nctId: 'NCT12345678', title: 'A Study of Drug X in Type 2 Diabetes',
      phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru, Delhi', status: 'Actively Recruiting',
      plainSummary: 'This trial matches the patient\u2019s diagnosis and HbA1c range.',
      criteriaMet: ['\u2713 Verified \u2014 HbA1c between 8.0-11.0%: 9.2'], criteriaPartial: [], criteriaFail: [],
      nextSteps: '1. Contact site coordinator\n2. Schedule screening visit',
      deterministicResults: [],
    }],
    notMatched: [],
    sourceStatus: { ctgov: 'ok', ctri: 'ok' },
    ...overrides,
  }
}

function isValidPDFBuffer(buf: Buffer): boolean {
  // Every real PDF file starts with this exact 5-byte magic header —
  // the simplest, most reliable check that jsPDF actually produced a
  // real PDF and not silently-corrupt or empty output.
  return buf.subarray(0, 5).toString('ascii') === '%PDF-'
}

describe('generateReportPDF', () => {
  it('produces a real, valid PDF buffer', () => {
    const buf = generateReportPDF(patient, result())
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(isValidPDFBuffer(buf)).toBe(true)
  })

  it('produces a non-trivial file size for a report with real content', () => {
    const buf = generateReportPDF(patient, result())
    // A blank/near-empty jsPDF document is typically well under 1KB;
    // a real one-page report with text content is reliably larger —
    // this catches a regression where content silently stops being
    // written without needing to fully parse the PDF structure.
    expect(buf.length).toBeGreaterThan(1000)
  })

  it('embeds the patient code as extractable text, and the trial title in some form', () => {
    const buf = generateReportPDF(patient, result())
    const raw = buf.toString('latin1') // jsPDF's uncompressed text streams (compress defaults to false, confirmed in its own source) are readable this way
    expect(raw).toContain('PT-TEST-001')
    // The trial title may be wrapped/split across separate text-show
    // operators by jsPDF's own layout logic, so check for a substantial
    // fragment of it rather than assuming it survives as one exact
    // contiguous string — confirmed by direct inspection that the exact
    // full title is not always literally contiguous, but real title text
    // is present.
    expect(raw).toMatch(/Study of Drug/)
  })

  it('handles zero matches without throwing', () => {
    const buf = generateReportPDF(patient, result({ matches: [], summary: 'No matches found.' }))
    expect(isValidPDFBuffer(buf)).toBe(true)
  })

  it('handles a large number of matches (multi-page) without throwing', () => {
    const manyMatches = Array.from({ length: 15 }, (_, i) => ({
      rank: i + 1, matchStrength: 'PARTIAL' as const, matchScore: 60,
      source: 'ClinicalTrials.gov' as const, nctId: `NCT0000000${i}`, title: `Trial number ${i}`,
      phase: 'PHASE2', sponsor: 'Sponsor', indiaSites: 'Mumbai', status: 'Recruiting',
      plainSummary: 'Summary text.', criteriaMet: [], criteriaPartial: [], criteriaFail: [],
      nextSteps: '1. Step one', deterministicResults: [],
    }))
    const buf = generateReportPDF(patient, result({ matches: manyMatches }))
    expect(isValidPDFBuffer(buf)).toBe(true)
  })

  it('does not throw on very long free-text fields', () => {
    const longText = 'A'.repeat(5000)
    const buf = generateReportPDF(patient, result({ summary: longText }))
    expect(isValidPDFBuffer(buf)).toBe(true)
  })

  it('does not throw on special characters, unicode, or HTML-like content in patient/trial fields', () => {
    // Deliberately adversarial-shaped input — angle brackets, quotes,
    // unicode — the kind of content a real diagnosis/notes field could
    // contain, and the kind of input a ReDoS or injection-style jsPDF
    // vulnerability would need to be triggered by, if this code path
    // were exploitable through it.
    const adversarialPatient: Patient = {
      ...patient,
      diagnosis: '<script>alert(1)</script> Type 2 Diabetes — "quoted" \'text\' & special © chars 日本語',
    }
    const buf = generateReportPDF(adversarialPatient, result({ summary: '<img src=x onerror=alert(1)> normal summary text' }))
    expect(isValidPDFBuffer(buf)).toBe(true)
  })

  it('does not throw on empty/missing optional patient fields', () => {
    const minimalPatient: Patient = { patient_code: 'PT-002', age: 40, sex: 'M', location: '', diagnosis: 'Test' }
    const buf = generateReportPDF(minimalPatient, result())
    expect(isValidPDFBuffer(buf)).toBe(true)
  })

  it('includes a prescreening checklist appendix when provided, without throwing', () => {
    const buf = generateReportPDF(patient, result(), {
      prescreening: {
        nct_id: 'NCT12345678', trial_title: 'A Study of Drug X', status: 'pending',
        checklist: [
          { category: 'labs', item: 'HbA1c within last 30 days', checked: false } as any,
          { category: 'documents', item: 'Consent form signed', checked: true } as any,
        ],
      },
    })
    expect(isValidPDFBuffer(buf)).toBe(true)
  })

  it('two calls with identical input produce buffers of the same size (deterministic content, not e.g. embedding a random/current-time-dependent element that would change size)', () => {
    const bufA = generateReportPDF(patient, result())
    const bufB = generateReportPDF(patient, result())
    // Not byte-identical (PDF generation timestamps in file metadata are
    // expected to differ), but length should be stable for identical
    // content — a meaningful smoke test that generation is consistent.
    expect(Math.abs(bufA.length - bufB.length)).toBeLessThan(50)
  })
})
