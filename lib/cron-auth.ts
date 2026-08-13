/**
 * lib/cron-auth.ts
 *
 * Shared auth + method check for every pages/api/cron/*.ts route.
 *
 * REAL BUG FOUND AND FIXED HERE (pre-deployment check, not from any
 * prior session's notes): vercel.json registers all 5 of this project's
 * cron routes as native Vercel Cron Jobs. Vercel's native cron always
 * invokes with:
 *   - method: GET
 *   - header: Authorization: Bearer <CRON_SECRET>
 * — never a custom `x-cron-secret` header, and never POST.
 *
 * Every one of the 5 routes was written checking only `x-cron-secret`
 * (which makes sense for the Supabase pg_cron + pg_net alternative some
 * of these routes' own header comments describe), and 3 of the 5
 * (rematch, mrr-snapshot, data-retention) additionally rejected anything
 * but POST with a 405. As configured, none of the 5 scheduled jobs
 * could have successfully run via vercel.json's native cron — every
 * real invocation would fail with 401 or 405, silently, since nothing
 * in this project watches Vercel's function logs for that. One of the
 * five (data-retention) is the DPDP Act storage-minimisation job, so
 * this wasn't just a missed feature — it was a silently-unmet
 * compliance obligation.
 *
 * This accepts EITHER triggering mechanism this codebase documents, so
 * whichever one you actually use, it works:
 *   - Authorization: Bearer <CRON_SECRET>   — Vercel's real native-cron header (GET)
 *   - x-cron-secret: <CRON_SECRET>          — this project's original header, for manual testing or a pg_net-based POST
 *   - ?secret=<CRON_SECRET>                 — query-param fallback for manual browser/curl testing
 *
 * isAuthorizedCronRequest returns false (not throws) if CRON_SECRET
 * itself isn't configured — a missing secret must never be treated as
 * "anything goes."
 */
import type { NextApiRequest } from 'next'

export function isAuthorizedCronRequest(req: NextApiRequest): boolean {
  const configured = process.env.CRON_SECRET
  if (!configured) return false

  const authHeader = req.headers['authorization']
  const bearerSecret =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : null

  const legacyHeader = req.headers['x-cron-secret']
  const legacySecret = typeof legacyHeader === 'string' ? legacyHeader : null

  const querySecret = typeof req.query.secret === 'string' ? req.query.secret : null

  const provided = bearerSecret || legacySecret || querySecret
  return provided !== null && provided === configured
}

/** Vercel's native cron sends GET; the pg_net examples in this repo send POST. Accept both, reject everything else. */
export function isAllowedCronMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'POST'
}
