import { describe, it, expect, vi } from 'vitest'

vi.mock('../supabase', () => ({
  supabaseAdmin: vi.fn(),
}))

async function withMockRpc(rpcResult: any) {
  const { supabaseAdmin } = await import('../supabase')
  const rpc = vi.fn().mockResolvedValue(rpcResult)
  ;(supabaseAdmin as any).mockReturnValue({ rpc })
  const { rateLimit } = await import('../ratelimit')
  return { rateLimit, rpc }
}

describe('rateLimit — maps the Postgres function result correctly', () => {
  it('allows the request when the DB says allowed', async () => {
    const { rateLimit } = await withMockRpc({ data: [{ allowed: true, remaining: 4, reset_in_ms: 55000 }], error: null })
    const result = await rateLimit('match:org1', 5, 60000)
    expect(result).toEqual({ ok: true, remaining: 4, resetInMs: 55000 })
  })

  it('blocks the request when the DB says not allowed, with a human-readable wait message', async () => {
    const { rateLimit } = await withMockRpc({ data: [{ allowed: false, remaining: 0, reset_in_ms: 12500 }], error: null })
    const result = await rateLimit('match:org1', 5, 60000)
    expect(result.ok).toBe(false)
    expect(result.remaining).toBe(0)
    expect(result.message).toContain('13 seconds') // ceil(12500/1000)
  })

  it('calls the RPC with the exact key, max requests, and window it was given', async () => {
    const { rateLimit, rpc } = await withMockRpc({ data: [{ allowed: true, remaining: 9, reset_in_ms: 60000 }], error: null })
    await rateLimit('abdm:user42', 5, 3_600_000)
    expect(rpc).toHaveBeenCalledWith('check_and_increment_rate_limit', {
      p_key: 'abdm:user42', p_max_requests: 5, p_window_ms: 3_600_000,
    })
  })
})

describe('rateLimit — fails open (allows the request) rather than breaking the product', () => {
  it('when the RPC returns a Postgres error', async () => {
    const { rateLimit } = await withMockRpc({ data: null, error: { message: 'connection refused' } })
    const result = await rateLimit('match:org1', 5, 60000)
    expect(result.ok).toBe(true)
  })

  it('when the RPC returns no rows at all', async () => {
    const { rateLimit } = await withMockRpc({ data: [], error: null })
    const result = await rateLimit('match:org1', 5, 60000)
    expect(result.ok).toBe(true)
  })

  it('when the RPC call itself throws', async () => {
    const { supabaseAdmin } = await import('../supabase')
    ;(supabaseAdmin as any).mockReturnValue({ rpc: vi.fn().mockRejectedValue(new Error('network unreachable')) })
    const { rateLimit } = await import('../ratelimit')
    const result = await rateLimit('match:org1', 5, 60000)
    expect(result.ok).toBe(true)
  })

  it('a failed-open result never carries a blocking message', async () => {
    const { rateLimit } = await withMockRpc({ data: null, error: { message: 'timeout' } })
    const result = await rateLimit('match:org1', 5, 60000)
    expect(result.message).toBeUndefined()
  })
})

describe('the five named limiters use the documented key prefixes and limits', () => {
  it('matchRateLimit: 10 requests / 60s, keyed by org', async () => {
    const { rpc } = await withMockRpc({ data: [{ allowed: true, remaining: 9, reset_in_ms: 60000 }], error: null })
    const { matchRateLimit } = await import('../ratelimit')
    await matchRateLimit('org-abc')
    expect(rpc).toHaveBeenCalledWith('check_and_increment_rate_limit', { p_key: 'match:org-abc', p_max_requests: 10, p_window_ms: 60_000 })
  })

  it('abdmRateLimit: 5 requests / hour, keyed by user (OTP abuse prevention)', async () => {
    const { rpc } = await withMockRpc({ data: [{ allowed: true, remaining: 4, reset_in_ms: 3_600_000 }], error: null })
    const { abdmRateLimit } = await import('../ratelimit')
    await abdmRateLimit('user-xyz')
    expect(rpc).toHaveBeenCalledWith('check_and_increment_rate_limit', { p_key: 'abdm:user-xyz', p_max_requests: 5, p_window_ms: 3_600_000 })
  })
})
