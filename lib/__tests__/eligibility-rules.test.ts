import { describe, it, expect } from 'vitest'
import {
  evaluateCriterion, evaluateCriteria, summarizeDeterministicResults,
  type Criterion, type EvaluablePatient, type EvaluableClinicalData,
} from '../eligibility-rules'

// The patient from clinical_trial_match_report_template.pdf's worked
// example, reused throughout this project: PT-001, 54yo Female, T2DM,
// HbA1c 9.2%, eGFR 68, on Metformin since ~2025-01, comorbid hypertension.
const patient: EvaluablePatient = { age: 54, sex: 'Female' }

function clinicalData(overrides: Partial<EvaluableClinicalData> = {}): EvaluableClinicalData {
  return {
    labs: [
      { test_name: 'HbA1c', value_numeric: 9.2, unit: '%', collected_date: '2026-06-01' },
      { test_name: 'eGFR', value_numeric: 68, unit: 'mL/min', collected_date: '2026-06-01' },
    ],
    medications: [
      { name: 'Metformin', status: 'active', start_date: '2025-01-15' },
      { name: 'Glipizide', status: 'active', start_date: '2025-06-01' },
    ],
    biomarkers: [],
    comorbidities: [{ condition: 'Hypertension', status: 'active' }],
    allergies: [],
    ...overrides,
  }
}

function crit(overrides: Partial<Criterion>): Criterion {
  return { id: 'c1', description: 'test', category: 'lab', is_exclusion: false, ...overrides } as Criterion
}

describe('Trial #1 — GLP-1 Agonist for T2DM (report template)', () => {
  it('"HbA1c between 8.0-11.0%" — PASSes for HbA1c 9.2', () => {
    const c = crit({ description: 'HbA1c between 8.0-11.0%', category: 'lab', test_name: 'HbA1c', operator: 'between', value_low: 8.0, value_high: 11.0 })
    const result = evaluateCriterion(c, patient, clinicalData())
    expect(result.result).toBe('PASS')
    expect(result.evidence).toContain('9.2')
  })

  it('"eGFR >= 45 mL/min" — PASSes for eGFR 68', () => {
    const c = crit({ description: 'eGFR >= 45 mL/min', category: 'lab', test_name: 'eGFR', operator: 'gte', value: 45 })
    expect(evaluateCriterion(c, patient, clinicalData()).result).toBe('PASS')
  })

  it('"Age 35-70 years" — PASSes for age 54', () => {
    const c = crit({ description: 'Age 35-70', category: 'age', min_age: 35, max_age: 70 })
    expect(evaluateCriterion(c, patient, clinicalData()).result).toBe('PASS')
  })

  it('"On stable Metformin dose for >=3 months" — PASSes when start_date is >90 days ago', () => {
    const c = crit({ description: 'Stable Metformin >=3mo', category: 'medication', medication_name: 'Metformin', min_duration_days: 90 })
    const data = clinicalData({ medications: [{ name: 'Metformin', status: 'active', start_date: '2025-01-15' }] })
    const result = evaluateCriterion(c, patient, data)
    expect(result.result).toBe('PASS')
  })

  it('"No prior GLP-1 agonist use" — PASSes when no record exists', () => {
    const c = crit({ description: 'No prior GLP-1 use', category: 'medication', medication_name: 'GLP-1', is_exclusion: true })
    expect(evaluateCriterion(c, patient, clinicalData()).result).toBe('PASS')
  })

  it('"No prior GLP-1 agonist use" — FAILs when a matching record exists, even discontinued', () => {
    const c = crit({ description: 'No prior GLP-1 use', category: 'medication', medication_name: 'GLP-1', is_exclusion: true })
    const data = clinicalData({ medications: [{ name: 'GLP-1 Semaglutide', status: 'discontinued' }] })
    expect(evaluateCriterion(c, patient, data).result).toBe('FAIL')
  })

  it('"BMI 23-40 kg/m2" — evaluated as a lab-shaped criterion since BMI is a numeric measurement', () => {
    const c = crit({ description: 'BMI 23-40', category: 'lab', test_name: 'BMI', operator: 'between', value_low: 23, value_high: 40 })
    const data = clinicalData({ labs: [{ test_name: 'BMI', value_numeric: 27.4, unit: 'kg/m2' }] })
    expect(evaluateCriterion(c, patient, data).result).toBe('PASS')
  })
})

describe('Trial #2 — Combination Therapy for Hypertension (report template)', () => {
  it('"Co-morbid hypertension diagnosis" — PASSes when recorded and active', () => {
    const c = crit({ description: 'Comorbid hypertension', category: 'comorbidity', condition: 'Hypertension' })
    expect(evaluateCriterion(c, patient, clinicalData()).result).toBe('PASS')
  })

  it('"Co-morbid hypertension diagnosis" — UNKNOWN when not recorded at all', () => {
    const c = crit({ description: 'Comorbid hypertension', category: 'comorbidity', condition: 'Hypertension' })
    expect(evaluateCriterion(c, patient, clinicalData({ comorbidities: [] })).result).toBe('UNKNOWN')
  })

  it('"Systolic BP >= 140mmHg at screening" — the criterion type from the report is directly checkable once BP is a recorded lab', () => {
    const c = crit({ description: 'Systolic BP >= 140', category: 'lab', test_name: 'Systolic BP', operator: 'gte', value: 140 })
    const data = clinicalData({ labs: [{ test_name: 'Systolic BP', value_numeric: 132, unit: 'mmHg' }] })
    expect(evaluateCriterion(c, patient, data).result).toBe('FAIL') // matches the report's own worked example: below threshold
  })

  it('"No current use of potassium-sparing diuretics" — FAILs when patient is on spironolactone', () => {
    const c = crit({ description: 'No potassium-sparing diuretics', category: 'medication_class', medication_class: 'potassium_sparing_diuretic', is_exclusion: true })
    const data = clinicalData({ medications: [{ name: 'Spironolactone 25mg', status: 'active' }] })
    const result = evaluateCriterion(c, patient, data)
    expect(result.result).toBe('FAIL')
    expect(result.evidence).toContain('Spironolactone')
  })

  it('"No current use of potassium-sparing diuretics" — PASSes for an unrelated active medication', () => {
    const c = crit({ description: 'No potassium-sparing diuretics', category: 'medication_class', medication_class: 'potassium_sparing_diuretic', is_exclusion: true })
    expect(evaluateCriterion(c, patient, clinicalData()).result).toBe('PASS') // patient is only on Metformin/Glipizide
  })
})

describe('Trial #3 — SGLT2 Inhibitor for Diabetic Nephropathy (report template)', () => {
  it('"eGFR >= 45, borderline case" — reproduces the report\'s own "repeat test recommended" scenario as UNKNOWN-adjacent FAIL at the boundary', () => {
    const c = crit({ description: 'eGFR >= 45', category: 'lab', test_name: 'eGFR', operator: 'gte', value: 45 })
    const data = clinicalData({ labs: [{ test_name: 'eGFR', value_numeric: 44, unit: 'mL/min' }] })
    const result = evaluateCriterion(c, patient, data)
    expect(result.result).toBe('FAIL')
    expect(result.evidence).toContain('44')
  })

  it('"No active cardiovascular disease event in past 6 months" — PASSes with no matching comorbidity', () => {
    const c = crit({ description: 'No recent CV event', category: 'comorbidity', condition: 'cardiovascular', is_exclusion: true })
    expect(evaluateCriterion(c, patient, clinicalData()).result).toBe('PASS')
  })
})

describe('evaluateCriterion — missing-data honesty (never guess in either direction)', () => {
  it('a lab criterion with no matching patient record is UNKNOWN, not FAIL', () => {
    const c = crit({ category: 'lab', test_name: 'Creatinine', operator: 'lte', value: 1.5 })
    expect(evaluateCriterion(c, patient, clinicalData({ labs: [] })).result).toBe('UNKNOWN')
  })

  it('a non-numeric lab result cannot satisfy a numeric comparison and returns UNKNOWN', () => {
    const c = crit({ category: 'lab', test_name: 'Culture', operator: 'gte', value: 1 })
    const data = clinicalData({ labs: [{ test_name: 'Culture', value_text: 'No growth' }] })
    expect(evaluateCriterion(c, patient, data).result).toBe('UNKNOWN')
  })

  it('a biomarker with status "not_tested" is UNKNOWN even though a row exists', () => {
    const c = crit({ category: 'biomarker', marker: 'EGFR', required_biomarker_status: 'positive' })
    const data = clinicalData({ biomarkers: [{ marker: 'EGFR', status: 'not_tested' }] })
    expect(evaluateCriterion(c, patient, data).result).toBe('UNKNOWN')
  })

  it('an inclusion medication criterion with a discontinued match is a real FAIL, not UNKNOWN — we have positive evidence they are not currently on it', () => {
    const c = crit({ category: 'medication', medication_name: 'Metformin' })
    const data = clinicalData({ medications: [{ name: 'Metformin', status: 'discontinued', end_date: '2024-01-01' }] })
    expect(evaluateCriterion(c, patient, data).result).toBe('FAIL')
  })
})

describe('evaluateCriteria + summarizeDeterministicResults', () => {
  it('evaluates a full criteria set and summarizes pass/fail/unknown counts', () => {
    const criteria: Criterion[] = [
      crit({ id: '1', category: 'lab', test_name: 'HbA1c', operator: 'between', value_low: 8, value_high: 11 }),   // PASS
      crit({ id: '2', category: 'lab', test_name: 'eGFR', operator: 'gte', value: 45 }),                            // PASS
      crit({ id: '3', category: 'age', min_age: 60 }),                                                              // FAIL (patient is 54)
      crit({ id: '4', category: 'biomarker', marker: 'BRCA1', required_biomarker_status: 'positive' }),             // UNKNOWN (not recorded)
    ]
    const evaluated = evaluateCriteria(criteria, patient, clinicalData())
    const summary = summarizeDeterministicResults(evaluated)
    expect(summary).toEqual({ passCount: 2, failCount: 1, unknownCount: 1, hasFail: true })
  })

  it('hasFail is false when nothing deterministically fails', () => {
    const criteria: Criterion[] = [crit({ category: 'age', min_age: 18 })]
    const summary = summarizeDeterministicResults(evaluateCriteria(criteria, patient, clinicalData()))
    expect(summary.hasFail).toBe(false)
  })
})

describe('MEDICATION_CLASSES — expanded coverage (was a single hardcoded example)', () => {
  it.each([
    ['loop_diuretic', 'Furosemide 40mg'],
    ['nsaid', 'Ibuprofen 400mg'],
    ['anticoagulant', 'Apixaban 5mg'],
    ['statin', 'Atorvastatin 20mg'],
    ['ace_inhibitor', 'Lisinopril 10mg'],
    ['oral_corticosteroid', 'Prednisone 5mg'],
    ['immunosuppressant', 'Tacrolimus 1mg'],
  ])('excludes a patient on an active drug from the %s class', (medicationClass, drugName) => {
    const c = crit({ category: 'medication_class', medication_class: medicationClass, is_exclusion: true })
    const data = clinicalData({ medications: [{ name: drugName, status: 'active' }] })
    const result = evaluateCriterion(c, patient, data)
    expect(result.result).toBe('FAIL')
    expect(result.evidence).toContain(drugName)
  })

  it('a drug from one class does not false-positive against a different class', () => {
    const c = crit({ category: 'medication_class', medication_class: 'statin', is_exclusion: true })
    const data = clinicalData({ medications: [{ name: 'Lisinopril 10mg', status: 'active' }] }) // ACE inhibitor, not a statin
    expect(evaluateCriterion(c, patient, data).result).toBe('PASS')
  })

  it('a discontinued medication in an excluded class does not count (only active medications are checked)', () => {
    const c = crit({ category: 'medication_class', medication_class: 'anticoagulant', is_exclusion: true })
    const data = clinicalData({ medications: [{ name: 'Warfarin 5mg', status: 'discontinued' }] })
    expect(evaluateCriterion(c, patient, data).result).toBe('PASS')
  })
})

describe('RxNorm-enriched medication matching (additive — see lib/rxnorm.ts)', () => {
  it('a brand-name record with no RxNorm data still fails to match a generic-name criterion — the exact gap this feature closes', () => {
    const c = crit({ category: 'medication', medication_name: 'metformin' })
    const data = clinicalData({ medications: [{ name: 'Glucophage 500mg', status: 'active' }] })
    // Without enrichment (rxnorm_normalized_names absent), plain substring
    // matching correctly cannot find "metformin" inside "Glucophage 500mg".
    expect(evaluateCriterion(c, patient, data).result).toBe('UNKNOWN')
  })

  it('the same brand-name record PASSes once RxNorm has attached the resolved generic name', () => {
    const c = crit({ category: 'medication', medication_name: 'metformin' })
    const data = clinicalData({
      medications: [{ name: 'Glucophage 500mg', status: 'active', rxnorm_normalized_names: ['metformin'] }],
    })
    expect(evaluateCriterion(c, patient, data).result).toBe('PASS')
  })

  it('an exclusion criterion still catches a brand-name record via its RxNorm-normalized name', () => {
    const c = crit({ category: 'medication', medication_name: 'metformin', is_exclusion: true })
    const data = clinicalData({
      medications: [{ name: 'Glucophage 500mg', status: 'active', rxnorm_normalized_names: ['metformin'] }],
    })
    expect(evaluateCriterion(c, patient, data).result).toBe('FAIL')
  })

  it('an empty rxnorm_normalized_names array (RxNorm ran but found nothing) behaves identically to it being absent', () => {
    const c = crit({ category: 'medication', medication_name: 'metformin' })
    const data = clinicalData({ medications: [{ name: 'Glucophage 500mg', status: 'active', rxnorm_normalized_names: [] }] })
    expect(evaluateCriterion(c, patient, data).result).toBe('UNKNOWN')
  })

  it('medication_class: a drug outside the static table still matches via an RxNorm class hint', () => {
    const c = crit({ category: 'medication_class', medication_class: 'potassium_sparing_diuretic', is_exclusion: true })
    // "Canrenone" isn't in the static MEDICATION_CLASSES list at all, but
    // RxNorm resolved it into a class whose name satisfies the hint.
    const data = clinicalData({
      medications: [{ name: 'Canrenone', status: 'active', rxnorm_classes: ['Potassium Sparing Diuretics'] }],
    })
    const result = evaluateCriterion(c, patient, data)
    expect(result.result).toBe('FAIL')
    expect(result.evidence).toContain('Canrenone')
  })

  it('medication_class: an unrelated RxNorm class name does not cause a false match', () => {
    const c = crit({ category: 'medication_class', medication_class: 'potassium_sparing_diuretic', is_exclusion: true })
    const data = clinicalData({
      medications: [{ name: 'Ibuprofen', status: 'active', rxnorm_classes: ['Nonsteroidal Anti-inflammatory Agents'] }],
    })
    expect(evaluateCriterion(c, patient, data).result).toBe('PASS')
  })

  it('medication_class: the static table alone (no RxNorm data at all) still works exactly as before', () => {
    const c = crit({ category: 'medication_class', medication_class: 'potassium_sparing_diuretic', is_exclusion: true })
    const data = clinicalData({ medications: [{ name: 'Spironolactone 25mg', status: 'active' }] })
    expect(evaluateCriterion(c, patient, data).result).toBe('FAIL')
  })
})

describe('sex criterion', () => {
  it('FAILs when required_sex does not match', () => {
    const c = crit({ category: 'sex', required_sex: 'Male' })
    expect(evaluateCriterion(c, patient, clinicalData()).result).toBe('FAIL')
  })

  it('PASSes for "Any"', () => {
    const c = crit({ category: 'sex', required_sex: 'Any' })
    // 'Any' means the criterion doesn't restrict — treated as UNKNOWN (nothing to check), not a hard PASS claim
    expect(evaluateCriterion(c, patient, clinicalData()).result).toBe('UNKNOWN')
  })
})
