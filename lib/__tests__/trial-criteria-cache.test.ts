import { describe, it, expect, vi } from 'vitest'
import {
  hashEligibilityText,
  createInMemoryTrialCriteriaCacheStore,
  createSupabaseTrialCriteriaCacheStore,
  type CacheableTrialSource,
} from '../trial-criteria-cache'
import type { Criterion } from '../eligibility-rules'

function crit(overrides: Partial<Criterion> & { id: string }): Criterion {
  return { description: 'test criterion', category: 'age', is_exclusion: false, ...overrides } as Criterion
}

describe('hashEligibilityText', () => {
  it('is stable for the same text', () => {
    const text = 'Inclusion Criteria:\n* Age 18-65\n* HbA1c 8-11%'
    expect(hashEligibilityText(text)).toBe(hashEligibilityText(text))
  })

  it('differs for different text — this is what makes the cache self-invalidate on a protocol amendment', () => {
    const original = 'Inclusion Criteria:\n* Age 18-65'
    const amended   = 'Inclusion Criteria:\n* Age 18-70' // one character changed
    expect(hashEligibilityText(original)).not.toBe(hashEligibilityText(amended))
  })

  it('produces a hex sha256 digest (64 hex characters)', () => {
    expect(hashEligibilityText('anything')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('createInMemoryTrialCriteriaCacheStore', () => {
  it('is a miss for a trial that was never cached', async () => {
    const store = createInMemoryTrialCriteriaCacheStore()
    expect(await store.get('ClinicalTrials.gov', 'NCT00000001', 'somehash')).toBeNull()
  })

  it('is a hit after set(), with the exact same hash', async () => {
    const store = createInMemoryTrialCriteriaCacheStore()
    const criteria = [crit({ id: 'rule-1', category: 'age', min_age: 18 })]
    await store.set('ClinicalTrials.gov', 'NCT00000001', 'hash-a', criteria)

    const result = await store.get('ClinicalTrials.gov', 'NCT00000001', 'hash-a')
    expect(result?.criteria).toEqual(criteria)
    expect(result?.extractedAt).toBeTruthy()
  })

  it('is a miss when the hash differs — the exact case a protocol amendment produces', async () => {
    const store = createInMemoryTrialCriteriaCacheStore()
    await store.set('ClinicalTrials.gov', 'NCT00000001', 'hash-old', [crit({ id: 'rule-1' })])
    expect(await store.get('ClinicalTrials.gov', 'NCT00000001', 'hash-new')).toBeNull()
  })

  it('does not confuse the same trial ID across different sources', async () => {
    const store = createInMemoryTrialCriteriaCacheStore()
    await store.set('ClinicalTrials.gov', 'SAME-ID', 'hash-a', [crit({ id: 'rule-1', description: 'ctgov version' })])
    await store.set('CTRI', 'SAME-ID', 'hash-a', [crit({ id: 'rule-2', description: 'ctri version' })])

    const ctgovResult = await store.get('ClinicalTrials.gov', 'SAME-ID', 'hash-a')
    const ctriResult  = await store.get('CTRI', 'SAME-ID', 'hash-a')
    expect(ctgovResult?.criteria[0].description).toBe('ctgov version')
    expect(ctriResult?.criteria[0].description).toBe('ctri version')
  })

  it('a second set() for the same trial with a new hash overwrites, not appends', async () => {
    const store = createInMemoryTrialCriteriaCacheStore()
    await store.set('ClinicalTrials.gov', 'NCT1', 'hash-1', [crit({ id: 'rule-1' })])
    await store.set('ClinicalTrials.gov', 'NCT1', 'hash-2', [crit({ id: 'rule-1' }), crit({ id: 'rule-2' })])

    expect(await store.get('ClinicalTrials.gov', 'NCT1', 'hash-1')).toBeNull() // old hash no longer matches
    const result = await store.get('ClinicalTrials.gov', 'NCT1', 'hash-2')
    expect(result?.criteria).toHaveLength(2)
  })
})

/**
 * Minimal mock matching exactly the chain shapes
 * createSupabaseTrialCriteriaCacheStore actually calls — same convention
 * as lib/__tests__/clinical-data-write.test.ts's createMockDb: only the
 * real call shapes, not a general-purpose Supabase mock.
 */
function createMockDb(opts: {
  selectResult?: { data: any; error: any }
  upsertResult?: { error: any }
} = {}) {
  const eqCalls: string[][] = []
  let upsertArgs: { row: any; options: any } | null = null

  const db = {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (col: string, val: string) => {
          eqCalls.push([col, val])
          const chain = {
            eq: (col2: string, val2: string) => {
              eqCalls.push([col2, val2])
              return chain
            },
            maybeSingle: async () => opts.selectResult ?? { data: null, error: null },
          }
          return chain
        },
      }),
      upsert: (row: any, options: any) => {
        upsertArgs = { row, options }
        return Promise.resolve(opts.upsertResult ?? { error: null })
      },
    }),
  }
  return { db: db as any, eqCalls, getUpsertArgs: () => upsertArgs }
}

describe('createSupabaseTrialCriteriaCacheStore — get()', () => {
  it('returns the cached criteria when a row is found and validates', async () => {
    const criteria = [crit({ id: 'rule-1', category: 'age', min_age: 18 })]
    const { db } = createMockDb({ selectResult: { data: { criteria, extracted_at: '2026-07-20T00:00:00Z' }, error: null } })
    const store = createSupabaseTrialCriteriaCacheStore(db)

    const result = await store.get('ClinicalTrials.gov', 'NCT1', 'hash-a')
    expect(result?.criteria).toEqual(criteria)
    expect(result?.extractedAt).toBe('2026-07-20T00:00:00Z')
  })

  it('filters on source, trial_id, AND eligibility_text_hash — all three, not just trial ID', async () => {
    const { db, eqCalls } = createMockDb({ selectResult: { data: null, error: null } })
    const store = createSupabaseTrialCriteriaCacheStore(db)
    await store.get('CTRI', 'CTRI/2024/01/000001', 'somehash')

    expect(eqCalls).toEqual([
      ['source', 'CTRI'],
      ['trial_id', 'CTRI/2024/01/000001'],
      ['eligibility_text_hash', 'somehash'],
    ])
  })

  it('returns null (not a throw) on a DB error', async () => {
    const { db } = createMockDb({ selectResult: { data: null, error: { message: 'connection lost' } } })
    const store = createSupabaseTrialCriteriaCacheStore(db)
    expect(await store.get('ClinicalTrials.gov', 'NCT1', 'hash-a')).toBeNull()
  })

  it('returns null when no row matches (genuine miss)', async () => {
    const { db } = createMockDb({ selectResult: { data: null, error: null } })
    const store = createSupabaseTrialCriteriaCacheStore(db)
    expect(await store.get('ClinicalTrials.gov', 'NCT1', 'hash-a')).toBeNull()
  })

  it('returns null (not a throw, not trusted data) when the stored criteria column fails validation', async () => {
    const { db } = createMockDb({
      selectResult: { data: { criteria: [{ not: 'a valid criterion' }], extracted_at: '2026-07-20T00:00:00Z' }, error: null },
    })
    const store = createSupabaseTrialCriteriaCacheStore(db)
    expect(await store.get('ClinicalTrials.gov', 'NCT1', 'hash-a')).toBeNull()
  })

  it('returns null (not a throw) if the underlying client throws synchronously', async () => {
    const db = { from: () => { throw new Error('client misconfigured') } } as any
    const store = createSupabaseTrialCriteriaCacheStore(db)
    expect(await store.get('ClinicalTrials.gov', 'NCT1', 'hash-a')).toBeNull()
  })
})

describe('createSupabaseTrialCriteriaCacheStore — set()', () => {
  it('upserts with the composite (source, trial_id) conflict target', async () => {
    const { db, getUpsertArgs } = createMockDb()
    const store = createSupabaseTrialCriteriaCacheStore(db)
    await store.set('ClinicalTrials.gov', 'NCT1', 'hash-a', [crit({ id: 'rule-1' })])

    expect(getUpsertArgs()?.options).toEqual({ onConflict: 'source,trial_id' })
  })

  it('computes rule_based_count and ai_extracted_count from each criterion id\'s "rule-" prefix', async () => {
    const { db, getUpsertArgs } = createMockDb()
    const store = createSupabaseTrialCriteriaCacheStore(db)
    await store.set('ClinicalTrials.gov', 'NCT1', 'hash-a', [
      crit({ id: 'rule-1' }), crit({ id: 'rule-2' }), crit({ id: 'c1' }),
    ])

    const row = getUpsertArgs()?.row
    expect(row.rule_based_count).toBe(2)
    expect(row.ai_extracted_count).toBe(1)
    expect(row.source).toBe('ClinicalTrials.gov')
    expect(row.trial_id).toBe('NCT1')
    expect(row.eligibility_text_hash).toBe('hash-a')
  })

  it('does not throw when the upsert itself errors — a write failure must never break a match already returned', async () => {
    const { db } = createMockDb({ upsertResult: { error: { message: 'unique violation or whatever' } } })
    const store = createSupabaseTrialCriteriaCacheStore(db)
    await expect(store.set('ClinicalTrials.gov', 'NCT1', 'hash-a', [crit({ id: 'rule-1' })])).resolves.toBeUndefined()
  })

  it('does not throw if the underlying client throws synchronously', async () => {
    const db = { from: () => { throw new Error('client misconfigured') } } as any
    const store = createSupabaseTrialCriteriaCacheStore(db)
    await expect(store.set('ClinicalTrials.gov', 'NCT1', 'hash-a', [crit({ id: 'rule-1' })])).resolves.toBeUndefined()
  })
})
