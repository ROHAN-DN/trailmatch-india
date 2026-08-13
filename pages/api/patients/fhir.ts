/**
 * pages/api/patients/fhir.ts
 * FHIR R4 patient import endpoint.
 * Accepts JSON body with raw FHIR Bundle or resource array,
 * parses it, validates, and creates patient records.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'
import { parseFHIRBundle, validateFHIRPatient } from '../../../lib/fhir'
import { normaliseABDMBundle, isABDMBundle, extractABHA } from '../../../lib/abdm'
import { checkLimit } from '../../../lib/gate'

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } }

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

  // Accept raw FHIR JSON in request body
  const fhirData = req.body?.fhir_bundle || req.body

  if (!fhirData || typeof fhirData !== 'object') {
    return res.status(400).json({ error: 'Request body must be a FHIR Bundle JSON object' })
  }

  // ── Normalise ABDM bundles ────────────────────────────────
  let normalisedData = fhirData
  const isABDM = isABDMBundle(fhirData)
  if (isABDM) {
    normalisedData = normaliseABDMBundle(fhirData)
    const abha = extractABHA(fhirData)
    console.log(`[fhir] ABDM bundle detected${abha ? ` — ABHA: ${abha}` : ''}`)
  }

  // ── Parse FHIR bundle ─────────────────────────────────────
  let parsed: Partial<import('../../../lib/matcher').Patient>[]
  try {
    parsed = parseFHIRBundle(normalisedData)
  } catch (err: any) {
    return res.status(422).json({
      error: `FHIR parsing failed: ${err.message}`,
      hint:  'Make sure you are uploading a valid FHIR R4 Bundle or Patient resource JSON.',
    })
  }

  if (!parsed.length) {
    return res.status(422).json({ error: 'No patients could be extracted from the FHIR data' })
  }

  if (parsed.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 patients per import. Split your bundle into smaller batches.' })
  }

  // ── Check patient limit ────────────────────────────────────
  const gate = await checkLimit(org_id, 'patients')
  if (!gate.allowed) {
    return res.status(402).json({ error: gate.message, upgrade: gate.upgrade })
  }

  // ── Validate each patient ─────────────────────────────────
  const results = parsed.map((p, idx) => {
    const { valid, errors } = validateFHIRPatient(p)
    return { index: idx, patient: p, valid, errors }
  })

  const invalid = results.filter(r => !r.valid)
  const valid   = results.filter(r => r.valid)

  if (!valid.length) {
    return res.status(422).json({
      error:   'No valid patients found after validation',
      details: invalid.map(r => ({ index: r.index, errors: r.errors })),
    })
  }

  // ── Insert valid patients ──────────────────────────────────
  // Server-side consent enforcement — DPDP Act 2023 requirement.
  // FHIR data originates from a hospital EHR; the coordinator must still
  // explicitly confirm consent for THIS processing purpose (trial matching)
  // before any records are created.
  if (req.body.consent_confirmed !== true) {
    return res.status(400).json({
      error: 'Consent confirmation is required before importing FHIR records. Please confirm that patients have consented to clinical trial matching.',
    })
  }

  const toInsert = valid.map(r => ({
    ...r.patient,
    org_id,
    created_by: user.id,
    consent_given: true,
    consent_given_at: new Date().toISOString(),
    // Ensure required fields have defaults
    patient_code: r.patient.patient_code || `FHIR-${Date.now()}-${r.index}`,
    age:          r.patient.age          || 0,
    sex:          r.patient.sex          || 'Other',
    location:     r.patient.location     || 'India',
    diagnosis:    r.patient.diagnosis    || 'Unknown',
  }))

  const { data: inserted, error: dbErr } = await db
    .from('patients')
    .upsert(toInsert, { onConflict: 'org_id,patient_code', ignoreDuplicates: false })
    .select()

  if (dbErr) {
    return res.status(500).json({ error: `Database error: ${dbErr.message}` })
  }

  // ── Audit log ──────────────────────────────────────────────
  await db.from('audit_log').insert({
    org_id,
    user_id:  user.id,
    action:   'fhir_import',
    metadata: {
      imported: inserted?.length || 0,
      skipped:  invalid.length,
      source:   fhirData.resourceType || 'unknown',
    },
  })

  return res.status(201).json({
    imported: inserted?.length || 0,
    skipped:  invalid.length,
    patients: inserted,
    warnings: invalid.length > 0
      ? invalid.map(r => ({
          index:  r.index,
          code:   r.patient.patient_code,
          errors: r.errors,
        }))
      : undefined,
  })
}
