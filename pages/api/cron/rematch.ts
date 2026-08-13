/**
 * pages/api/cron/rematch.ts
 *
 * Triggered every Sunday at 01:00 UTC by the native Vercel Cron entry in
 * vercel.json (Vercel invokes with GET + Authorization: Bearer
 * CRON_SECRET). Also runnable manually, or via Supabase pg_cron +
 * pg_net, using a POST with an x-cron-secret header — see
 * lib/cron-auth.ts for exactly which mechanisms are accepted and why
 * both exist.
 *
 * Alternative: Supabase pg_cron setup, if you'd rather trigger this from
 * Postgres instead of relying on vercel.json's native cron entry (run in
 * SQL editor; also requires `create extension if not exists pg_net;`):
 * ─────────────────────────────────────────────
 * select cron.schedule(
 *   'weekly-rematch',
 *   '30 0 * * 0',   -- every Sunday 00:30 UTC = 06:00 IST
 *   $$
 *     select net.http_post(
 *       url     := 'https://YOUR_VERCEL_URL/api/cron/rematch',
 *       headers := '{"Content-Type":"application/json","x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb,
 *       body    := '{}'::jsonb
 *     );
 *   $$
 * );
 *
 * Required env vars:
 *   CRON_SECRET=your_random_secret  (generate: openssl rand -base64 24)
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { runScheduledRematch } from '../../../lib/rematch'
import { waitUntil } from '@vercel/functions'
import { isAuthorizedCronRequest, isAllowedCronMethod } from '../../../lib/cron-auth'

export const config = { maxDuration: 300, externalResolver: true }  // 5 min timeout on Vercel

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAllowedCronMethod(req.method)) {
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).end()
  }

  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  console.log('[cron/rematch] Triggered at', new Date().toISOString())

  // Run async — respond immediately so pg_net doesn't time out.
  // waitUntil() keeps this invocation alive for the full re-match run
  // instead of risking Vercel freezing the instance once the response
  // below has been sent — this job touches every active patient across
  // every org, so a silently-killed run means silent missed re-matches
  // platform-wide, not just one job.
  res.status(202).json({ message: 'Re-match job started', timestamp: new Date().toISOString() })

  waitUntil(
    runScheduledRematch()
      .then(result => console.log('[cron/rematch] Complete:', result))
      .catch(err   => console.error('[cron/rematch] Failed:', err))
  )
}
