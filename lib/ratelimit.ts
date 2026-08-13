/**
 * lib/ratelimit.ts
 * Postgres-backed rate limiting — see migration 019_rate_limits.sql for
 * the schema and the atomicity guarantee this relies on.
 *
 * This used to be a plain in-memory Map, documented honestly in this
 * file's own previous version as a "Phase 1... accepted tradeoff": on
 * Vercel, concurrent requests can land on different warm instances (or
 * trigger new cold starts), each with its own independent Map, so none
 * of this project's rate limits were reliably enforced once traffic
 * stopped being small enough to mostly land on one warm instance. This
 * version checks a shared Postgres table instead — genuinely shared
 * across every instance, using infrastructure this project already has
 * rather than adding a new dependency (e.g. Upstash Redis).
 *
 * API change from the in-memory version: rateLimit() and every specific
 * limiter below are now async (a DB round trip, not a Map lookup) — every
 * call site needs `await`.
 */

import { supabaseAdmin } from './supabase'

interface RateLimitResult { ok: boolean; remaining: number; resetInMs: number; message?: string }

export async function rateLimit(key: string, maxRequests: number, windowMs: number): Promise<RateLimitResult> {
  const db = supabaseAdmin()
  try {
    const { data, error } = await db.rpc('check_and_increment_rate_limit', {
      p_key: key, p_max_requests: maxRequests, p_window_ms: windowMs,
    })

    if (error || !data?.[0]) {
      // A rate limiter that's down should not take the product down with
      // it — fail OPEN (allow the request) rather than closed, same
      // reasoning already used throughout this codebase for optional
      // infrastructure (see lib/trial-criteria-cache.ts, lib/rxnorm.ts):
      // an unavailable safety net is a worse outcome to turn into a hard
      // failure than to simply not have the protection for a moment.
      // Logged so a sustained outage is visible, not silent.
      console.warn(`[ratelimit] check_and_increment_rate_limit failed for "${key}" — failing open (request allowed): ${error?.message ?? 'no rows returned'}`)
      return { ok: true, remaining: maxRequests, resetInMs: windowMs }
    }

    const row = data[0] as { allowed: boolean; remaining: number; reset_in_ms: number }
    return {
      ok: row.allowed,
      remaining: row.remaining,
      resetInMs: row.reset_in_ms,
      ...(row.allowed ? {} : { message: `Too many requests. Please wait ${Math.ceil(row.reset_in_ms / 1000)} seconds and try again.` }),
    }
  } catch (err) {
    console.warn(`[ratelimit] check_and_increment_rate_limit threw for "${key}" — failing open (request allowed): ${(err as Error).message}`)
    return { ok: true, remaining: maxRequests, resetInMs: windowMs }
  }
}

export const matchRateLimit       = (orgId: string)  => rateLimit(`match:${orgId}`,       10, 60_000)
export const abdmRateLimit        = (userId: string) => rateLimit(`abdm:${userId}`,        5, 60 * 60_000)
export const patientRateLimit     = (orgId: string)  => rateLimit(`patient:${orgId}`,     50, 60_000)
export const authRateLimit        = (ip: string)     => rateLimit(`auth:${ip}`,           10, 60 * 60_000)
export const feasibilityRateLimit = (orgId: string)  => rateLimit(`feasibility:${orgId}`, 20, 60 * 60_000)
