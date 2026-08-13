import { describe, it, expect, vi } from 'vitest'
import { checkLimit, checkMonthlyMatchJobLimit } from '../gate'

/**
 * Minimal mock matching exactly the two query shapes checkLimit calls —
 * same convention as lib/__tests__/clinical-data-write.test.ts's
 * createMockDb. The count-style query (`.select(..., {count, head}).eq().eq()`)
 * is itself awaited directly by the real code (no `.single()` or
 * `.maybeSingle()` at the end), so the mock's eq() chain must itself be
 * thenable.
 */
function createMockDb(opts: { org: any; count: number | null }) {
  const db = {
    from: (table: string) => {
      if (table === 'organizations') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: opts.org }),
            }),
          }),
        }
      }
      // 'patients' or 'users' — the count-style query
      return {
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ count: opts.count }),
          }),
        }),
      }
    },
  }
  return db as any
}

vi.mock('../supabase', () => ({
  supabaseAdmin: vi.fn(),
}))

async function checkLimitWithMockDb(mockDb: any, org_id: string, metric: 'patients' | 'users', additionalCount?: number) {
  const { supabaseAdmin } = await import('../supabase')
  ;(supabaseAdmin as any).mockReturnValue(mockDb)
  return checkLimit(org_id, metric, additionalCount)
}

describe('checkLimit — original single-item behaviour is unchanged', () => {
  it('allows adding one more when current < limit', async () => {
    const db = createMockDb({ org: { plan: 'trial', max_patients: 10 }, count: 9 })
    const result = await checkLimitWithMockDb(db, 'org1', 'patients')
    expect(result.allowed).toBe(true)
  })

  it('blocks adding one more when current === limit (the boundary)', async () => {
    const db = createMockDb({ org: { plan: 'trial', max_patients: 10 }, count: 10 })
    const result = await checkLimitWithMockDb(db, 'org1', 'patients')
    expect(result.allowed).toBe(false)
    expect(result.message).toContain('10 patients')
  })

  it('always allows on an unlimited (-1) plan regardless of current count', async () => {
    const db = createMockDb({ org: { plan: 'enterprise', max_patients: -1 }, count: 99999 })
    const result = await checkLimitWithMockDb(db, 'org1', 'patients')
    expect(result.allowed).toBe(true)
  })

  it('checks the users table and max_users for the users metric', async () => {
    const db = createMockDb({ org: { plan: 'trial', max_users: 2 }, count: 2 })
    const result = await checkLimitWithMockDb(db, 'org1', 'users')
    expect(result.allowed).toBe(false)
    expect(result.message).toContain('team members')
  })
})

describe('checkLimit — additionalCount (needed for batch operations)', () => {
  it('allows a batch that exactly fills remaining room', async () => {
    const db = createMockDb({ org: { plan: 'trial', max_patients: 10 }, count: 7 })
    const result = await checkLimitWithMockDb(db, 'org1', 'patients', 3)
    expect(result.allowed).toBe(true)
  })

  it('blocks a batch that would exceed the limit by even one', async () => {
    const db = createMockDb({ org: { plan: 'trial', max_patients: 10 }, count: 7 })
    const result = await checkLimitWithMockDb(db, 'org1', 'patients', 4)
    expect(result.allowed).toBe(false)
  })

  it('the blocked message for a batch reports how much room is actually left', async () => {
    const db = createMockDb({ org: { plan: 'trial', max_patients: 10 }, count: 7 })
    const result = await checkLimitWithMockDb(db, 'org1', 'patients', 5)
    expect(result.message).toContain('room for 3 more')
  })

  it('an unlimited plan allows an arbitrarily large batch', async () => {
    const db = createMockDb({ org: { plan: 'enterprise', max_patients: -1 }, count: 500 })
    const result = await checkLimitWithMockDb(db, 'org1', 'patients', 200)
    expect(result.allowed).toBe(true)
  })

  it('additionalCount=1 (the default) behaves identically to omitting it entirely', async () => {
    const db1 = createMockDb({ org: { plan: 'trial', max_patients: 10 }, count: 10 })
    const db2 = createMockDb({ org: { plan: 'trial', max_patients: 10 }, count: 10 })
    const withDefault  = await checkLimitWithMockDb(db1, 'org1', 'patients')
    const withExplicit = await checkLimitWithMockDb(db2, 'org1', 'patients', 1)
    expect(withDefault.allowed).toBe(withExplicit.allowed)
  })
})

/** Matches checkMonthlyMatchJobLimit's exact query shapes — .eq().single() for the org row, .eq().gte() (thenable, no terminal method) for the windowed count. */
function createMockDbForMonthlyLimit(opts: { org: any; count: number | null }) {
  const db = {
    from: (table: string) => {
      if (table === 'organizations') {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: opts.org }) }) }) }
      }
      // 'match_jobs' — .select(...).eq('org_id', ...).gte('created_at', ...)
      return { select: () => ({ eq: () => ({ gte: () => Promise.resolve({ count: opts.count }) }) }) }
    },
  }
  return db as any
}

async function checkMonthlyMatchJobLimitWithMockDb(mockDb: any, org_id: string) {
  const { supabaseAdmin } = await import('../supabase')
  ;(supabaseAdmin as any).mockReturnValue(mockDb)
  return checkMonthlyMatchJobLimit(org_id)
}

describe('checkMonthlyMatchJobLimit', () => {
  it('allows a job when this month\'s count is under the plan limit', async () => {
    const db = createMockDbForMonthlyLimit({ org: { plan: 'trial', max_match_jobs_per_month: 5 }, count: 3 })
    const result = await checkMonthlyMatchJobLimitWithMockDb(db, 'org1')
    expect(result.allowed).toBe(true)
  })

  it('blocks a job once this month\'s count has reached the plan limit', async () => {
    const db = createMockDbForMonthlyLimit({ org: { plan: 'trial', max_match_jobs_per_month: 5 }, count: 5 })
    const result = await checkMonthlyMatchJobLimitWithMockDb(db, 'org1')
    expect(result.allowed).toBe(false)
    expect(result.message).toContain('5 match jobs this month')
    expect(result.upgrade).toBe('starter')
  })

  it('an unlimited plan (-1) is always allowed regardless of count', async () => {
    const db = createMockDbForMonthlyLimit({ org: { plan: 'pro', max_match_jobs_per_month: -1 }, count: 9999 })
    const result = await checkMonthlyMatchJobLimitWithMockDb(db, 'org1')
    expect(result.allowed).toBe(true)
  })

  it('a starter-plan org past its trial-era usage is unaffected — checks against ITS OWN plan\'s limit, not a hardcoded one', async () => {
    const db = createMockDbForMonthlyLimit({ org: { plan: 'starter', max_match_jobs_per_month: -1 }, count: 50 })
    const result = await checkMonthlyMatchJobLimitWithMockDb(db, 'org1')
    expect(result.allowed).toBe(true)
  })
})
