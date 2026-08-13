/**
 * lib/clinical-data.ts
 *
 * Shared logic for the structured clinical entities added in migration 017
 * (patient_labs, patient_medications, patient_biomarkers,
 * patient_comorbidities, patient_allergies). Used by pages/api/patients so
 * create and update don't duplicate validation/write logic.
 *
 * Sequencing note (see migration 017's own header comment): lib/matcher.ts
 * still reads the legacy free-text patients.labs/.medications/.biomarkers/
 * .comorbidities/.allergies columns — updating the matcher to consume
 * structured data directly is separate, later work. Until that happens,
 * deriveLegacyTextFields() below keeps those free-text columns populated
 * from whatever structured data was just saved, so matching doesn't
 * silently lose information for patients entered through the new
 * structured form. This is a bridge, not a permanent design — once the
 * matcher reads structured data directly, the legacy columns and this
 * derivation function should be retired (see migration 017's Phase 5).
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'

export const LabInput = z.object({
  test_name:       z.string().min(1),
  value_numeric:   z.number().optional(),
  value_text:      z.string().optional(),
  unit:            z.string().optional(),
  reference_range: z.string().optional(),
  collected_date:  z.string().optional(),
}).refine(d => d.value_numeric !== undefined || (d.value_text?.length ?? 0) > 0, {
  message: 'Each lab needs a numeric or text value',
})

export const MedicationInput = z.object({
  name:       z.string().min(1),
  dose:       z.string().optional(),
  frequency:  z.string().optional(),
  status:     z.enum(['active', 'discontinued', 'unknown']).default('active'),
  start_date: z.string().optional(),
  end_date:   z.string().optional(),
})

export const BiomarkerInput = z.object({
  marker:      z.string().min(1),
  status:      z.enum(['positive', 'negative', 'unknown', 'not_tested']).default('unknown'),
  value:       z.string().optional(),
  tested_date: z.string().optional(),
})

export const ComorbidityInput = z.object({
  condition:      z.string().min(1),
  status:         z.enum(['active', 'resolved', 'unknown']).default('active'),
  diagnosed_date: z.string().optional(),
})

export const AllergyInput = z.object({
  substance: z.string().min(1),
  reaction:  z.string().optional(),
  severity:  z.enum(['mild', 'moderate', 'severe', 'unknown']).default('unknown'),
})

export const StructuredClinicalInput = z.object({
  structured_labs:          z.array(LabInput).max(50).optional(),
  structured_medications:   z.array(MedicationInput).max(50).optional(),
  structured_biomarkers:    z.array(BiomarkerInput).max(50).optional(),
  structured_comorbidities: z.array(ComorbidityInput).max(50).optional(),
  structured_allergies:     z.array(AllergyInput).max(50).optional(),
})

export type StructuredClinicalData = z.infer<typeof StructuredClinicalInput>

/**
 * Derives the legacy free-text summary fields the current matcher prompt
 * (lib/matcher.ts) reads, from structured rows. Only derives a field when
 * the corresponding structured array was actually provided and non-empty —
 * if a caller doesn't send `structured_labs` at all (e.g. an older client,
 * or a PATCH that only touches unrelated fields), the existing free-text
 * value is left untouched rather than being blanked out.
 */
export function deriveLegacyTextFields(input: StructuredClinicalData): Record<string, string> {
  const out: Record<string, string> = {}

  if (input.structured_labs?.length) {
    out.labs = input.structured_labs
      .map(l => {
        const val = l.value_numeric ?? l.value_text
        const unitStr = l.unit ? (l.unit === '%' ? l.unit : ' ' + l.unit) : ''
        return `${l.test_name}: ${val}${unitStr}`
      })
      .join(', ')
  }

  if (input.structured_medications?.length) {
    const active = input.structured_medications.filter(m => m.status === 'active')
    const prior  = input.structured_medications.filter(m => m.status !== 'active')
    // Only overwrite each legacy field if there's something to say — an
    // empty derived string is worse than leaving the prior value alone.
    if (active.length) out.medications = active.map(m => `${m.name}${m.dose ? ' ' + m.dose : ''}`).join(', ')
    if (prior.length)  out.prior_treatments = prior
      .map(m => `${m.name}${m.dose ? ' ' + m.dose : ''} (${m.status}${m.end_date ? ' ' + m.end_date : ''})`)
      .join(', ')
  }

  if (input.structured_biomarkers?.length) {
    out.biomarkers = input.structured_biomarkers
      .map(b => `${b.marker}${b.status === 'positive' ? '+' : b.status === 'negative' ? '-' : ''}${b.value ? ' ' + b.value : ''}`)
      .join(', ')
  }

  if (input.structured_comorbidities?.length) {
    const active = input.structured_comorbidities.filter(c => c.status === 'active')
    if (active.length) out.comorbidities = active.map(c => c.condition).join(', ')
  }

  if (input.structured_allergies?.length) {
    out.allergies = input.structured_allergies
      .map(a => a.substance + (a.reaction ? ` (${a.reaction})` : ''))
      .join(', ')
  }

  return out
}

/**
 * Writes structured clinical data for a patient using replace semantics:
 * every row currently on file for that patient, in each table where the
 * caller provided an array, is deleted and replaced with exactly what was
 * submitted. This matches how the edit form works — it always submits the
 * complete current row set for each category, not incremental diffs — and
 * avoids the added complexity of per-row upsert/diff logic for a first
 * version. A category is left untouched if its array wasn't provided at
 * all (undefined), so a caller that only wants to update, say, labs can
 * omit the other four arrays without wiping them.
 *
 * Not transactional — Supabase's REST layer doesn't expose multi-statement
 * transactions to application code without a dedicated RPC function, and
 * no other compound write in this codebase (e.g. the match pipeline) uses
 * one either; this follows the same established sequential-await pattern
 * rather than introducing a new one. A failure partway through (e.g. labs
 * write succeeds, medications write fails) can leave a patient with a
 * partially-updated structured record — the caller should treat any error
 * return as "some of this may have been written" and re-fetch to confirm,
 * the same caution that already applies elsewhere in this codebase.
 */
export async function writeStructuredClinicalData(
  db: SupabaseClient,
  org_id: string,
  patient_id: string,
  created_by: string,
  input: StructuredClinicalData
): Promise<{ error: string | null }> {
  const tables: Array<[keyof StructuredClinicalData, string]> = [
    ['structured_labs',          'patient_labs'],
    ['structured_medications',   'patient_medications'],
    ['structured_biomarkers',    'patient_biomarkers'],
    ['structured_comorbidities', 'patient_comorbidities'],
    ['structured_allergies',     'patient_allergies'],
  ]

  for (const [key, table] of tables) {
    const rows = input[key]
    if (rows === undefined) continue // category not touched by this request

    const { error: deleteError } = await db.from(table).delete().eq('patient_id', patient_id).eq('org_id', org_id)
    if (deleteError) return { error: `Failed to clear existing ${table}: ${deleteError.message}` }

    if (rows.length === 0) continue // caller explicitly submitted an empty list — clearing was the whole point

    const { error: insertError } = await db.from(table).insert(
      rows.map(row => ({ ...row, org_id, patient_id, created_by, source: 'manual' }))
    )
    if (insertError) return { error: `Failed to save ${table}: ${insertError.message}` }
  }

  return { error: null }
}

export interface PatientClinicalData {
  labs:          any[]
  medications:   any[]
  biomarkers:    any[]
  comorbidities: any[]
  allergies:     any[]
}

/** Reads all structured clinical data for one patient — used by the edit form. */
export async function readStructuredClinicalData(
  db: SupabaseClient,
  org_id: string,
  patient_id: string
): Promise<PatientClinicalData | { error: string }> {
  const [labs, medications, biomarkers, comorbidities, allergies] = await Promise.all([
    db.from('patient_labs').select('*').eq('patient_id', patient_id).eq('org_id', org_id).order('collected_date', { ascending: false }),
    db.from('patient_medications').select('*').eq('patient_id', patient_id).eq('org_id', org_id).order('start_date', { ascending: false }),
    db.from('patient_biomarkers').select('*').eq('patient_id', patient_id).eq('org_id', org_id).order('tested_date', { ascending: false }),
    db.from('patient_comorbidities').select('*').eq('patient_id', patient_id).eq('org_id', org_id).order('diagnosed_date', { ascending: false }),
    db.from('patient_allergies').select('*').eq('patient_id', patient_id).eq('org_id', org_id),
  ])

  const firstError = [labs, medications, biomarkers, comorbidities, allergies].find(r => r.error)
  if (firstError?.error) return { error: firstError.error.message }

  return {
    labs:          labs.data || [],
    medications:   medications.data || [],
    biomarkers:    biomarkers.data || [],
    comorbidities: comorbidities.data || [],
    allergies:     allergies.data || [],
  }
}
