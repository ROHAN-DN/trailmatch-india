/**
 * pages/api/abdm/status.ts
 * Returns current status of an ABDM health fetch session.
 * Client polls this every 2s until status is 'parsed' or 'failed'.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).end()
  }

  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user       = session.user as any
  const db         = supabaseAdmin()
  const session_id = req.query.session_id as string

  if (!session_id) {
    return res.status(400).json({ error: 'session_id required' })
  }

  const { data: abdmSession } = await db
    .from('abdm_sessions')
    .select(`
      id, status, abha_number, error_message, expires_at,
      patient_id,
      patients ( id, patient_code, diagnosis, age, sex, location )
    `)
    .eq('id', session_id)
    .eq('org_id', user.org_id)
    .single()

  if (!abdmSession) {
    return res.status(404).json({ error: 'Session not found' })
  }

  // Status-to-message mapping for UI display
  const statusMessages: Record<string, string> = {
    initiated:          'OTP sent — waiting for verification',
    verified:           'Identity verified — requesting health records',
    consent_requested:  'Consent request sent — ABDM is fetching records',
    fetching:           'Fetching health records from your provider…',
    received:           'Health records received — parsing…',
    parsed:             'Health records imported successfully',
    failed:             `Failed: ${abdmSession.error_message || 'Unknown error'}`,
    expired:            'Session expired — please start again',
  }

  return res.json({
    session_id,
    status:   abdmSession.status,
    message:  statusMessages[abdmSession.status] || abdmSession.status,
    patient:  (abdmSession as any).patients || null,
    expired:  new Date(abdmSession.expires_at) < new Date(),
    complete: abdmSession.status === 'parsed',
    failed:   abdmSession.status === 'failed' || abdmSession.status === 'expired',
  })
}
