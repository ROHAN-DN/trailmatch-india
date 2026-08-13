/**
 * components/__tests__/MatchExplainability.test.ts
 *
 * This project has no React component-testing setup (no jsdom, no
 * Testing Library — see vitest.config.ts's `environment: 'node'` and
 * .ts-only include pattern). Adding one for a single helper function
 * would be scope creep. interpretedOnlyEntries() is pure logic with no
 * JSX/React dependency, so it's tested directly here, in the same
 * lib-style node environment as everything else.
 *
 * Why this function has a dedicated test at all: a first draft of the
 * UI change this supports used a "does the string start with
 * '✓ Verified — '" filter to separate the model's own interpreted
 * judgment from deterministic results. That looked reasonable but was
 * wrong — lib/matcher.ts's verifiedPartial (deterministic UNKNOWN
 * results) is deliberately built WITHOUT that prefix (see
 * lib/matcher.ts), so a prefix filter cannot tell a deterministic
 * UNKNOWN apart from a genuinely AI-interpreted entry. That bug would
 * have double-rendered deterministic UNKNOWN criteria a second time,
 * mislabelled as "AI INTERPRETATION" in the UI. These tests exist so
 * that specific mistake can't come back unnoticed.
 */
import { describe, it, expect } from 'vitest'
import { interpretedOnlyEntries } from '../MatchExplainability'
import type { TrialMatch } from '../../lib/types/domain'

function match(overrides: Partial<TrialMatch> = {}): TrialMatch {
  return {
    rank: 1, matchStrength: 'PARTIAL', matchScore: 70,
    source: 'ClinicalTrials.gov', nctId: 'NCT00000000', title: 'Test trial',
    phase: '', sponsor: '', indiaSites: '', status: '', plainSummary: '',
    criteriaMet: [], criteriaPartial: [], criteriaFail: [], nextSteps: '',
    ...overrides,
  }
}

describe('interpretedOnlyEntries', () => {
  it('returns nothing when every entry in every bucket is deterministic', () => {
    const m = match({
      criteriaMet:     ['✓ Verified — Age 18-65: Patient age 42'],
      criteriaFail:    ['✓ Verified — HbA1c 8-11%: 7.2'],
      criteriaPartial: ['No recorded eGFR value for this patient.'], // verified UNKNOWN — no prefix, still deterministic
      deterministicResults: [
        { description: 'Age 18-65', category: 'age', result: 'PASS', evidence: 'Patient age 42', extractionSource: 'rule_based' },
        { description: 'HbA1c 8-11%', category: 'lab', result: 'FAIL', evidence: '7.2', extractionSource: 'rule_based' },
        { description: 'eGFR', category: 'lab', result: 'UNKNOWN', evidence: 'No recorded eGFR value for this patient.', extractionSource: 'rule_based' },
      ],
    })
    // The exact regression case: the UNKNOWN entry has no "✓ Verified — "
    // prefix, identical in shape to a genuinely-interpreted string, but it
    // IS accounted for in deterministicResults, so it must NOT come back
    // here.
    expect(interpretedOnlyEntries(m)).toEqual([])
  })

  it('returns only the entries genuinely appended after the deterministic ones, per bucket', () => {
    const m = match({
      criteriaMet: [
        '✓ Verified — Age 18-65: Patient age 42',
        'Patient reports willingness to attend all visits', // genuine AI interpretation, appended after
      ],
      criteriaFail: [],
      criteriaPartial: [
        'No recorded eGFR value for this patient.', // deterministic UNKNOWN
        'Histology read is ambiguous per the report', // genuine AI interpretation, appended after
      ],
      deterministicResults: [
        { description: 'Age 18-65', category: 'age', result: 'PASS', evidence: 'Patient age 42', extractionSource: 'rule_based' },
        { description: 'eGFR', category: 'lab', result: 'UNKNOWN', evidence: 'No recorded eGFR value for this patient.', extractionSource: 'rule_based' },
      ],
    })
    expect(interpretedOnlyEntries(m)).toEqual([
      'Patient reports willingness to attend all visits',
      'Histology read is ambiguous per the report',
    ])
  })

  it('returns everything when deterministicResults is absent entirely (pre-feature legacy row)', () => {
    const m = match({
      criteriaMet: ['Some AI-judged criterion'],
      // no deterministicResults field at all
    })
    expect(interpretedOnlyEntries(m)).toEqual(['Some AI-judged criterion'])
  })

  it('returns an empty array when there is nothing in any bucket', () => {
    expect(interpretedOnlyEntries(match())).toEqual([])
  })
})
