/**
 * pages/api/sponsor/feasibility.ts — Production rewrite
 *
 * POST { protocol_id }
 *
 * Privacy guarantee: returns ONLY aggregate counts per site.
 * Every patient ID is suppressed at the DB query level in runFeasibility().
 * Rate limited: 5 runs per sponsor org per calendar day.
 */
import { z } from 'zod'
import { withApiHandler } from '../../../lib/api-handler'
import { writeAudit } from '../../../lib/audit'
import { runFeasibility } from '../../../lib/feasibility'
import { NotFoundError, ValidationError, RateLimitError, ForbiddenError, DatabaseError } from '../../../lib/errors'

const SPONSOR_TYPES  = ['pharma', 'biotech', 'cro']
const DAILY_LIMIT    = 5

const BodySchema = z.object({
  protocol_id: z.string().uuid('Invalid protocol ID'),
})

export default withApiHandler(async (req, res, ctx) => {
  const { db, user, org } = ctx

  if (!SPONSOR_TYPES.includes(org.org_type)) {
    throw new ForbiddenError('The sponsor feasibility feature is only available to pharma, biotech, and CRO organisations.')
  }

  const body = BodySchema.safeParse(req.body)
  if (!body.success) {
    throw new ValidationError(body.error.issues[0].message, { protocol_id: body.error.issues[0].message })
  }
  const { protocol_id } = body.data

  /* Daily rate limit */
  const dayStart = new Date()
  dayStart.setUTCHours(0, 0, 0, 0)

  const { count: runsToday } = await db
    .from('sponsor_feasibility_runs')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', org.id)
    .gte('ran_at', dayStart.toISOString())

  if ((runsToday ?? 0) >= DAILY_LIMIT) {
    throw new RateLimitError(
      `Daily limit of ${DAILY_LIMIT} feasibility runs reached. Resets at midnight UTC.`,
      new Date(dayStart.getTime() + 86_400_000).getTime() - Date.now()
    )
  }

  /* Load protocol */
  const { data: protocol, error: protoErr } = await db
    .from('protocols')
    .select('id, title, phase, therapeutic_area, inclusion_criteria, exclusion_criteria, status')
    .eq('id',     protocol_id)
    .eq('org_id', org.id)
    .single()

  if (protoErr || !protocol) throw new NotFoundError('Protocol', protocol_id)

  if (protocol.status === 'archived') {
    throw new ValidationError('Cannot run feasibility on an archived protocol.', {
      protocol_id: 'Protocol is archived',
    })
  }

  const criteria = [
    ...(protocol.inclusion_criteria || []),
    ...(protocol.exclusion_criteria || []),
  ]

  if (criteria.length === 0) {
    throw new ValidationError(
      'This protocol has no eligibility criteria. Add criteria in the Protocols tab before running feasibility.',
      { protocol_id: 'No criteria defined' }
    )
  }

  /* Run cross-org feasibility */
  let results
  try {
    results = await runFeasibility(criteria)
  } catch (e: any) {
    throw new DatabaseError('run feasibility', e.message)
  }

  /* Log run for rate limiting */
  await db.from('sponsor_feasibility_runs').insert({ org_id: org.id, protocol_id })

  /* Store result snapshot for historical reference.
     Non-fatal if feasibility_queries doesn't exist yet — but Supabase's query
     builder is PromiseLike, not a real Promise, so it has no .catch() method.
     Calling .catch() on it directly throws synchronously instead of being
     swallowed, which would defeat the "non-fatal" intent here and fail the
     whole request. A real try/catch around an awaited call is required. */
  try {
    await db.from('feasibility_queries').insert({
      org_id:      org.id,
      created_by:  user.id,
      name:        `Sponsor: ${protocol.title}`,
      criteria,
      status:      'complete',
      results,
      total_sites: results.length,
    })
  } catch (e: any) {
    console.error('[sponsor/feasibility] Could not store feasibility_queries snapshot (non-fatal):', e.message)
  }

  writeAudit({
    action:      'feasibility:sponsor_run',
    org_id:      org.id,
    user_id:     user.id,
    entity_type: 'protocols',
    entity_id:   protocol_id,
    metadata:    {
      protocol_title: protocol.title,
      sites_returned: results.length,
      criteria_count: criteria.length,
      runs_today:     (runsToday ?? 0) + 1,
    },
    ip_address:  ctx.ipAddress,
  })

  /* Strip any fields that could leak patient-level info */
  const safeResults = results.map((r: any) => ({
    org_id:                 r.org_id,
    org_name:               r.org_name,
    city:                   r.city,
    total_patients_at_site: r.total_patients_at_site,
    qualifying_count:       r.total_count,
    confidence:             r.confidence,
    breakdown:              r.breakdown,
    disclaimer:             r.disclaimer,
  }))

  return res.json({
    protocol_id,
    protocol_title:   protocol.title,
    therapeutic_area: protocol.therapeutic_area,
    phase:            protocol.phase,
    results:          safeResults,
    total_sites:      safeResults.length,
    runs_today:       (runsToday ?? 0) + 1,
    daily_limit:      DAILY_LIMIT,
  })
}, { methods: ['POST'] })
