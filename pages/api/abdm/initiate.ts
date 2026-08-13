/**
 * pages/api/abdm/initiate.ts
 * Step 1 of ABDM health fetch flow.
 * POST { abha_number } → verifies ABHA, sends OTP, creates session.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'
import { verifyABHA, initiateABHAOTP, SANDBOX_TEST_ABHA } from '../../../lib/abdm-client'
import { abdmRateLimit } from '../../../lib/ratelimit'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).end()
  }

  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user   = session.user as any
  const db     = supabaseAdmin()
  const org_id = user.org_id

  // Rate limit: 5 OTP requests per user per hour — prevents OTP abuse
  const rl = await abdmRateLimit(user.id)
  if (!rl.ok) return res.status(429).json({ error: rl.message })

  const { abha_number } = req.body as { abha_number: string }

  if (!abha_number) {
    return res.status(400).json({ error: 'ABHA number is required' })
  }

  const cleanABHA = abha_number.replace(/[-\s]/g, '')

  // ── Check if ABDM is configured ───────────────────────────
  const isConfigured = !!(
    process.env.ABDM_CLIENT_ID &&
    process.env.ABDM_CLIENT_SECRET &&
    process.env.ABDM_HIU_ID
  )

  // ── Sandbox mode: use mock data if not fully configured ────
  const isSandboxTest = SANDBOX_TEST_ABHA.some(t =>
    t.abha.replace(/[-\s]/g, '') === cleanABHA
  )

  let profile: any
  let transactionId: string

  if (!isConfigured || isSandboxTest) {
    // Sandbox / demo mode — simulate the flow
    const mockProfile = SANDBOX_TEST_ABHA.find(t =>
      t.abha.replace(/[-\s]/g, '') === cleanABHA
    )

    if (!mockProfile && !isConfigured) {
      // Return sandbox hint when ABDM not configured
      return res.status(422).json({
        error:       'ABDM not configured',
        hint:        'Add ABDM credentials to .env.local or use a sandbox test ABHA number.',
        sandbox_abha: SANDBOX_TEST_ABHA.map(t => t.abha),
      })
    }

    profile = {
      abhaNumber:  cleanABHA,
      name:        mockProfile?.name || 'Test Patient',
      gender:      'Unknown',
      yearOfBirth: 1975,
      mobile:      '******1234',
    }
    transactionId = `mock-txn-${Date.now()}`
  } else {
    // Live ABDM flow
    try {
      profile = await verifyABHA(cleanABHA)
      const otpRes = await initiateABHAOTP(cleanABHA)
      transactionId = otpRes.transactionId
    } catch (err: any) {
      return res.status(422).json({ error: err.message })
    }
  }

  // ── Create session record ──────────────────────────────────
  const { data: abdmSession, error: dbErr } = await db
    .from('abdm_sessions')
    .insert({
      org_id,
      created_by:     user.id,
      abha_number:    cleanABHA,
      transaction_id: transactionId,
      status:         'initiated',
      expires_at:     new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single()

  if (dbErr) {
    return res.status(500).json({ error: `Session creation failed: ${dbErr.message}` })
  }

  return res.json({
    session_id:    abdmSession.id,
    transaction_id: transactionId,
    patient: {
      name:        profile.name,
      gender:      profile.gender,
      year_of_birth: profile.yearOfBirth,
      mobile:      profile.mobile,   // masked
    },
    message: `OTP sent to mobile number ending in ${profile.mobile.slice(-4)}`,
    sandbox_otp: isSandboxTest || !isConfigured ? '123456' : undefined,
  })
}
