/**
 * pages/api/import/hms.ts
 * One-click Insta HMS patient import (Week 12-13)
 *
 * Phase 1 (parse preview): POST application/json { csv_text: string }
 * Phase 2 (confirm import): POST application/json { confirm: true, rows: [] }
 *
 * Uses plain JSON instead of multipart — no formidable dependency needed.
 * The client reads the CSV file with FileReader and sends the text content.
 *
 * DPDP Act 2023: all imported patients get consent_given=false.
 * Coordinator must set consent individually before running match jobs.
 *
 * Body size: Next.js default body parser limit is 1MB. Without the config
 * below, any CSV over ~1MB silently fails with a 413. This route raises it
 * to 5MB which comfortably handles ~5,000 patient rows at typical field lengths.
 * All other API routes keep the 1MB default — this override is route-specific.
 */

// MUST be at the top level — Next.js reads this at build time, not runtime.
// Raises the JSON body limit from the 1MB default to 5MB for this route only.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '5mb',
    },
  },
}
import { z } from 'zod'
import { withApiHandler } from '../../../lib/api-handler'
import { parseHMSCSV } from '../../../lib/hms-import'
import { writeAudit } from '../../../lib/audit'
import { ValidationError } from '../../../lib/errors'

const ParseSchema = z.object({
  csv_text: z.string().min(10, 'CSV content is empty').max(5_000_000, 'CSV must be under 5 MB'),
})

const ConfirmSchema = z.object({
  confirm: z.literal(true),
  rows:    z.array(z.object({
    patient_code:  z.string().min(1).max(50),
    diagnosis:     z.string().min(1).max(500),
    age:           z.number().int().min(0).max(130),
    sex:           z.enum(['Male', 'Female', 'Other']),
    location:      z.string().max(200).optional(),
    medications:   z.string().max(2000).optional(),
    comorbidities: z.string().max(2000).optional(),
    labs:          z.string().max(2000).optional(),
    notes:         z.string().max(1000).optional(),
  })).min(1).max(1000),
})

// Plan patient limits
const PLAN_LIMITS: Record<string, number> = {
  trial: 10, starter: 100, pro: 1000, enterprise: 99999,
}

export default withApiHandler(async (req, res, ctx) => {
  const { db, user, org } = ctx

  // ── Phase 1: Parse CSV → preview ─────────────────────────────────────────
  const rawBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body

  if (!rawBody.confirm) {
    const parse = ParseSchema.safeParse(rawBody)
    if (!parse.success) {
      const fe: Record<string, string> = {}
      for (const i of parse.error.issues) fe[i.path.join('.')] = i.message
      throw new ValidationError(parse.error.issues[0].message, fe)
    }

    const result = parseHMSCSV(parse.data.csv_text)

    return res.json({
      preview:         result.rows.slice(0, 10),
      valid_count:     result.valid_count,
      skip_count:      result.skip_count,
      total_rows:      result.rows.length,
      warnings:        result.warnings,
      detected_format: result.detected_format,
      all_valid_rows:  result.rows.filter(r => r.valid),
    })
  }

  // ── Phase 2: Confirmed insert ─────────────────────────────────────────────
  const confirm = ConfirmSchema.safeParse(rawBody)
  if (!confirm.success) {
    const fe: Record<string, string> = {}
    for (const i of confirm.error.issues) fe[i.path.join('.')] = i.message
    throw new ValidationError(confirm.error.issues[0].message, fe)
  }

  const { rows } = confirm.data

  // Check plan patient limit
  const { count: existingCount } = await db
    .from('patients')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', org.id)
    .eq('is_archived', false)

  const { data: orgWithPlan } = await db
    .from('organizations').select('plan').eq('id', org.id).single()

  const limit     = PLAN_LIMITS[orgWithPlan?.plan || 'trial'] ?? 10
  const available = limit - (existingCount ?? 0)

  if (available <= 0) {
    return res.status(402).json({
      error: {
        code:    'PLAN_LIMIT',
        message: `Your ${orgWithPlan?.plan || 'trial'} plan is at the patient limit (${limit}). Upgrade to import more.`,
      },
    })
  }

  const toInsert = rows.slice(0, available).map(r => ({
    org_id:        org.id,
    patient_code:  r.patient_code,
    diagnosis:     r.diagnosis,
    age:           r.age,
    sex:           r.sex,
    location:      r.location     || '',
    medications:   r.medications  || null,
    comorbidities: r.comorbidities || null,
    labs:          r.labs          || null,
    notes:         r.notes
      ? `[Imported from Insta HMS] ${r.notes}`
      : '[Imported from Insta HMS]',
    // DPDP Act 2023: consent must be explicitly obtained per patient
    consent_given: false,
    is_archived:   false,
  }))

  const { data: inserted, error } = await db
    .from('patients')
    .upsert(toInsert, { onConflict: 'org_id,patient_code', ignoreDuplicates: false })
    .select('id')

  if (error) {
    return res.status(500).json({ error: { code: 'DB_ERROR', message: error.message } })
  }

  const imported_count  = (inserted || []).length
  const skipped_by_plan = rows.length > available ? rows.length - available : 0

  writeAudit({
    action:      'patient:bulk_import',
    org_id:      org.id,
    user_id:     user.id,
    entity_type: 'patients',
    metadata:    { imported_count, skipped_by_plan, source: 'insta_hms' },
    ip_address:  ctx.ipAddress,
  })

  return res.status(201).json({
    imported_count,
    skipped_by_plan,
    message: `${imported_count} patient${imported_count !== 1 ? 's' : ''} imported. Remember to record consent for each patient before running match jobs.`,
  })
}, { methods: ['POST'] })
