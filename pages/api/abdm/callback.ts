/**
 * pages/api/abdm/callback.ts
 * ABDM pushes health data to this endpoint after fetching from HIP.
 * This is the async leg of the HIU flow for live (non-sandbox) usage.
 *
 * ABDM calls this with an encrypted FHIR bundle.
 * We decrypt, parse, create the patient record, and update the session.
 *
 * The session_id is passed as a query param when we register the callback URL:
 *   POST /api/abdm/callback?session=<session_id>
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { supabaseAdmin } from '../../../lib/supabase'
import { decryptHealthBundle } from '../../../lib/abdm-client'
import { parseFHIRBundle } from '../../../lib/fhir'
import { normaliseABDMBundle } from '../../../lib/abdm'
import { waitUntil } from '@vercel/functions'

// Disable body size limit — FHIR bundles can be large
export const config = { api: { bodyParser: { sizeLimit: '10mb' }, externalResolver: true }, maxDuration: 60 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // ABDM sends POST for health data delivery
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).end()
  }

  const sessionId = req.query.session as string

  // Validate session_id is a well-formed UUID before doing anything else.
  // This prevents arbitrary/malformed callback payloads from being processed.
  const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId || '')

  // Capture the body now — req.body is only safely readable before the
  // handler returns; we need it inside the deferred work below.
  const payload = req.body

  // Always return 202 immediately — ABDM doesn't wait for processing.
  // Everything after this point runs via waitUntil() so Vercel keeps this
  // invocation alive instead of risking early termination once the
  // response has been flushed.
  res.status(202).json({ message: 'Accepted' })

  if (!isValidUUID) {
    console.warn('[abdm/callback] Rejected: invalid or missing session ID format:', sessionId)
    return
  }

  waitUntil(processCallback(sessionId, payload))
}

async function processCallback(sessionId: string, payload: any) {
  const db = supabaseAdmin()

  const { data: abdmSession } = await db
    .from('abdm_sessions')
    .select('*')
    .eq('id', sessionId)
    .single()

  if (!abdmSession) {
    console.error(`[abdm/callback] Session ${sessionId} not found`)
    return
  }

  try {
    // ── Parse ABDM payload ────────────────────────────────────
    // ABDM sends either:
    //   payload.entries[].content (encrypted per-entry bundles)
    //   payload.entries[].careContextReference + content
    let fhirBundle: any

    if (payload.entries?.length) {
      // Decrypt and combine all entries into one bundle
      const allResources: any[] = []

      // Our own key material, generated in requestHealthInfo() and
      // persisted onto this session row — required to compute the shared
      // secret again. If it's missing, this session predates migration 015
      // or requestHealthInfo failed to persist it; there's nothing to
      // decrypt with, so fail this session clearly rather than silently
      // skip every entry.
      if (!abdmSession.fidelius_private_key || !abdmSession.fidelius_nonce) {
        throw new Error(
          'This session has no stored Fidelius key material to decrypt with. ' +
          'It may predate the real ECDH implementation, or requestHealthInfo() failed to persist it.'
        )
      }

      // The HIP's public key + nonce for THIS response — per ABDM's spec,
      // sent alongside the encrypted content in the callback's own
      // keyMaterial block (mirrors the shape of what we sent in the
      // original request).
      const hipPublicKey = payload.keyMaterial?.dhPublicKey?.keyValue
      const hipNonce      = payload.keyMaterial?.nonce
      if (!hipPublicKey || !hipNonce) {
        throw new Error('ABDM callback payload is missing keyMaterial.dhPublicKey.keyValue or keyMaterial.nonce — cannot decrypt without the HIP\'s public key and nonce')
      }

      for (const entry of payload.entries) {
        try {
          const decrypted = decryptHealthBundle({
            encryptedData: entry.content,
            hipPublicKey,
            hipNonce,
            ourPrivateKey: abdmSession.fidelius_private_key,
            ourNonce:      abdmSession.fidelius_nonce,
          })

          if (decrypted.resourceType === 'Bundle') {
            const resources = (decrypted.entry || []).map((e: any) => e.resource).filter(Boolean)
            allResources.push(...resources)
          } else if (decrypted.resourceType) {
            allResources.push(decrypted)
          }
        } catch (e) {
          console.warn(`[abdm/callback] Could not decrypt entry:`, e)
        }
      }

      fhirBundle = {
        resourceType: 'Bundle',
        type:         'collection',
        entry:        allResources.map(r => ({ resource: r })),
      }
    } else if (payload.resourceType === 'Bundle') {
      fhirBundle = payload
    } else {
      throw new Error('Unrecognised ABDM callback payload format')
    }

    // ── Update session: received ──────────────────────────────
    await db.from('abdm_sessions').update({
      status:      'received',
      fhir_bundle: fhirBundle,
    }).eq('id', sessionId)

    // ── Parse FHIR bundle → patient record ────────────────────
    const normalised = normaliseABDMBundle(fhirBundle)
    const parsed     = parseFHIRBundle(normalised)

    if (!parsed.length) {
      throw new Error('No patient data found in ABDM health bundle')
    }

    const patientData = parsed[0]

    // Consent basis: patient completed live mobile OTP verification via the
    // ABDM gateway to authorise this health information fetch.
    const { data: newPatient } = await db.from('patients').upsert({
      ...patientData,
      org_id:       abdmSession.org_id,
      created_by:   abdmSession.created_by,
      patient_code: `ABHA-${abdmSession.abha_number.slice(-6)}-${Date.now().toString().slice(-4)}`,
      age:          patientData.age      || 0,
      sex:          patientData.sex      || 'Other',
      location:     patientData.location || 'India',
      diagnosis:    patientData.diagnosis || 'Unknown',
      consent_given:    true,
      consent_given_at: new Date().toISOString(),
    }, { onConflict: 'org_id,patient_code' }).select().single()

    // ── Update session: parsed ────────────────────────────────
    await db.from('abdm_sessions').update({
      status:     'parsed',
      patient_id: newPatient?.id,
    }).eq('id', sessionId)

    await db.from('audit_log').insert({
      org_id:   abdmSession.org_id,
      user_id:  abdmSession.created_by,
      action:   'abdm_callback_received',
      metadata: {
        session_id: sessionId,
        abha_number: abdmSession.abha_number,
        patient_id:  newPatient?.id,
      },
    })

    console.log(`[abdm/callback] Session ${sessionId} complete — patient ${newPatient?.id}`)

  } catch (err: any) {
    console.error(`[abdm/callback] Processing error for session ${sessionId}:`, err.message)

    // Supabase's query builder is PromiseLike (has .then()) but is NOT a real
    // Promise — it has no .catch() method. Calling .catch() on it directly
    // throws "TypeError: ...catch is not a function" at runtime, which would
    // fire from inside this very error handler and mask the original error
    // with an unhandled rejection instead of recording it. Use a real
    // try/catch around an awaited call instead.
    try {
      await db.from('abdm_sessions').update({
        status:        'failed',
        error_message: err.message,
      }).eq('id', sessionId)
    } catch (updateErr: any) {
      console.error(`[abdm/callback] Also failed to record failure status for session ${sessionId}:`, updateErr.message)
    }
  }
}
