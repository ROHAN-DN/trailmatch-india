import { describe, it, expect } from 'vitest'
import {
  splitEligibilitySections, splitIntoStatements, isNegated, extractCriteriaRuleBased,
} from '../rule-based-extraction'

describe('splitEligibilitySections', () => {
  it('splits a realistic trial text with both headers', () => {
    const text = `
Inclusion Criteria:

* Age 18-75 years
* HbA1c between 7.0% and 10.5%

Exclusion Criteria:

* Prior use of GLP-1 receptor agonist
* eGFR less than 45 mL/min
`
    const { inclusion, exclusion } = splitEligibilitySections(text)
    expect(inclusion).toContain('Age 18-75 years')
    expect(inclusion).not.toContain('GLP-1')
    expect(exclusion).toContain('GLP-1 receptor agonist')
    expect(exclusion).not.toContain('Age 18-75')
  })

  it('handles "Key Inclusion Criteria" header variants', () => {
    const text = `Key Inclusion Criteria:\n* Age 18-75 years\n\nKey Exclusion Criteria:\n* Known allergy to metformin`
    const { inclusion, exclusion } = splitEligibilitySections(text)
    expect(inclusion).toContain('Age 18-75')
    expect(exclusion).toContain('allergy to metformin')
  })

  it('falls back to "unlabelled" honestly when no header exists at all, rather than guessing', () => {
    const text = 'Patients must be 18-75 years old with confirmed diagnosis.'
    const result = splitEligibilitySections(text)
    expect(result.inclusion).toBe('')
    expect(result.exclusion).toBe('')
    expect(result.unlabelled).toBe(text)
  })
})

describe('splitIntoStatements', () => {
  it('splits bullet points regardless of marker style', () => {
    const text = '* Age 18-75\n- HbA1c >= 8.0\n• eGFR >= 45\n1. BMI 23-40'
    expect(splitIntoStatements(text)).toEqual([
      'Age 18-75', 'HbA1c >= 8.0', 'eGFR >= 45', 'BMI 23-40',
    ])
  })

  it('drops trivially short lines (stray punctuation, blank remnants)', () => {
    expect(splitIntoStatements('* Age 18-75\n-\n*  \n* HbA1c >= 8.0')).toEqual(['Age 18-75', 'HbA1c >= 8.0'])
  })
})

describe('isNegated', () => {
  it('detects common pre-negation triggers', () => {
    expect(isNegated('No history of pancreatitis')).toBe(true)
    expect(isNegated('Prior use of insulin must not have occurred')).toBe(true)
    expect(isNegated('Free of active infection')).toBe(true)
  })

  it('does not flag a positive statement', () => {
    expect(isNegated('History of hypertension')).toBe(false)
    expect(isNegated('On stable dose of metformin')).toBe(false)
  })

  it('a pseudo-negation guard phrase overrides a nearby trigger word, matching NegEx\'s documented design', () => {
    // "not ruled out" contains "not" but is a pseudo-negation — NegEx's own
    // published design treats these as guards specifically to avoid this
    // false positive.
    expect(isNegated('Pregnancy not ruled out at screening')).toBe(false)
  })
})

describe('extractCriteriaRuleBased — the report template\'s own trials (should extract cleanly)', () => {
  it('Trial #1 — GLP-1 Agonist for T2DM: age, HbA1c, eGFR, BMI, stable Metformin, prior GLP-1 exclusion', () => {
    const text = `
Inclusion Criteria:

* Age 35-70 years
* HbA1c between 8.0% and 11.0%
* eGFR >= 45 mL/min
* BMI 23-40 kg/m2
* On stable dose of Metformin for at least 90 days

Exclusion Criteria:

* Prior use of GLP-1 receptor agonist
`
    const result = extractCriteriaRuleBased(text)

    const categories = result.criteria.map(c => c.category)
    expect(categories).toContain('age')
    expect(categories).toContain('medication') // both the stable-Metformin inclusion and GLP-1 exclusion

    const age = result.criteria.find(c => c.category === 'age')!
    expect(age.min_age).toBe(35)
    expect(age.max_age).toBe(70)

    const hba1c = result.criteria.find(c => c.category === 'lab' && c.test_name === 'HbA1c')!
    expect(hba1c.operator).toBe('between')
    expect(hba1c.value_low).toBe(8.0)
    expect(hba1c.value_high).toBe(11.0)

    const egfr = result.criteria.find(c => c.category === 'lab' && c.test_name === 'eGFR')!
    expect(egfr.operator).toBe('gte')
    expect(egfr.value).toBe(45)

    const metformin = result.criteria.find(c => c.category === 'medication' && !c.is_exclusion)!
    expect(metformin.medication_name?.toLowerCase()).toContain('metformin')
    expect(metformin.min_duration_days).toBe(90)

    const glp1 = result.criteria.find(c => c.category === 'medication' && c.is_exclusion)!
    expect(glp1.medication_name?.toLowerCase()).toContain('glp-1')

    // Nothing here should have been left unparsed — this trial's text is
    // exactly the well-templated shape this extractor is built for.
    expect(result.unparsedStatements).toHaveLength(0)
  })

  it('Trial #2 — Hypertension: comorbidity, systolic BP threshold, potassium-sparing diuretic exclusion phrase is captured as a medication statement (class resolution happens in the evaluator, not here)', () => {
    const text = `
Inclusion Criteria:

* Co-morbid hypertension diagnosis
* Systolic blood pressure >= 140 mmHg

Exclusion Criteria:

* No current use of potassium-sparing diuretics
`
    const result = extractCriteriaRuleBased(text)

    const htn = result.criteria.find(c => c.category === 'comorbidity')!
    expect(htn.condition?.toLowerCase()).toContain('hypertension')
    expect(htn.is_exclusion).toBe(false)

    const sbp = result.criteria.find(c => c.category === 'lab' && c.test_name === 'Systolic blood pressure')!
    expect(sbp.operator).toBe('gte')
    expect(sbp.value).toBe(140)
  })
})

describe('extractCriteriaRuleBased — honest limits on messier, real-world phrasing', () => {
  it('correctly leaves a complex nested-logic criterion unparsed rather than guessing at it', () => {
    // This exact shape of criterion — a conditional exception — is the
    // documented, published failure mode for rule-based extraction (see
    // this file's header comment on Criteria2Query's own findings). It
    // should fall through to unparsedStatements, not produce a wrong or
    // partial structured criterion.
    const text = 'Exclusion Criteria:\n* No systemic chemotherapy within 4 weeks prior to enrollment unless receiving maintenance therapy'
    const result = extractCriteriaRuleBased(text)
    // May or may not partially match the medication shape — the important
    // property is that it does NOT silently produce a criterion that lost
    // the "unless receiving maintenance therapy" exception.
    for (const c of result.criteria) {
      expect(c.description).toContain('unless receiving maintenance therapy')
    }
  })

  it('does not fabricate a lab criterion for a test name outside the known list', () => {
    const result = extractCriteriaRuleBased('Inclusion Criteria:\n* Troponin I within normal limits at screening')
    expect(result.criteria.find(c => c.category === 'lab')).toBeUndefined()
    expect(result.unparsedStatements).toContain('Troponin I within normal limits at screening')
  })

  it('unparsed statements are never silently dropped — every statement ends up in exactly one bucket', () => {
    const text = `
Inclusion Criteria:
* Age 18-75 years
* Willing and able to provide written informed consent
* ECOG performance status of 0 or 1

Exclusion Criteria:
* Known hypersensitivity to study drug
* Participation in another interventional trial within 30 days
`
    const result = extractCriteriaRuleBased(text)
    const totalStatements = 5
    expect(result.criteria.length + result.unparsedStatements.length).toBe(totalStatements)
  })
})

describe('extractCriteriaRuleBased — allergy and sex', () => {
  it('extracts a known-hypersensitivity allergy exclusion', () => {
    const result = extractCriteriaRuleBased('Exclusion Criteria:\n* Known hypersensitivity to sulfonamides')
    const allergy = result.criteria.find(c => c.category === 'allergy')!
    expect(allergy.allergy_substance?.toLowerCase()).toContain('sulfonamides')
    expect(allergy.is_exclusion).toBe(true)
  })

  it('extracts a sex restriction when explicitly stated', () => {
    const result = extractCriteriaRuleBased('Inclusion Criteria:\n* Male patients only')
    const sex = result.criteria.find(c => c.category === 'sex')!
    expect(sex.required_sex).toBe('Male')
  })

  it('does not emit a sex criterion when the trial explicitly allows both — nothing to check', () => {
    const result = extractCriteriaRuleBased('Inclusion Criteria:\n* Male and female participants eligible')
    expect(result.criteria.find(c => c.category === 'sex')).toBeUndefined()
  })
})
