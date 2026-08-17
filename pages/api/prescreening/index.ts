/**
 * pages/api/prescreening/index.ts — Production rewrite
 *
 * GET  ?match_result_id=&nct_id=  → return cached checklist or generate
 * POST { match_result_id, nct_id } → force regenerate
 * PATCH ?id=                       → update status (reviewed / completed)
 */
import { z } from 'zod'
import { withApiHandler } from '../../../lib/api-handler'
import { writeAudit } from '../../../lib/audit'
import { generateChecklist } from '../../../lib/prescreening'
import { NotFoundError, ValidationError, DatabaseError } from '../../../lib/errors'

const PatchSchema = z.object({
  status: z.enum(['generated', 'reviewed', 'completed']),
})

export default withApiHandler(async (req, res, ctx) => {
  const { db, user, org } = ctx

  /* ── PATCH: update status ──────────────────────────────────── */
  if (req.method === 'PATCH') {
    const { id } = req.query
    if (!id) throw new ValidationError('Checklist id is required', { id: 'Required' })

    const body = PatchSchema.safeParse(req.body)
    if (!body.success) {
      throw new ValidationError('Invalid status', { status: body.error.issues[0].message })
    }

    const update: Record<string, any> = {
      status:     body.data.status,
      updated_at: new Date().toISOString(),
    }
    if (body.data.status === 'reviewed') {
      update.reviewed_at = new Date().toISOString()
      update.reviewed_by = user.id
    }

    const { data, error } = await db
      .from('prescreening_checklists')
      .update(update)
      .eq('id', id as string)
      .eq('org_id', org.id)
      .select()
      .single()

    if (error || !data) throw new NotFoundError('Checklist', id as string)

    writeAudit({
      action:      'prescreening:checklist_reviewed',
      org_id:      org.id,
      user_id:     user.id,
      entity_type: 'prescreening_checklists',
      entity_id:   data.id,
      after_state: { status: data.status },
      ip_address:  ctx.ipAddress,
    })

    return res.json({ checklist: data })
  }

  /* ── GET: fetch or generate ────────────────────────────────── */
  const { match_result_id, nct_id, force } = req.query

  if (!match_result_id || !nct_id) {
    throw new ValidationError('match_result_id and nct_id are required', {
      match_result_id: !match_result_id ? 'Required' : '',
      nct_id:          !nct_id          ? 'Required' : '',
    })
  }

  /* Return cached if exists and not a forced regeneration */
  if (!force) {
    const { data: existing } = await db
      .from('prescreening_checklists')
      .select('*')
      .eq('match_result_id', match_result_id as string)
      .eq('nct_id',          nct_id as string)
      .eq('org_id',          org.id)
      .single()

    if (existing) {
      return res.json({ checklist: existing, cached: true })
    }
  }

  /* Load match result + patient for context */
  const { data: matchResult, error: mrErr } = await db
    .from('match_results')
    .select('*, patients(*)')
    .eq('id',     match_result_id as string)
    .eq('org_id', org.id)
    .single()

  if (mrErr || !matchResult) throw new NotFoundError('Match result', match_result_id as string)

  const patient = matchResult.patients
  if (!patient) throw new NotFoundError('Patient linked to match result')

  /* Find the specific trial in the matches array */
  const matches     = matchResult.matches || []
  const targetMatch = matches.find((m: any) => m.nctId === nct_id) || matches[0] || {}
  const trialTitle  = targetMatch.title || (nct_id as string)

  /* Build criteria summary from eligibility details */
  const criteriaSummary = (targetMatch.eligibilityDetails || [])
    .slice(0, 8)
    .map((e: any) => `${e.criterion}: ${e.status}${e.detail ? ` — ${e.detail}` : ''}`)
    .join('; ') || targetMatch.summary || 'No detailed criteria available'

  /* Generate via Claude */
  let items
  try {
    items = await generateChecklist({
      patient: {
        age:           patient.age,
        sex:           patient.sex,
        diagnosis:     patient.diagnosis,
        medications:   patient.medications,
        labs:          patient.labs,
        comorbidities: patient.comorbidities,
        ecog_status:   patient.ecog_status,
        location:      patient.location,
        language:      patient.language_preference,
      },
      trial: {
        nct_id:           nct_id as string,
        title:            trialTitle,
        phase:            targetMatch.phase || '',
        sponsor:          targetMatch.sponsor || '',
        criteria_summary: criteriaSummary,
        india_sites:      targetMatch.indiaSites || '',
      },
    }, org.id)
  } catch (e: any) {
    throw new DatabaseError('generate checklist', e.message)
  }

  /* Upsert (handle race condition if called twice simultaneously) */
  const { data: saved, error: saveErr } = await db
    .from('prescreening_checklists')
    .upsert(
      {
        org_id:          org.id,
        match_result_id: match_result_id as string,
        patient_id:      patient.id,
        nct_id:          nct_id as string,
        trial_title:     trialTitle,
        checklist:       items,
        status:          'generated',
      },
      { onConflict: 'match_result_id,nct_id' }
    )
    .select()
    .single()

  if (saveErr) {
    /* Return items even if persist failed — coordinator still sees the list */
    console.error('[prescreening] Save failed:', saveErr.message)
    return res.json({
      checklist: { checklist: items, status: 'generated', nct_id, trial_title: trialTitle },
      cached:    false,
      warning:   'Checklist generated but could not be saved. It will not persist on refresh.',
    })
  }

  writeAudit({
    action:      'prescreening:checklist_generated',
    org_id:      org.id,
    user_id:     user.id,
    entity_type: 'prescreening_checklists',
    entity_id:   saved.id,
    metadata:    { nct_id, item_count: items.length },
    ip_address:  ctx.ipAddress,
  })

  return res.json({ checklist: saved, cached: false })
}, { methods: ['GET', 'PATCH'] })
