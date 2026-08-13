import { checkLimit } from '../../../lib/gate'
import { patientRateLimit } from '../../../lib/ratelimit'
import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'
import { StructuredClinicalInput, deriveLegacyTextFields, writeStructuredClinicalData } from '../../../lib/clinical-data'
import { z } from 'zod'

const PatientSchema = z.object({
  patient_code:     z.string().min(1),
  age:              z.number().min(0).max(120),
  sex:              z.enum(['Male', 'Female', 'Other']),
  location:         z.string().min(1),
  diagnosis:        z.string().min(1),
  stage:            z.string().optional(),
  medications:      z.string().optional(),
  labs:             z.string().optional(),
  comorbidities:    z.string().optional(),
  prior_treatments: z.string().optional(),
  biomarkers:       z.string().optional(),
  allergies:        z.string().optional(),
  ecog_status:      z.string().optional(),
  notes:            z.string().optional(),
}).merge(StructuredClinicalInput)

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user   = session.user as any
  const db     = supabaseAdmin()
  const org_id = user.org_id

  const rl = await patientRateLimit(org_id)
  if (!rl.ok) return res.status(429).json({ error: rl.message })

  // ── GET — list patients ──────────────────────────────────────
  if (req.method === 'GET') {
    const { search, page = '1', limit = '20' } = req.query
    let query = db
      .from('patients')
      .select('*', { count: 'exact' })
      .eq('org_id', org_id)
      .eq('is_archived', false)
      .order('created_at', { ascending: false })
      .range((+page - 1) * +limit, +page * +limit - 1)

    if (search) {
      query = query.or(`patient_code.ilike.%${search}%,diagnosis.ilike.%${search}%,location.ilike.%${search}%`)
    }

    const { data, count, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ patients: data, total: count, page: +page, limit: +limit })
  }

  // ── POST — create single patient ─────────────────────────────
  if (req.method === 'POST') {
    // Batch import via CSV
    if (req.body.batch) {
      const rows = req.body.patients as any[]
      if (!rows?.length) return res.status(400).json({ error: 'No patients provided' })
      if (rows.length > 20) return res.status(400).json({ error: 'Maximum 20 patients per batch' })

      // Plan-limit check — the single-patient path above already enforces
      // max_patients; this endpoint didn't, which meant it was a
      // complete bypass (repeat batch calls of up to 20 could add
      // unlimited patients regardless of plan). Only rows that are
      // genuinely NEW patient_codes count against the limit — the
      // upsert below (onConflict: 'org_id,patient_code') means some rows
      // in a "batch import" may just be updates to already-counted
      // existing patients, and those must not be blocked or double-counted.
      const incomingCodes = rows.map(r => r.patient_code).filter(Boolean)
      const { data: existingForBatch } = await db.from('patients')
        .select('patient_code')
        .eq('org_id', org_id)
        .in('patient_code', incomingCodes)
      const existingCodes = new Set((existingForBatch || []).map(p => p.patient_code))
      const netNewCount = rows.filter(r => !existingCodes.has(r.patient_code)).length

      if (netNewCount > 0) {
        const batchGate = await checkLimit(org_id, 'patients', netNewCount)
        if (!batchGate.allowed) return res.status(402).json({ error: batchGate.message, upgrade: batchGate.upgrade })
      }

      // Server-side consent enforcement — DPDP Act 2023 requirement.
      // Every row in a batch import must explicitly declare consent.
      const missingConsent = rows.filter(r => r.consent_given !== true)
      if (missingConsent.length > 0) {
        return res.status(400).json({
          error: `${missingConsent.length} of ${rows.length} patient(s) are missing consent confirmation. All patients must have consent_given: true before import.`,
          missing_consent_codes: missingConsent.map(r => r.patient_code).filter(Boolean),
        })
      }

      const toInsert = rows.map(r => ({
        ...r,
        org_id,
        created_by: user.id,
        consent_given: true,
        consent_given_at: new Date().toISOString(),
      }))
      const { data, error } = await db.from('patients').upsert(toInsert, {
        onConflict: 'org_id,patient_code',
        ignoreDuplicates: false,
      }).select()

      if (error) return res.status(500).json({ error: error.message })

      await db.from('audit_log').insert({
        org_id, user_id: user.id,
        action: 'batch_import_patients',
        metadata: { count: rows.length, consent_given: true },
      })
      return res.status(201).json({ patients: data, imported: data?.length })
    }

    // Single patient — check limit
    const patientGate = await checkLimit(org_id, 'patients')
    if (!patientGate.allowed) return res.status(402).json({ error: patientGate.message, upgrade: patientGate.upgrade })

    const parsed = PatientSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

    // Server-side consent enforcement — DPDP Act 2023 requirement.
    // Defense in depth: even if client-side validation is bypassed, the API rejects.
    if (req.body.consent_given !== true) {
      return res.status(400).json({ error: 'Patient consent confirmation is required before adding a record.' })
    }

    const {
      structured_labs, structured_medications, structured_biomarkers,
      structured_comorbidities, structured_allergies, ...patientFields
    } = parsed.data

    const structured = { structured_labs, structured_medications, structured_biomarkers, structured_comorbidities, structured_allergies }
    // Structured data — if provided — is the source of truth for the
    // legacy free-text columns lib/matcher.ts still reads. Derived values
    // override whatever free text was also submitted for the same fields,
    // so the two never silently drift apart. See lib/clinical-data.ts.
    const derivedText = deriveLegacyTextFields(structured)

    const { data, error } = await db.from('patients')
      .insert({
        ...patientFields,
        ...derivedText,
        org_id,
        created_by: user.id,
        consent_given: true,
        consent_given_at: new Date().toISOString(),
      })
      .select().single()

    if (error) return res.status(500).json({ error: error.message })

    const { error: clinicalError } = await writeStructuredClinicalData(db, org_id, data.id, user.id, structured)
    if (clinicalError) {
      // The patient row itself was created successfully — don't fail the
      // whole request over structured data, but surface it clearly rather
      // than silently dropping it, since this is exactly the kind of
      // partial-write scenario writeStructuredClinicalData's own docs warn about.
      console.error(`[patients] Patient ${data.id} created but structured clinical data failed:`, clinicalError)
    }

    await db.from('audit_log').insert({
      org_id, user_id: user.id, action: 'create_patient',
      entity: 'patient', entity_id: data.id,
      metadata: { patient_code: data.patient_code, consent_given: true },
    })

    return res.status(201).json({ patient: data, clinical_data_warning: clinicalError || undefined })
  }

  // ── PATCH — update patient ────────────────────────────────────
  if (req.method === 'PATCH') {
    const { id } = req.query
    if (typeof id !== 'string') return res.status(400).json({ error: 'Missing patient id' })

    const parsed = PatientSchema.partial().safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

    const {
      structured_labs, structured_medications, structured_biomarkers,
      structured_comorbidities, structured_allergies, ...patientFields
    } = parsed.data

    const structured = { structured_labs, structured_medications, structured_biomarkers, structured_comorbidities, structured_allergies }
    const derivedText = deriveLegacyTextFields(structured)

    const { data, error } = await db.from('patients')
      .update({ ...patientFields, ...derivedText })
      .eq('id', id)
      .eq('org_id', org_id)
      .select().single()

    if (error) return res.status(500).json({ error: error.message })

    const { error: clinicalError } = await writeStructuredClinicalData(db, org_id, id, user.id, structured)
    if (clinicalError) console.error(`[patients] Patient ${id} updated but structured clinical data failed:`, clinicalError)

    return res.json({ patient: data, clinical_data_warning: clinicalError || undefined })
  }

  // ── DELETE — archive patient ──────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query
    const { error } = await db.from('patients')
      .update({ is_archived: true })
      .eq('id', id as string)
      .eq('org_id', org_id)

    if (error) return res.status(500).json({ error: error.message })
    return res.json({ success: true })
  }

  res.setHeader('Allow', ['GET', 'POST', 'PATCH', 'DELETE'])
  res.status(405).end(`Method ${req.method} not allowed`)
}
