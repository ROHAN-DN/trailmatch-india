import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isAuthorizedCronRequest, isAllowedCronMethod } from '../cron-auth'
import type { NextApiRequest } from 'next'

function mockReq(opts: { headers?: Record<string, string>; query?: Record<string, string> }): NextApiRequest {
  return {
    headers: opts.headers || {},
    query: opts.query || {},
  } as unknown as NextApiRequest
}

const REAL_SECRET = 'super-secret-value'

describe('isAuthorizedCronRequest', () => {
  const originalEnv = process.env.CRON_SECRET

  beforeEach(() => {
    process.env.CRON_SECRET = REAL_SECRET
  })

  afterEach(() => {
    process.env.CRON_SECRET = originalEnv
  })

  it('authorizes Vercel’s real native-cron header — Authorization: Bearer <secret> — this is the exact case that was broken', () => {
    const req = mockReq({ headers: { authorization: `Bearer ${REAL_SECRET}` } })
    expect(isAuthorizedCronRequest(req)).toBe(true)
  })

  it('still authorizes the legacy x-cron-secret header, for manual/pg_net triggering', () => {
    const req = mockReq({ headers: { 'x-cron-secret': REAL_SECRET } })
    expect(isAuthorizedCronRequest(req)).toBe(true)
  })

  it('still authorizes the ?secret= query param fallback', () => {
    const req = mockReq({ query: { secret: REAL_SECRET } })
    expect(isAuthorizedCronRequest(req)).toBe(true)
  })

  it('rejects a wrong bearer token', () => {
    const req = mockReq({ headers: { authorization: 'Bearer wrong-value' } })
    expect(isAuthorizedCronRequest(req)).toBe(false)
  })

  it('rejects a missing authorization entirely', () => {
    const req = mockReq({})
    expect(isAuthorizedCronRequest(req)).toBe(false)
  })

  it('rejects an authorization header that is not in Bearer form', () => {
    const req = mockReq({ headers: { authorization: REAL_SECRET } })
    expect(isAuthorizedCronRequest(req)).toBe(false)
  })

  it('never authorizes when CRON_SECRET itself is not configured, even if a value is supplied', () => {
    delete process.env.CRON_SECRET
    const req = mockReq({ headers: { authorization: `Bearer ${REAL_SECRET}` } })
    expect(isAuthorizedCronRequest(req)).toBe(false)
  })
})

describe('isAllowedCronMethod', () => {
  it('allows GET — this is what Vercel’s native cron actually sends, and was previously rejected on 3 of 5 routes', () => {
    expect(isAllowedCronMethod('GET')).toBe(true)
  })

  it('allows POST — for manual triggering and the pg_net-based alternative', () => {
    expect(isAllowedCronMethod('POST')).toBe(true)
  })

  it('rejects other methods', () => {
    expect(isAllowedCronMethod('DELETE')).toBe(false)
    expect(isAllowedCronMethod(undefined)).toBe(false)
  })
})
