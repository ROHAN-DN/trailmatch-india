import { describe, it, expect, vi } from 'vitest'
import { writeStructuredClinicalData } from '../clinical-data'

/**
 * Minimal mock matching exactly the chain shapes writeStructuredClinicalData
 * actually calls: `.from(table).delete().eq().eq()` and `.from(table).insert(rows)`,
 * both awaited directly. Records every call so tests can assert on which
 * tables were touched, in what order, and with what data — without a real
 * database (this environment has no network access to Supabase; see
 * FIXES_2026-07-11.md for why that's a hard constraint here, not a choice).
 */
function createMockDb(opts: { failTable?: string; failOn?: 'delete' | 'insert' } = {}) {
  const calls: Array<{ table: string; op: 'delete' | 'insert'; rows?: any[] }> = []
  const db = {
    from: (table: string) => ({
      delete: () => ({
        eq: () => ({
          eq: () => {
            calls.push({ table, op: 'delete' })
            if (opts.failTable === table && opts.failOn === 'delete') {
              return Promise.resolve({ error: { message: `mock delete failure on ${table}` } })
            }
            return Promise.resolve({ error: null })
          },
        }),
      }),
      insert: (rows: any[]) => {
        calls.push({ table, op: 'insert', rows })
        if (opts.failTable === table && opts.failOn === 'insert') {
          return Promise.resolve({ error: { message: `mock insert failure on ${table}` } })
        }
        return Promise.resolve({ error: null })
      },
    }),
  }
  return { db: db as any, calls }
}

const ORG = 'org-1'
const PATIENT = 'patient-1'
const USER = 'user-1'

describe('writeStructuredClinicalData', () => {
  it('only touches categories that were actually provided', async () => {
    const { db, calls } = createMockDb()
    await writeStructuredClinicalData(db, ORG, PATIENT, USER, {
      structured_labs: [{ test_name: 'HbA1c', value_numeric: 9.2 }],
      // every other category omitted entirely
    })
    const tablesTouched = new Set(calls.map(c => c.table))
    expect(tablesTouched).toEqual(new Set(['patient_labs']))
  })

  it('deletes before inserting, for the same table', async () => {
    const { db, calls } = createMockDb()
    await writeStructuredClinicalData(db, ORG, PATIENT, USER, {
      structured_labs: [{ test_name: 'HbA1c', value_numeric: 9.2 }],
    })
    const labCalls = calls.filter(c => c.table === 'patient_labs')
    expect(labCalls.map(c => c.op)).toEqual(['delete', 'insert'])
  })

  it('an empty array clears the table without inserting anything', async () => {
    const { db, calls } = createMockDb()
    await writeStructuredClinicalData(db, ORG, PATIENT, USER, {
      structured_labs: [],
    })
    const labCalls = calls.filter(c => c.table === 'patient_labs')
    expect(labCalls.map(c => c.op)).toEqual(['delete']) // no insert call at all
  })

  it('stamps every inserted row with org_id, patient_id, created_by, and source', async () => {
    const { db, calls } = createMockDb()
    await writeStructuredClinicalData(db, ORG, PATIENT, USER, {
      structured_medications: [{ name: 'Metformin', status: 'active' }],
    })
    const insertCall = calls.find(c => c.table === 'patient_medications' && c.op === 'insert')
    expect(insertCall?.rows).toEqual([{
      name: 'Metformin', status: 'active',
      org_id: ORG, patient_id: PATIENT, created_by: USER, source: 'manual',
    }])
  })

  it('writes all five categories when all are provided, each independently', async () => {
    const { db, calls } = createMockDb()
    await writeStructuredClinicalData(db, ORG, PATIENT, USER, {
      structured_labs:          [{ test_name: 'HbA1c', value_numeric: 9.2 }],
      structured_medications:   [{ name: 'Metformin', status: 'active' }],
      structured_biomarkers:    [{ marker: 'EGFR', status: 'positive' }],
      structured_comorbidities: [{ condition: 'Hypertension', status: 'active' }],
      structured_allergies:     [{ substance: 'Sulfa', severity: 'moderate' }],
    })
    const tablesTouched = new Set(calls.map(c => c.table))
    expect(tablesTouched).toEqual(new Set([
      'patient_labs', 'patient_medications', 'patient_biomarkers',
      'patient_comorbidities', 'patient_allergies',
    ]))
  })

  it('surfaces a delete failure without throwing, so the caller can decide how to handle it', async () => {
    const { db } = createMockDb({ failTable: 'patient_labs', failOn: 'delete' })
    const result = await writeStructuredClinicalData(db, ORG, PATIENT, USER, {
      structured_labs: [{ test_name: 'HbA1c', value_numeric: 9.2 }],
    })
    expect(result.error).toContain('patient_labs')
  })

  it('surfaces an insert failure distinctly from a delete failure', async () => {
    const { db } = createMockDb({ failTable: 'patient_labs', failOn: 'insert' })
    const result = await writeStructuredClinicalData(db, ORG, PATIENT, USER, {
      structured_labs: [{ test_name: 'HbA1c', value_numeric: 9.2 }],
    })
    expect(result.error).toContain('patient_labs')
  })

  it('returns no error when every provided category succeeds', async () => {
    const { db } = createMockDb()
    const result = await writeStructuredClinicalData(db, ORG, PATIENT, USER, {
      structured_labs: [{ test_name: 'HbA1c', value_numeric: 9.2 }],
    })
    expect(result.error).toBeNull()
  })
})
