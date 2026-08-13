import { describe, it, expect } from 'vitest'
import { deriveLegacyTextFields } from '../clinical-data'

describe('deriveLegacyTextFields', () => {
  it('derives labs as "test: value unit" pairs', () => {
    const result = deriveLegacyTextFields({
      structured_labs: [
        { test_name: 'HbA1c', value_numeric: 9.2, unit: '%' },
        { test_name: 'eGFR', value_numeric: 68, unit: 'mL/min' },
      ],
    })
    expect(result.labs).toBe('HbA1c: 9.2%, eGFR: 68 mL/min')
  })

  it('uses value_text when a lab has no numeric value', () => {
    const result = deriveLegacyTextFields({
      structured_labs: [{ test_name: 'Culture', value_text: 'No growth' }],
    })
    expect(result.labs).toBe('Culture: No growth')
  })

  it('splits medications into current (active) vs prior_treatments (everything else)', () => {
    const result = deriveLegacyTextFields({
      structured_medications: [
        { name: 'Metformin', dose: '500mg', status: 'active' },
        { name: 'Insulin', status: 'discontinued', end_date: '2021-03-01' },
      ],
    })
    expect(result.medications).toBe('Metformin 500mg')
    expect(result.prior_treatments).toBe('Insulin (discontinued 2021-03-01)')
  })

  it('does not set medications or prior_treatments when only one category is present', () => {
    const result = deriveLegacyTextFields({
      structured_medications: [{ name: 'Metformin', status: 'active' }],
    })
    expect(result.medications).toBe('Metformin')
    expect(result.prior_treatments).toBeUndefined()
  })

  it('formats biomarkers with +/- shorthand for positive/negative status', () => {
    const result = deriveLegacyTextFields({
      structured_biomarkers: [
        { marker: 'EGFR', status: 'positive' },
        { marker: 'ALK', status: 'negative' },
        { marker: 'PD-L1', status: 'positive', value: '30%' },
      ],
    })
    expect(result.biomarkers).toBe('EGFR+, ALK-, PD-L1+ 30%')
  })

  it('only includes active comorbidities in the derived summary', () => {
    const result = deriveLegacyTextFields({
      structured_comorbidities: [
        { condition: 'Hypertension', status: 'active' },
        { condition: 'Old fracture', status: 'resolved' },
      ],
    })
    expect(result.comorbidities).toBe('Hypertension')
  })

  it('includes reaction in parentheses for allergies when present', () => {
    const result = deriveLegacyTextFields({
      structured_allergies: [
        { substance: 'Sulfa drugs', reaction: 'Rash' },
        { substance: 'Penicillin' },
      ],
    })
    expect(result.allergies).toBe('Sulfa drugs (Rash), Penicillin')
  })

  it('returns an empty object when no structured arrays are provided', () => {
    expect(deriveLegacyTextFields({})).toEqual({})
  })

  it('does not derive a field for a category that was provided but empty', () => {
    const result = deriveLegacyTextFields({ structured_labs: [] })
    expect(result.labs).toBeUndefined()
  })

  it('reproduces the exact patient from the original report template', () => {
    // The worked example from clinical_trial_match_report_template.pdf /
    // the Trial #1 eligibility breakdown used throughout this project.
    const result = deriveLegacyTextFields({
      structured_labs: [
        { test_name: 'HbA1c', value_numeric: 9.2, unit: '%' },
        { test_name: 'eGFR', value_numeric: 68, unit: 'mL/min' },
      ],
      structured_medications: [
        { name: 'Metformin', dose: '500mg', status: 'active' },
        { name: 'Glipizide', status: 'active' },
      ],
      structured_comorbidities: [{ condition: 'Hypertension', status: 'active' }],
    })
    expect(result.labs).toBe('HbA1c: 9.2%, eGFR: 68 mL/min')
    expect(result.medications).toBe('Metformin 500mg, Glipizide')
    expect(result.comorbidities).toBe('Hypertension')
  })
})
