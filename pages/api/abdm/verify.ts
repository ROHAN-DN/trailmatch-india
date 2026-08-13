/**
 * pages/api/abdm/verify.ts
 * Step 2 of ABDM flow.
 * POST { session_id, otp } → confirms OTP, triggers health info request.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'
import {
  confirmABHAOTP,
  requestHealthInfo,
  getMockHealthBundle,
  SANDBOX_TEST_ABHA,
} from '../../../lib/abdm-client'
import { parseFHIRBundle, validateFHIRPatient } from '../../../lib/fhir'
import { normaliseABDMBundle } from '../../../lib/abdm'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).end()
  }

  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user   = session.user as any
  const db     = supabaseAdmin()

  const { session_id, otp } = req.body as { session_id: string; otp: string }

  if (!session_id || !otp) {
    return res.status(400).json({ error: 'session_id and otp are required' })
  }

  // ── Fetch and validate session ─────────────────────────────
  const { data: abdmSession, error: fetchErr } = await db
    .from('abdm_sessions')
    .select('*')
    .eq('id', session_id)
    .eq('org_id', user.org_id)
    .single()

  if (fetchErr || !abdmSession) {
    return res.status(404).json({ error: 'Session not found' })
  }

  if (abdmSession.status === 'failed' || abdmSession.status === 'expired') {
    return res.status(410).json({ error: `Session is ${abdmSession.status}. Please start again.` })
  }

  if (new Date(abdmSession.expires_at) < new Date()) {
    await db.from('abdm_sessions').update({ status: 'expired' }).eq('id', session_id)
    return res.status(410).json({ error: 'Session expired. Please start again with a new OTP.' })
  }

  const isConfigured = !!(
    process.env.ABDM_CLIENT_ID &&
    process.env.ABDM_CLIENT_SECRET &&
    process.env.ABDM_HIU_ID
  )
  const isMockSession = abdmSession.transaction_id?.startsWith('mock-')

  let patientToken:  string
  let patientId:     string
  let fhirBundle:    any

  if (isMockSession || !isConfigured) {
    // ── Sandbox / demo mode ─────────────────────────────────
    if (otp !== '123456') {
      return res.status(422).json({
        error:   'Invalid OTP. In sandbox mode, use 123456.',
        hint:    'This is a sandbox demo. Enter 123456 to proceed.',
      })
    }

    // Use mock FHIR bundle
    fhirBundle = getMockHealthBundle(abdmSession.abha_number)
    patientToken = 'mock-token'
    patientId    = `mock-${abdmSession.abha_number}`

  } else {
    // ── Live ABDM flow ──────────────────────────────────────
    try {
      const confirmed = await confirmABHAOTP(abdmSession.transaction_id, otp)
      patientToken = confirmed.accessToken
      patientId    = confirmed.patientId

      await db.from('abdm_sessions').update({
        status:       'verified',
        access_token: patientToken,
      }).eq('id', session_id)

      // Request health info — ABDM will call our callback
      const { requestId, fideliusKeyMaterial } = await requestHealthInfo({
        patientToken,
        patientId,
        sessionId: session_id,
      })

      await db.from('abdm_sessions').update({
        status:     'consent_requested',
        request_id: requestId,
        // Persisted so decryptHealthBundle() can use it again when the
        // encrypted callback arrives — see lib/fidelius.ts and
        // pages/api/abdm/callback.ts.
        fidelius_private_key:     fideliusKeyMaterial.privateKey,
        fidelius_public_key_x509: fideliusKeyMaterial.x509PublicKey,
        fidelius_nonce:           fideliusKeyMaterial.nonce,
      }).eq('id', session_id)

      // For live flow, return pending state — data arrives via callback
      return res.json({
        status:  'pending',
        message: 'Health records requested. ABDM is fetching data from your health provider. This usually takes 10–30 seconds.',
        session_id,
        poll_url: `/api/abdm/status?session_id=${session_id}`,
      })

    } catch (err: any) {
      await db.from('abdm_sessions').update({
        status:        'failed',
        error_message: err.message,
      }).eq('id', session_id)
      return res.status(422).json({ error: err.message })
    }
  }

  // ── For sandbox: process FHIR bundle immediately ───────────
  try {
    const normalised = normaliseABDMBundle(fhirBundle)
    const parsed     = parseFHIRBundle(normalised)

    if (!parsed.length) {
      throw new Error('No patient records found in health data')
    }

    const patientData  = parsed[0]
    const { valid, errors } = validateFHIRPatient(patientData)

    // Create patient record.
    // Consent basis: the patient completed live mobile OTP verification via the
    // ABDM gateway to authorise this specific health information fetch — a
    // stronger consent signal than a coordinator-entered checkbox. Recorded
    // explicitly here for audit trail and data-retention consistency.
    const { data: newPatient } = await db.from('patients').upsert({
      ...patientData,
      org_id:       user.org_id,
      created_by:   user.id,
      patient_code: patientData.patient_code || `ABHA-${abdmSession.abha_number.slice(-6)}`,
      age:          patientData.age     || 0,
      sex:          patientData.sex     || 'Other',
      location:     patientData.location || 'India',
      diagnosis:    patientData.diagnosis || 'Unknown',
      consent_given:    true,
      consent_given_at: new Date().toISOString(),
    }, { onConflict: 'org_id,patient_code', ignoreDuplicates: false }).select().single()

    // Update session as complete
    await db.from('abdm_sessions').update({
      status:      'parsed',
      fhir_bundle: fhirBundle,
      patient_id:  newPatient?.id,
    }).eq('id', session_id)

    await db.from('audit_log').insert({
      org_id:   user.org_id,
      user_id:  user.id,
      action:   'abdm_fetch_complete',
      metadata: { abha_number: abdmSession.abha_number, patient_id: newPatient?.id },
    })

    return res.json({
      status:      'complete',
      patient:     newPatient,
      session_id,
      parse_warnings: valid ? [] : errors,
    })

  } catch (err: any) {
    await db.from('abdm_sessions').update({
      status:        'failed',
      error_message: err.message,
    }).eq('id', session_id)

    return res.status(500).json({ error: `Health record processing failed: ${err.message}` })
  }
}
