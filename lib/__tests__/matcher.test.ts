/**
 * lib/__tests__/matcher.test.ts
 *
 * Regression tests for lib/matcher.ts, covering two generations of fixes:
 *
 * 1. The fabrication-fallback removal — the original implementation asked
 *    Claude to "generate 4 realistic, medically accurate example trials"
 *    and tag them "AI-Synthesised" whenever both ClinicalTrials.gov and
 *    CTRI returned zero results, with no UI anywhere checking that tag.
 *    These tests assert that behaviour cannot silently come back.
 *
 * 2. The deterministic rule engine integration — Claude now only
 *    *extracts* structured criteria (structuredCriteria) from trial text;
 *    it never renders judgment on whether the patient satisfies one.
 *    lib/eligibility-rules.ts alone decides PASS/FAIL/UNKNOWN for those,
 *    against the patient's real structured clinical data. Only genuinely
 *    non-structured criteria (interpretedCriteriaMet/Partial/Fail) carry
 *    the model's own judgment through to the final result. These tests
 *    assert that reconciliation actually happens — that a deterministic
 *    FAIL can downgrade a match's matchStrength even when the model was
 *    optimistic, that missing patient data produces an honest UNKNOWN
 *    instead of being silently dropped, and that malformed extracted
 *    criteria can't crash the request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}))

import { matchPatient, type Patient } from '../matcher'
import { createInMemoryTrialCriteriaCacheStore } from '../trial-criteria-cache'

const patient: Patient = {
  patient_code: 'PT-TEST-001',
  age:          55,
  sex:          'F',
  location:     'Bengaluru, Karnataka',
  diagnosis:    'Type 2 Diabetes Mellitus',
  labs:         'HbA1c: 9.2%, eGFR: 68',
}

function claudeReturns(json: any) {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: JSON.stringify(json) }],
  })
}

// Extraction (Call 1) and scoring (Call 2) are now genuinely separate
// Claude calls (see lib/matcher.ts's extractResidualCriteriaViaClaude) —
// Call 1 runs first, whenever any trial in the batch is a cache miss with
// real residual text after the rule-based pass. This queues that first
// response; claudeReturns above queues whatever call comes next (Call 2,
// or Call 1 again for a second trial batch in a later matchPatient call
// within the same test).
function claudeReturnsExtraction(trialsResponse: Array<{ nctId: string; structuredCriteria?: any[] }>) {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: JSON.stringify({ trials: trialsResponse }) }],
  })
}

function ctgovResponse(studies: any[]) {
  return { ok: true, status: 200, json: async () => ({ studies }) }
}

function ctriResponse(contents: string) {
  return { ok: true, status: 200, json: async () => ({ contents }) }
}

function ctriBulkExportResponse(csvText: string) {
  return { ok: true, status: 200, text: async () => csvText }
}

const REAL_TRIAL_STUDY = {
  protocolSection: {
    identificationModule:      { nctId: 'NCT99998888', briefTitle: 'GLP-1 Agonist for T2DM' },
    descriptionModule:         { briefSummary: 'A once-weekly injectable for T2DM.' },
    // Deliberately vague prose, not a templated bullet list — this fixture
    // exists to test the Claude-extraction/reconciliation path in
    // isolation. lib/rule-based-extraction.ts correctly finds nothing
    // pattern-matchable here (verified — see the dedicated
    // 'rule-based extraction integration' block below for fixtures that
    // DO use realistic templated text and confirm the rule-based path
    // itself). Using realistic bulleted criteria text here as well would
    // make the rule-based pass silently contribute criteria to every test
    // in this file, which would stop these tests from isolating what
    // they're each actually named for.
    eligibilityModule:         { eligibilityCriteria: 'Patients must meet protocol-specified criteria as determined by the treating investigator.', minimumAge: '35 Years', maximumAge: '70 Years' },
    designModule:               { phases: ['PHASE3'] },
    sponsorCollaboratorsModule: { leadSponsor: { name: 'Test Sponsor Ltd' } },
    contactsLocationsModule:    { locations: [{ country: 'India', facility: 'Test Hospital', city: 'Bengaluru' }] },
  },
}

beforeEach(() => {
  mockCreate.mockReset()
  vi.stubGlobal('fetch', vi.fn())
})

describe('matchPatient — no-fabrication guarantees', () => {
  it('never calls Claude, and returns an honest message, when both sources fail', async () => {
    ;(fetch as any).mockImplementation(async (url: string) => {
      throw new Error('network unreachable')
    })

    const result = await matchPatient(patient)

    expect(mockCreate).not.toHaveBeenCalled()
    expect(result.matches).toEqual([])
    expect(result.sourceStatus.ctgov).toBe('error')
    expect(result.sourceStatus.ctri).toBe('error')
    expect(result.summary.toLowerCase()).toContain('temporary connectivity issue')
    expect(result.summary.toLowerCase()).not.toContain('ai-synthesised')
  })

  it('never calls Claude, and reports a genuine zero-result search distinctly from a failure', async () => {
    ;(fetch as any).mockImplementation(async (url: string) => {
      if (url.includes('clinicaltrials.gov')) return ctgovResponse([])
      return ctriResponse('<html><body>no rows here</body></html>')
    })

    const result = await matchPatient(patient)

    expect(mockCreate).not.toHaveBeenCalled()
    expect(result.matches).toEqual([])
    expect(result.sourceStatus).toEqual({ ctgov: 'ok', ctri: 'ok' })
    expect(result.summary.toLowerCase()).toContain('no actively recruiting trials')
    expect(result.summary.toLowerCase()).not.toContain('ai-synthesised')
  })

  it('prepends an honest disclosure, not a silent gap, when exactly one source fails but the other has real trials', async () => {
    ;(fetch as any).mockImplementation(async (url: string) => {
      if (url.includes('clinicaltrials.gov')) return ctgovResponse([REAL_TRIAL_STUDY])
      throw new Error('CTRI proxy down')
    })

    claudeReturnsExtraction([{ nctId: 'NCT99998888', structuredCriteria: [] }]) // nothing objectively extractable from REAL_TRIAL_STUDY's deliberately vague text
    claudeReturns({
      summary: 'One strong match found.',
      matches: [{
        rank: 1, matchStrength: 'PARTIAL', matchScore: 70,
        source: 'ClinicalTrials.gov', nctId: 'NCT99998888', title: 'GLP-1 Agonist for T2DM',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: 'Matches patient diagnosis.',
        interpretedCriteriaMet: ['Age in range'], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
        nextSteps: '1. Contact PI',
      }],
      notMatched: [],
    })

    const result = await matchPatient(patient)

    expect(mockCreate).toHaveBeenCalledTimes(2) // Call 1 (extraction) + Call 2 (scoring) — see lib/matcher.ts
    expect(result.matches).toHaveLength(1)
    expect(result.sourceStatus.ctgov).toBe('ok')
    expect(result.sourceStatus.ctri).toBe('error')
    expect(result.summary).toMatch(/^Note: CTRI \(India registry\) could not be reached/)
  })

  it('treats a CAPTCHA/security-code challenge page as an honest error, not a silent zero-results success', async () => {
    ;(fetch as any).mockImplementation(async (url: string) => {
      if (url.includes('clinicaltrials.gov')) return ctgovResponse([])
      // Shaped like what CTRI's real search form actually returns when it
      // can't be satisfied by a bare GET request — a challenge page, not
      // search results. Before this check existed, this would fall
      // through to row-parsing, find zero rows, and be indistinguishable
      // from CTRI genuinely having no matching trials.
      return ctriResponse('<html><body>Please enter the Security Code shown below: <img src="captcha.jpg"></body></html>')
    })

    const result = await matchPatient(patient)

    expect(result.sourceStatus.ctri).toBe('error')
    expect(result.sourceStatus.ctgov).toBe('ok')
  })

  describe('CTRI — bulk export strategy, tried before the search-scrape fallback', () => {
    const VALID_CTRI_CSV = `CTRI_NUMBER,TRIAL_TITLE,Health Condition\nCTRI/2024/05/000321,"A Study in ${patient.diagnosis}",${patient.diagnosis}`

    it('when the bulk export is valid, it is used directly and the search-scrape is never attempted', async () => {
      ;(fetch as any).mockImplementation(async (url: string) => {
        if (url.includes('clinicaltrials.gov'))      return ctgovResponse([])
        if (url.includes('exportData.php'))           return ctriBulkExportResponse(VALID_CTRI_CSV)
        // If the code reaches the scrape fallback despite a valid bulk
        // export, this throws and fails the test — proving it didn't.
        throw new Error(`Unexpected fetch to ${url} — search-scrape should not have been attempted`)
      })
      claudeReturnsExtraction([{ nctId: 'CTRI/2024/05/000321', structuredCriteria: [] }])
      claudeReturns({ summary: 'No strong matches.', matches: [], notMatched: [] })

      const result = await matchPatient(patient)
      expect(result.sourceStatus.ctri).toBe('ok')
      expect(result.ctriCount).toBe(1)
    })

    it('when the bulk export returns unrecognisable data, falls back to the search-scrape and uses it if that succeeds', async () => {
      ;(fetch as any).mockImplementation(async (url: string) => {
        if (url.includes('clinicaltrials.gov')) return ctgovResponse([])
        if (url.includes('exportData.php'))      return ctriBulkExportResponse('completely,unrelated,columns\nfoo,bar,baz')
        if (url.includes('allorigins.win'))       return ctriResponse('<html></html>') // valid empty scrape result
        throw new Error(`Unexpected fetch to ${url}`)
      })
      claudeReturns({ summary: 'No strong matches.', matches: [], notMatched: [] })

      const result = await matchPatient(patient)
      expect(result.sourceStatus.ctri).toBe('ok') // the scrape fallback succeeded (found zero, honestly)
    })

    it('when BOTH strategies fail, reports one combined, honest error rather than swallowing either failure', async () => {
      ;(fetch as any).mockImplementation(async (url: string) => {
        if (url.includes('clinicaltrials.gov')) return ctgovResponse([])
        if (url.includes('exportData.php'))      return { ok: false, status: 404 }
        if (url.includes('allorigins.win'))       return { ok: false, status: 503 }
        throw new Error(`Unexpected fetch to ${url}`)
      })
      claudeReturns({ summary: 'No strong matches.', matches: [], notMatched: [] })

      const result = await matchPatient(patient)
      expect(result.sourceStatus.ctri).toBe('error')
      expect(result.summary).toContain('CTRI')
    })
  })

  it('structurally drops any match whose nctId was not actually retrieved, even if Claude returns one', async () => {
    ;(fetch as any).mockImplementation(async (url: string) => {
      if (url.includes('clinicaltrials.gov')) return ctgovResponse([REAL_TRIAL_STUDY])
      return ctriResponse('<html></html>')
    })

    claudeReturnsExtraction([{ nctId: 'NCT99998888', structuredCriteria: [] }])
    claudeReturns({
      summary: 'Two matches found.',
      matches: [
        {
          rank: 1, matchStrength: 'PARTIAL', matchScore: 70,
          source: 'ClinicalTrials.gov', nctId: 'NCT99998888', title: 'GLP-1 Agonist for T2DM',
          phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
          plainSummary: 'Real trial.', interpretedCriteriaMet: [], interpretedCriteriaPartial: ['HbA1c'], interpretedCriteriaFail: [],
          nextSteps: '1. Contact PI',
        },
        {
          rank: 2, matchStrength: 'STRONG', matchScore: 95,
          source: 'ClinicalTrials.gov', nctId: 'NCT00000001', title: 'A trial that was never retrieved',
          phase: 'PHASE2', sponsor: 'Fabricated Sponsor', indiaSites: 'Mumbai', status: 'Actively Recruiting',
          plainSummary: 'Fabricated.', interpretedCriteriaMet: ['Everything'], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
          nextSteps: '1. Contact PI',
        },
      ],
      notMatched: [],
    })

    const result = await matchPatient(patient)

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].nctId).toBe('NCT99998888')
    expect(result.summary).toContain('1 suggested match could not be verified')
  })

  it('passes through a normal, fully verified match untouched', async () => {
    ;(fetch as any).mockImplementation(async (url: string) => {
      if (url.includes('clinicaltrials.gov')) return ctgovResponse([REAL_TRIAL_STUDY])
      return ctriResponse('<html></html>')
    })

    claudeReturnsExtraction([{ nctId: 'NCT99998888', structuredCriteria: [] }])
    claudeReturns({
      summary: 'One strong match found for this patient.',
      matches: [{
        rank: 1, matchStrength: 'STRONG', matchScore: 92,
        source: 'ClinicalTrials.gov', nctId: 'NCT99998888', title: 'GLP-1 Agonist for T2DM',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: 'Strong match on age and HbA1c.',
        interpretedCriteriaMet: ['Age 55 in 35-70 range', 'HbA1c 9.2% in 8.0-11.0% range'],
        interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
        nextSteps: '1. Contact PI at Test Hospital',
      }],
      notMatched: [],
    })

    const result = await matchPatient(patient)

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ nctId: 'NCT99998888', matchStrength: 'STRONG', source: 'ClinicalTrials.gov' })
    expect(result.sourceStatus).toEqual({ ctgov: 'ok', ctri: 'ok' })
    expect(result.summary).not.toContain('could not be verified')
  })
})

describe('matchPatient — deterministic reconciliation (the actual point of this file)', () => {
  const realTrial = ctgovResponse([REAL_TRIAL_STUDY])
  const clinicalData = {
    labs: [{ test_name: 'HbA1c', value_numeric: 9.2, unit: '%', collected_date: '2026-06-01' }],
    medications: [],
    biomarkers: [],
    comorbidities: [],
    allergies: [],
  }

  it('a structured criterion that PASSes deterministically ends up in criteriaMet with a Verified prefix, not the model\'s own judgment', async () => {
    ;(fetch as any).mockImplementation(async (url: string) => url.includes('clinicaltrials.gov') ? realTrial : ctriResponse('<html></html>'))
    claudeReturnsExtraction([{
      nctId: 'NCT99998888',
      structuredCriteria: [
        { id: 'c1', description: 'HbA1c between 8.0-11.0%', category: 'lab', test_name: 'HbA1c', operator: 'between', value_low: 8.0, value_high: 11.0, is_exclusion: false },
      ],
    }])
    claudeReturns({
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'PARTIAL', matchScore: 80,
        source: 'ClinicalTrials.gov', nctId: 'NCT99998888', title: 'GLP-1 Agonist for T2DM',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', nextSteps: '1.',
        interpretedCriteriaMet: [], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
      }],
      notMatched: [],
    })

    const result = await matchPatient(patient, clinicalData)

    expect(result.matches[0].criteriaMet).toHaveLength(1)
    expect(result.matches[0].criteriaMet[0]).toContain('✓ Verified')
    expect(result.matches[0].criteriaMet[0]).toContain('HbA1c')
    expect(result.matches[0].criteriaFail).toHaveLength(0)
    expect(result.matches[0].deterministicResults).toHaveLength(1)
    expect(result.matches[0].deterministicResults[0].result).toBe('PASS')
  })

  it('a structured criterion that FAILs deterministically forces matchStrength to LOW even if the model said STRONG', async () => {
    ;(fetch as any).mockImplementation(async (url: string) => url.includes('clinicaltrials.gov') ? realTrial : ctriResponse('<html></html>'))
    claudeReturnsExtraction([{
      nctId: 'NCT99998888',
      structuredCriteria: [
        // patient's real HbA1c is 9.2 — this criterion requires <= 7.0, a real failure
        { id: 'c1', description: 'HbA1c <= 7.0%', category: 'lab', test_name: 'HbA1c', operator: 'lte', value: 7.0, is_exclusion: false },
      ],
    }])
    claudeReturns({
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'STRONG', matchScore: 95, // model is optimistic — the real data disagrees
        source: 'ClinicalTrials.gov', nctId: 'NCT99998888', title: 'GLP-1 Agonist for T2DM',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', nextSteps: '1.',
        interpretedCriteriaMet: [], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
      }],
      notMatched: [],
    })

    const result = await matchPatient(patient, clinicalData)

    expect(result.matches[0].matchStrength).toBe('LOW')
    expect(result.matches[0].criteriaFail).toHaveLength(1)
    expect(result.matches[0].criteriaFail[0]).toContain('✓ Verified')
  })

  it('a structured criterion with no matching patient data is UNKNOWN and lands in criteriaPartial, not silently dropped', async () => {
    ;(fetch as any).mockImplementation(async (url: string) => url.includes('clinicaltrials.gov') ? realTrial : ctriResponse('<html></html>'))
    claudeReturnsExtraction([{
      nctId: 'NCT99998888',
      structuredCriteria: [
        { id: 'c1', description: 'eGFR >= 45 mL/min', category: 'lab', test_name: 'eGFR', operator: 'gte', value: 45, is_exclusion: false },
      ],
    }])
    claudeReturns({
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'PARTIAL', matchScore: 70,
        source: 'ClinicalTrials.gov', nctId: 'NCT99998888', title: 'GLP-1 Agonist for T2DM',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', nextSteps: '1.',
        interpretedCriteriaMet: [], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
      }],
      notMatched: [],
    })

    // clinicalData has an HbA1c reading but no eGFR at all
    const result = await matchPatient(patient, clinicalData)

    expect(result.matches[0].criteriaPartial).toHaveLength(1)
    expect(result.matches[0].criteriaPartial[0]).toContain('eGFR')
    expect(result.matches[0].deterministicResults[0].result).toBe('UNKNOWN')
  })

  it('malformed structuredCriteria entries are dropped without crashing or appearing in any bucket', async () => {
    ;(fetch as any).mockImplementation(async (url: string) => url.includes('clinicaltrials.gov') ? realTrial : ctriResponse('<html></html>'))
    claudeReturnsExtraction([{
      nctId: 'NCT99998888',
      structuredCriteria: [
        { id: 'c1', description: 'A criterion with an invalid category', category: 'not_a_real_category' },
        { description: 'Missing required id field' }, // fails schema validation entirely
      ],
    }])
    claudeReturns({
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'PARTIAL', matchScore: 70,
        source: 'ClinicalTrials.gov', nctId: 'NCT99998888', title: 'GLP-1 Agonist for T2DM',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', nextSteps: '1.',
        interpretedCriteriaMet: [], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
      }],
      notMatched: [],
    })

    const result = await matchPatient(patient, clinicalData)

    // Neither malformed entry should crash the request or appear anywhere
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].deterministicResults).toHaveLength(0)
  })

  it('interpreted (non-structured) criteria pass through as the model\'s own judgment, alongside any deterministic results', async () => {
    ;(fetch as any).mockImplementation(async (url: string) => url.includes('clinicaltrials.gov') ? realTrial : ctriResponse('<html></html>'))
    claudeReturnsExtraction([{
      nctId: 'NCT99998888',
      structuredCriteria: [
        { id: 'c1', description: 'HbA1c between 8.0-11.0%', category: 'lab', test_name: 'HbA1c', operator: 'between', value_low: 8.0, value_high: 11.0, is_exclusion: false },
      ],
    }])
    claudeReturns({
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'PARTIAL', matchScore: 75,
        source: 'ClinicalTrials.gov', nctId: 'NCT99998888', title: 'GLP-1 Agonist for T2DM',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', nextSteps: '1.',
        interpretedCriteriaMet: ['Histologically confirmed diagnosis per pathology report'],
        interpretedCriteriaPartial: [],
        interpretedCriteriaFail: [],
      }],
      notMatched: [],
    })

    const result = await matchPatient(patient, clinicalData)

    // One verified (deterministic) entry + one model-interpreted entry, both in criteriaMet
    expect(result.matches[0].criteriaMet).toHaveLength(2)
    expect(result.matches[0].criteriaMet.some(c => c.includes('✓ Verified'))).toBe(true)
    expect(result.matches[0].criteriaMet.some(c => c === 'Histologically confirmed diagnosis per pathology report')).toBe(true)
  })

  it('with no clinical data on file at all, every structured criterion is UNKNOWN rather than silently skipped', async () => {
    ;(fetch as any).mockImplementation(async (url: string) => url.includes('clinicaltrials.gov') ? realTrial : ctriResponse('<html></html>'))
    claudeReturnsExtraction([{
      nctId: 'NCT99998888',
      structuredCriteria: [
        { id: 'c1', description: 'HbA1c between 8.0-11.0%', category: 'lab', test_name: 'HbA1c', operator: 'between', value_low: 8.0, value_high: 11.0, is_exclusion: false },
      ],
    }])
    claudeReturns({
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'PARTIAL', matchScore: 70,
        source: 'ClinicalTrials.gov', nctId: 'NCT99998888', title: 'GLP-1 Agonist for T2DM',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', nextSteps: '1.',
        interpretedCriteriaMet: [], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
      }],
      notMatched: [],
    })

    const result = await matchPatient(patient, null) // no structured data for this patient at all

    expect(result.matches[0].criteriaPartial).toHaveLength(1)
    expect(result.matches[0].deterministicResults[0].result).toBe('UNKNOWN')
    expect(result.matches[0].deterministicResults[0].evidence).toContain('No structured clinical data on file')
  })
})

describe('matchPatient — rule-based extraction integration', () => {
  // Realistic, templated eligibility text — deliberately the shape
  // lib/rule-based-extraction.ts is built to handle, unlike REAL_TRIAL_STUDY
  // above (which uses deliberately non-matchable prose to isolate the
  // Claude-extraction path). This is the report template's own Trial #1
  // criteria, used throughout this project.
  const templatedTrial = {
    protocolSection: {
      identificationModule:      { nctId: 'NCT11112222', briefTitle: 'GLP-1 Agonist for T2DM (templated)' },
      descriptionModule:         { briefSummary: 'A once-weekly injectable for T2DM.' },
      eligibilityModule: {
        eligibilityCriteria:
          'Inclusion Criteria:\n\n* Age 35-70 years\n* HbA1c between 8.0% and 11.0%\n\nExclusion Criteria:\n\n* Prior use of GLP-1 receptor agonist',
        minimumAge: '35 Years', maximumAge: '70 Years',
      },
      designModule:               { phases: ['PHASE3'] },
      sponsorCollaboratorsModule: { leadSponsor: { name: 'Test Sponsor Ltd' } },
      contactsLocationsModule:    { locations: [{ country: 'India', facility: 'Test Hospital', city: 'Bengaluru' }] },
    },
  }
  // Same trial, plus one statement the rule-based pass genuinely can't
  // classify — needed only by the two tests below that specifically
  // exercise Call 1 (AI extraction); templatedTrial above is fully
  // rule-based-parseable on its own (confirmed — no residual text at
  // all), so Call 1 never runs for it, and the other two tests in this
  // block correctly rely on exactly that.
  const templatedTrialWithResidual = {
    protocolSection: {
      ...templatedTrial.protocolSection,
      eligibilityModule: {
        ...templatedTrial.protocolSection.eligibilityModule,
        eligibilityCriteria: templatedTrial.protocolSection.eligibilityModule.eligibilityCriteria + '\n* Willing to attend 8 clinic visits over the study period',
      },
    },
  }
  const clinicalData = {
    labs: [{ test_name: 'HbA1c', value_numeric: 9.2, unit: '%', collected_date: '2026-06-01' }],
    medications: [],
    biomarkers: [], comorbidities: [], allergies: [],
  }

  it('evaluates rule-extracted criteria even when Claude returns zero structuredCriteria — the deterministic path does not depend on the model contributing anything', async () => {
    ;(fetch as any).mockImplementation(async (url: string) =>
      url.includes('clinicaltrials.gov') ? ctgovResponse([templatedTrial]) : ctriResponse('<html></html>'))

    // No claudeReturnsExtraction call here — templatedTrial's text is
    // fully rule-based-parseable (confirmed: zero residual statements),
    // so Call 1 never runs for it; only Call 2 (scoring) does.
    claudeReturns({
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'PARTIAL', matchScore: 75,
        source: 'ClinicalTrials.gov', nctId: 'NCT11112222', title: 'GLP-1 Agonist for T2DM (templated)',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', nextSteps: '1.',
        interpretedCriteriaMet: [], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
      }],
      notMatched: [],
    })

    const result = await matchPatient(patient, clinicalData)

    // Age (PASS, patient is 55) and HbA1c (PASS, 9.2 is in range) should
    // both be present and correctly evaluated, purely from the rule-based
    // pass, with zero contribution from Claude's response.
    expect(result.matches[0].deterministicResults.length).toBeGreaterThanOrEqual(2)
    expect(result.matches[0].deterministicResults.every(d => d.extractionSource === 'rule_based')).toBe(true)
    const hba1c = result.matches[0].deterministicResults.find(d => d.description.includes('HbA1c'))
    expect(hba1c?.result).toBe('PASS')
  })

  it('tags AI-extracted criteria distinctly from rule-based ones', async () => {
    ;(fetch as any).mockImplementation(async (url: string) =>
      url.includes('clinicaltrials.gov') ? ctgovResponse([templatedTrialWithResidual]) : ctriResponse('<html></html>'))

    // Call 1 extracts something from the genuinely residual statement —
    // a criterion the rule-based pass wouldn't have found.
    claudeReturnsExtraction([{
      nctId: 'NCT11112222',
      structuredCriteria: [
        { id: 'c1', description: 'Willing to attend 8 clinic visits', category: 'comorbidity', condition: 'clinic visit compliance', is_exclusion: false },
      ],
    }])
    claudeReturns({
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'PARTIAL', matchScore: 75,
        source: 'ClinicalTrials.gov', nctId: 'NCT11112222', title: 'GLP-1 Agonist for T2DM (templated)',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', nextSteps: '1.',
        interpretedCriteriaMet: [], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
      }],
      notMatched: [],
    })

    const result = await matchPatient(patient, clinicalData)

    const sources = result.matches[0].deterministicResults.map(d => d.extractionSource)
    expect(sources).toContain('rule_based')
    expect(sources).toContain('ai_extracted')
  })

  it('dedup safeguard: an AI-extracted criterion duplicating an already rule-extracted one is dropped, not double-counted', async () => {
    ;(fetch as any).mockImplementation(async (url: string) =>
      url.includes('clinicaltrials.gov') ? ctgovResponse([templatedTrialWithResidual]) : ctriResponse('<html></html>'))

    // Call 1 ignores the "do not duplicate" instruction and re-extracts
    // the same HbA1c criterion the rule-based pass already found.
    claudeReturnsExtraction([{
      nctId: 'NCT11112222',
      structuredCriteria: [
        { id: 'c1', description: 'HbA1c between 8.0-11.0%, redundant', category: 'lab', test_name: 'HbA1c', operator: 'between', value_low: 8.0, value_high: 11.0, is_exclusion: false },
      ],
    }])
    claudeReturns({
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'PARTIAL', matchScore: 75,
        source: 'ClinicalTrials.gov', nctId: 'NCT11112222', title: 'GLP-1 Agonist for T2DM (templated)',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', nextSteps: '1.',
        interpretedCriteriaMet: [], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
      }],
      notMatched: [],
    })

    const result = await matchPatient(patient, clinicalData)

    const hba1cResults = result.matches[0].deterministicResults.filter(d => d.description.toLowerCase().includes('hba1c'))
    expect(hba1cResults).toHaveLength(1) // not 2 — the duplicate was dropped
    expect(hba1cResults[0].extractionSource).toBe('rule_based') // the original, not the redundant AI copy
  })

  it('a rule-extracted exclusion criterion that FAILs downgrades matchStrength, exactly like an AI-extracted one does', async () => {
    ;(fetch as any).mockImplementation(async (url: string) =>
      url.includes('clinicaltrials.gov') ? ctgovResponse([templatedTrial]) : ctriResponse('<html></html>'))

    // No claudeReturnsExtraction call here — templatedTrial (not the
    // -WithResidual variant) has zero residual text; only Call 2 runs.
    claudeReturns({
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'STRONG', matchScore: 95,
        source: 'ClinicalTrials.gov', nctId: 'NCT11112222', title: 'GLP-1 Agonist for T2DM (templated)',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', nextSteps: '1.',
        interpretedCriteriaMet: [], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
      }],
      notMatched: [],
    })

    // Patient has a prior GLP-1 record — the trial's rule-extracted
    // exclusion criterion should FAIL against this, purely from the
    // rule-based pass, with no AI involvement in that determination.
    const dataWithGlp1 = { ...clinicalData, medications: [{ name: 'Semaglutide (GLP-1 receptor agonist)', status: 'discontinued' }] }
    const result = await matchPatient(patient, dataWithGlp1)

    expect(result.matches[0].matchStrength).toBe('LOW')
    const glp1Result = result.matches[0].deterministicResults.find(d => d.description.toLowerCase().includes('glp-1'))
    expect(glp1Result?.result).toBe('FAIL')
    expect(glp1Result?.extractionSource).toBe('rule_based')
  })
})

describe('matchPatient — RxNorm medication enrichment actually runs in the live matching path', () => {
  // These exist because lib/rxnorm.ts and lib/eligibility-rules.ts were
  // each unit-tested in isolation, but nothing previously proved the two
  // were actually connected through matchPatient — that connection is
  // itself the fix (see lib/rxnorm.ts's "Live wiring" section). A URL-
  // dispatching fetch mock is used here (rather than a mockResolvedValueOnce
  // queue) because CTgov, CTRI, and RxNorm are all fetched concurrently
  // inside matchPatient — a queue would be a race on call order; this
  // dispatches correctly regardless of which concurrent call reaches
  // fetch() first.
  const templatedTrial = {
    protocolSection: {
      identificationModule:      { nctId: 'NCT55556666', briefTitle: 'DPP-4 Inhibitor for T2DM' },
      descriptionModule:         { briefSummary: 'An oral DPP-4 inhibitor study.' },
      eligibilityModule: {
        eligibilityCriteria: 'Exclusion Criteria:\n\n* No current use of metformin',
        minimumAge: '35 Years', maximumAge: '70 Years',
      },
      designModule:               { phases: ['PHASE3'] },
      sponsorCollaboratorsModule: { leadSponsor: { name: 'Test Sponsor Ltd' } },
      contactsLocationsModule:    { locations: [{ country: 'India', facility: 'Test Hospital', city: 'Bengaluru' }] },
    },
  }

  function mockAllSources({ rxnormExact, rxnormClasses }: { rxnormExact?: any; rxnormClasses?: any }) {
    ;(fetch as any).mockImplementation(async (url: string) => {
      if (url.includes('clinicaltrials.gov'))  return ctgovResponse([templatedTrial])
      if (url.includes('allorigins.win'))       return ctriResponse('<html></html>')
      if (url.includes('rxcui.json'))           return { ok: true, json: async () => rxnormExact ?? { idGroup: { rxnormId: [] } } }
      if (url.includes('approximateTerm.json')) return { ok: true, json: async () => ({ approximateGroup: { candidate: [] } }) }
      if (url.includes('rxclass'))              return { ok: true, json: async () => rxnormClasses ?? { rxclassDrugInfoList: { rxclassDrugInfo: [] } } }
      throw new Error(`Unexpected fetch URL in test: ${url}`)
    })
  }

  it('a brand-name patient medication satisfies a generic-name rule-extracted exclusion, via real RxNorm resolution through matchPatient end-to-end', async () => {
    mockAllSources({
      rxnormExact: { idGroup: { name: 'metformin', rxnormId: ['6809'] } },
      rxnormClasses: { rxclassDrugInfoList: { rxclassDrugInfo: [{ rxclassMinConceptItem: { className: 'Biguanides', classId: 'BIG' } }] } },
    })
    claudeReturns({
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'STRONG', matchScore: 90,
        source: 'ClinicalTrials.gov', nctId: 'NCT55556666', title: 'DPP-4 Inhibitor for T2DM',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', nextSteps: '1.',
        structuredCriteria: [], interpretedCriteriaMet: [], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
      }],
      notMatched: [],
    })

    // Patient's medication is on file only as the BRAND name — this is
    // the realistic case (Indian pharmacy records/HMS exports commonly
    // use brand names), and the rule-extracted criterion is written with
    // the generic name, exactly as trial protocols are.
    const dataWithBrandName = {
      labs: [], biomarkers: [], comorbidities: [], allergies: [],
      medications: [{ name: 'Glucophage 500mg', status: 'active' }],
    }
    const result = await matchPatient(patient, dataWithBrandName)

    expect(result.matches[0].matchStrength).toBe('LOW') // downgraded — the exclusion criterion FAILed
    const metforminResult = result.matches[0].deterministicResults.find(d => d.description.toLowerCase().includes('metformin'))
    expect(metforminResult?.result).toBe('FAIL')
    expect(metforminResult?.evidence).toContain('Glucophage')
  })

  it('when RxNorm cannot resolve the brand name at all, evaluation degrades to exactly the same result as if this feature did not exist — a graceful no-op, not a new failure mode', async () => {
    mockAllSources({}) // every RxNorm call resolves to "nothing found"
    claudeReturns({
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'STRONG', matchScore: 90,
        source: 'ClinicalTrials.gov', nctId: 'NCT55556666', title: 'DPP-4 Inhibitor for T2DM',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', nextSteps: '1.',
        structuredCriteria: [], interpretedCriteriaMet: [], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
      }],
      notMatched: [],
    })

    const dataWithUnresolvableBrand = {
      labs: [], biomarkers: [], comorbidities: [], allergies: [],
      medications: [{ name: 'Glucophage 500mg', status: 'active' }],
    }
    const result = await matchPatient(patient, dataWithUnresolvableBrand)

    // This is an EXCLUSION criterion ("no current use of metformin").
    // With no RxNorm match, the brand-name record is invisible to it —
    // same as before this feature existed — and this file's own
    // asymmetric-confidence design (see its header) treats "no matching
    // record" for an exclusion as PASS (no evidence of the excluding
    // drug), not a guess. That's correct, unchanged, pre-existing
    // behaviour; it's not this feature failing open.
    const metforminResult = result.matches[0].deterministicResults.find(d => d.description.toLowerCase().includes('metformin'))
    expect(metforminResult?.result).toBe('PASS')
    expect(metforminResult?.evidence).toContain('No record')
  })

  it('a patient with no medications on file never calls out to RxNorm at all', async () => {
    mockAllSources({})
    claudeReturns({
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'STRONG', matchScore: 90,
        source: 'ClinicalTrials.gov', nctId: 'NCT55556666', title: 'DPP-4 Inhibitor for T2DM',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', nextSteps: '1.',
        structuredCriteria: [], interpretedCriteriaMet: [], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
      }],
      notMatched: [],
    })

    await matchPatient(patient, { labs: [], biomarkers: [], comorbidities: [], allergies: [], medications: [] })

    const rxnormCalls = (fetch as any).mock.calls.filter((c: any[]) => String(c[0]).includes('rxnav.nlm.nih.gov'))
    expect(rxnormCalls).toHaveLength(0)
  })
})

describe('matchPatient — trial-criteria cache actually gets consulted and populated', () => {
  // This is the feature lib/trial-criteria-cache.ts's own unit tests
  // can't prove by themselves: that lib/matcher.ts actually calls it, at
  // the right moments, with the right prompt behaviour change on a hit.
  // Deliberately vague, non-rule-based-parseable eligibility text (same
  // convention as REAL_TRIAL_STUDY above) so the only criterion in play
  // is the one Claude extracts — makes it unambiguous whether a given
  // match round asked Claude to extract it again or not.
  function templatedTrial(nctId: string, eligibilityCriteria: string) {
    return {
      protocolSection: {
        identificationModule:      { nctId, briefTitle: 'Cache Test Trial' },
        descriptionModule:         { briefSummary: 'A trial for testing the criteria cache.' },
        eligibilityModule:         { eligibilityCriteria, minimumAge: '18 Years', maximumAge: '75 Years' },
        designModule:               { phases: ['PHASE3'] },
        sponsorCollaboratorsModule: { leadSponsor: { name: 'Test Sponsor Ltd' } },
        contactsLocationsModule:    { locations: [{ country: 'India', facility: 'Test Hospital', city: 'Bengaluru' }] },
      },
    }
  }

  function mockFetchForTrial(trialStudy: any) {
    ;(fetch as any).mockImplementation(async (url: string) => {
      if (url.includes('clinicaltrials.gov')) return ctgovResponse([trialStudy])
      if (url.includes('allorigins.win'))      return ctriResponse('<html></html>')
      throw new Error(`Unexpected fetch URL in test: ${url}`)
    })
  }

  function claudeMatchResponse(nctId: string, extra: Record<string, any> = {}) {
    return {
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'STRONG', matchScore: 90,
        source: 'ClinicalTrials.gov', nctId, title: 'Cache Test Trial',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', nextSteps: '1.',
        structuredCriteria: [], interpretedCriteriaMet: [], interpretedCriteriaPartial: [], interpretedCriteriaFail: [],
        ...extra,
      }],
      notMatched: [],
    }
  }

  it('a genuine miss extracts via Claude AND writes the merged criteria to the cache', async () => {
    const cacheStore = createInMemoryTrialCriteriaCacheStore()
    const eligibilityText = 'Patients must meet protocol-specified HbA1c criteria as determined by the treating investigator.'
    mockFetchForTrial(templatedTrial('NCT77778888', eligibilityText))
    claudeReturnsExtraction([{
      nctId: 'NCT77778888',
      structuredCriteria: [{ id: 'c1', description: 'HbA1c between 8.0-11.0%', category: 'lab', test_name: 'HbA1c', operator: 'between', value_low: 8, value_high: 11 }],
    }])
    claudeReturns(claudeMatchResponse('NCT77778888'))

    const result = await matchPatient(patient, null, cacheStore)
    expect(result.matches[0].deterministicResults).toHaveLength(1)
    expect(result.matches[0].deterministicResults[0].extractionSource).toBe('ai_extracted')

    // The actual point of this test: the cache now has this trial's
    // criteria, keyed by the exact eligibility text hash used above.
    const crypto = await import('crypto')
    const hash = crypto.createHash('sha256').update(eligibilityText, 'utf8').digest('hex')
    const cached = await cacheStore.get('ClinicalTrials.gov', 'NCT77778888', hash)
    expect(cached?.criteria).toHaveLength(1)
    expect(cached?.criteria[0].description).toBe('HbA1c between 8.0-11.0%')
  })

  it('a second match against the same trial text is a cache hit: only one Claude call happens (scoring only, no extraction), and no second cache write happens', async () => {
    const cacheStore = createInMemoryTrialCriteriaCacheStore()
    const eligibilityText = 'Patients must meet protocol-specified HbA1c criteria as determined by the treating investigator.'

    // First match — genuine miss: Call 1 (extraction) + Call 2 (scoring).
    mockFetchForTrial(templatedTrial('NCT77778888', eligibilityText))
    claudeReturnsExtraction([{
      nctId: 'NCT77778888',
      structuredCriteria: [{ id: 'c1', description: 'HbA1c between 8.0-11.0%', category: 'lab', test_name: 'HbA1c', operator: 'between', value_low: 8, value_high: 11 }],
    }])
    claudeReturns(claudeMatchResponse('NCT77778888'))
    await matchPatient(patient, null, cacheStore)

    const setSpy = vi.spyOn(cacheStore, 'set')
    const callsBeforeSecondMatch = mockCreate.mock.calls.length // 2 — extraction + scoring

    // Second match — same trial, same eligibility text, different patient.
    // A cache hit means Call 1 never runs at all — only Call 2 (scoring).
    mockFetchForTrial(templatedTrial('NCT77778888', eligibilityText))
    claudeReturns(claudeMatchResponse('NCT77778888'))
    const secondPatient: Patient = { ...patient, patient_code: 'PT-TEST-002' }
    const result = await matchPatient(secondPatient, null, cacheStore)

    // The criterion is still there — recovered from the cache, not re-extracted.
    expect(result.matches[0].deterministicResults).toHaveLength(1)
    expect(result.matches[0].deterministicResults[0].description).toBe('HbA1c between 8.0-11.0%')
    expect(result.matches[0].deterministicResults[0].extractionSource).toBe('ai_extracted')

    // Exactly one more Claude call happened for the second match — proof
    // Call 1 (extraction) was genuinely skipped, not just that its result
    // was discarded.
    expect(mockCreate.mock.calls.length).toBe(callsBeforeSecondMatch + 1)

    // The one call that did happen used the "already known, FINAL" framing
    // every trial gets in Call 2 by the time it runs (whether from cache or
    // from Call 1 moments earlier) — never the extraction-only framing,
    // which lives entirely in Call 1's own prompt now and is never sent
    // when there's nothing left for Call 1 to do.
    const secondCallPrompt = mockCreate.mock.calls[callsBeforeSecondMatch][0].messages[0].content
    expect(secondCallPrompt).toContain('already known')
    expect(secondCallPrompt).toContain('FINAL, do not extract')
    expect(secondCallPrompt).not.toContain('Remaining eligibility statements not yet structured')

    // And a hit never re-writes the cache.
    expect(setSpy).not.toHaveBeenCalled()
  })

  it('defense in depth: Call 2 has no structuredCriteria field in its schema at all — an unsolicited one is simply never read, on a cache hit or otherwise', async () => {
    // The original version of this test exercised Call 2 "disobeying" a
    // do-not-extract instruction by returning structuredCriteria anyway.
    // That specific scenario is now structurally impossible to trigger the
    // old way — Call 2's prompt no longer even asks for that field, and
    // the reconciliation code (see lib/matcher.ts) never looks for
    // `m.structuredCriteria` on Call 2's response at all anymore, cache
    // hit or miss. What's still worth proving: if a response includes one
    // anyway (a model deciding to add an undocumented field, or a
    // malformed/adversarial response), it has zero effect either way.
    const cacheStore = createInMemoryTrialCriteriaCacheStore()
    const eligibilityText = 'Patients must meet protocol-specified HbA1c criteria as determined by the treating investigator.'

    mockFetchForTrial(templatedTrial('NCT77778888', eligibilityText))
    claudeReturnsExtraction([{
      nctId: 'NCT77778888',
      structuredCriteria: [{ id: 'c1', description: 'HbA1c between 8.0-11.0%', category: 'lab', test_name: 'HbA1c', operator: 'between', value_low: 8, value_high: 11 }],
    }])
    claudeReturns(claudeMatchResponse('NCT77778888'))
    await matchPatient(patient, null, cacheStore)

    // Second match, same trial (cache hit) — Call 2's response includes an
    // unsolicited structuredCriteria field despite the schema never asking
    // for one on this call.
    mockFetchForTrial(templatedTrial('NCT77778888', eligibilityText))
    claudeReturns(claudeMatchResponse('NCT77778888', {
      structuredCriteria: [{ id: 'c99', description: 'HbA1c 8-11%, redundant', category: 'lab', test_name: 'HbA1c', operator: 'between', value_low: 8, value_high: 11 }],
    }))
    const result = await matchPatient({ ...patient, patient_code: 'PT-TEST-003' }, null, cacheStore)

    expect(result.matches[0].deterministicResults).toHaveLength(1) // not 2 — the unsolicited field was never read
  })

  it('a changed eligibility text (protocol amendment) is a genuine miss, not a stale hit', async () => {
    const cacheStore = createInMemoryTrialCriteriaCacheStore()

    mockFetchForTrial(templatedTrial('NCT77778888', 'Patients must meet protocol-specified HbA1c criteria as determined by the treating investigator.'))
    claudeReturnsExtraction([{
      nctId: 'NCT77778888',
      structuredCriteria: [{ id: 'c1', description: 'HbA1c between 8.0-11.0%', category: 'lab', test_name: 'HbA1c', operator: 'between', value_low: 8, value_high: 11 }],
    }])
    claudeReturns(claudeMatchResponse('NCT77778888'))
    await matchPatient(patient, null, cacheStore)

    // Amended protocol text — a real, if small, wording change. A genuine
    // miss (different hash), so Call 1 runs again for this trial.
    mockFetchForTrial(templatedTrial('NCT77778888', 'Patients must meet protocol-specified HbA1c AND eGFR criteria as determined by the treating investigator.'))
    claudeReturnsExtraction([{
      nctId: 'NCT77778888',
      structuredCriteria: [
        { id: 'c1', description: 'HbA1c between 8.0-11.0%', category: 'lab', test_name: 'HbA1c', operator: 'between', value_low: 8, value_high: 11 },
        { id: 'c2', description: 'eGFR >= 45', category: 'lab', test_name: 'eGFR', operator: 'gte', value: 45 },
      ],
    }])
    claudeReturns(claudeMatchResponse('NCT77778888'))
    const result = await matchPatient({ ...patient, patient_code: 'PT-TEST-004' }, null, cacheStore)

    // Both criteria present — proves this was treated as a fresh
    // extraction (miss-path prompt), not served from the old hash's cache.
    expect(result.matches[0].deterministicResults).toHaveLength(2)
    // Call 1's prompt (the third overall call: extraction1, scoring1,
    // extraction2) is where the "remaining statements" framing lives now —
    // Call 2 never carries it, on a hit or a miss.
    const secondExtractionPrompt = mockCreate.mock.calls[2][0].messages[0].content
    expect(secondExtractionPrompt).toContain('Remaining eligibility statements not yet structured')
  })

  it('a match with no cacheStore provided behaves exactly as before this feature existed — always a miss, no caching attempted', async () => {
    const eligibilityText = 'Patients must meet protocol-specified HbA1c criteria as determined by the treating investigator.'
    mockFetchForTrial(templatedTrial('NCT77778888', eligibilityText))
    claudeReturnsExtraction([{
      nctId: 'NCT77778888',
      structuredCriteria: [{ id: 'c1', description: 'HbA1c between 8.0-11.0%', category: 'lab', test_name: 'HbA1c', operator: 'between', value_low: 8, value_high: 11 }],
    }])
    claudeReturns(claudeMatchResponse('NCT77778888'))
    const result = await matchPatient(patient, null) // no third argument at all
    expect(result.matches[0].deterministicResults).toHaveLength(1)
  })
})

describe('matchPatient — retry behaviour for transient failures', () => {
  it('recovers from a single transient failure via retry instead of reporting a false error', async () => {
    let ctgovAttempts = 0
    ;(fetch as any).mockImplementation(async (url: string) => {
      if (url.includes('clinicaltrials.gov')) {
        ctgovAttempts++
        if (ctgovAttempts === 1) throw new Error('ECONNRESET')
        return ctgovResponse([REAL_TRIAL_STUDY])
      }
      return ctriResponse('<html></html>')
    })

    claudeReturnsExtraction([{ nctId: 'NCT99998888', structuredCriteria: [] }])
    claudeReturns({
      summary: 'One match.',
      matches: [{
        rank: 1, matchStrength: 'PARTIAL', matchScore: 70,
        source: 'ClinicalTrials.gov', nctId: 'NCT99998888', title: 'GLP-1 Agonist for T2DM',
        phase: 'PHASE3', sponsor: 'Test Sponsor Ltd', indiaSites: 'Bengaluru', status: 'Actively Recruiting',
        plainSummary: '.', interpretedCriteriaMet: [], interpretedCriteriaPartial: [], interpretedCriteriaFail: [], nextSteps: '1.',
      }],
      notMatched: [],
    })

    const result = await matchPatient(patient)

    expect(ctgovAttempts).toBe(2)
    expect(result.sourceStatus.ctgov).toBe('ok')
    expect(result.matches).toHaveLength(1)
  })

  it('reports error status only after retries are exhausted, not on the first failure', async () => {
    let attempts = 0
    ;(fetch as any).mockImplementation(async (url: string) => {
      if (url.includes('clinicaltrials.gov')) {
        attempts++
        throw new Error('persistent network failure')
      }
      return ctriResponse('<html></html>')
    })

    const result = await matchPatient(patient)

    expect(attempts).toBe(2) // 1 initial + 1 retry, then gives up
    expect(result.sourceStatus.ctgov).toBe('error')
  })

  it('does not retry on a plain 4xx client error (the request itself is wrong, not transient)', async () => {
    let attempts = 0
    ;(fetch as any).mockImplementation(async (url: string) => {
      if (url.includes('clinicaltrials.gov')) {
        attempts++
        return { ok: false, status: 400, json: async () => ({}) }
      }
      return ctriResponse('<html></html>')
    })

    const result = await matchPatient(patient)

    expect(attempts).toBe(1) // no retry for a 400
    expect(result.sourceStatus.ctgov).toBe('error')
  })
})
