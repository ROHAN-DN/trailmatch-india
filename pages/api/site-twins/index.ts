/**
 * pages/api/site-twins/index.ts — Production rewrite
 * GET /api/site-twins          — paginated, filterable list
 * GET /api/site-twins?id=uuid  — single site profile with PI contacts
 *
 * Accessible to all authenticated orgs (coordinator and sponsor).
 * Never exposes patient-level data — site_twins is aggregate only.
 */
import { z } from 'zod'
import { withApiHandler } from '../../../lib/api-handler'
import { writeAudit } from '../../../lib/audit'
import { NotFoundError } from '../../../lib/errors'

const ListQuerySchema = z.object({
  search:     z.string().max(100).optional(),
  city:       z.string().max(100).optional(),
  state:      z.string().max(100).optional(),
  specialty:  z.string().max(100).optional(),
  is_partner: z.enum(['true', 'false']).optional(),
  page:       z.coerce.number().int().min(1).default(1),
  limit:      z.coerce.number().int().min(1).max(50).default(24),
})

export default withApiHandler(async (req, res, ctx) => {
  const { db, user, org } = ctx

  /* ── Single site profile ─────────────────────────────────── */
  if (req.query.id) {
    const { data: site, error } = await db
      .from('india_site_profiles')
      .select('*')
      .eq('id', req.query.id as string)
      .single()

    if (error || !site) throw new NotFoundError('Site profile', req.query.id as string)

    /* PI contacts at this institution (from pi_contacts, matched by name) */
    const { data: pis } = await db
      .from('pi_contacts')
      .select('id, pi_name, pi_email, pi_phone, specialty, response_rate, avg_response_hours, verified, times_contacted')
      .ilike('pi_institution', `%${site.institution_name.slice(0, 40)}%`)
      .eq('email_bounced', false)
      // See pages/api/pi-contacts/index.ts for why nullsFirst:false, not nullsLast.
      .order('response_rate', { ascending: false, nullsFirst: false })
      .limit(20)

    writeAudit({
      action:      'site:twin_viewed',
      org_id:      org.id,
      user_id:     user.id,
      entity_type: 'india_site_profiles',
      entity_id:   site.id,
      ip_address:  ctx.ipAddress,
    })

    return res.json({ site, pi_contacts: pis || [] })
  }

  /* ── List / search ──────────────────────────────────────── */
  const query = ListQuerySchema.safeParse(req.query)
  if (!query.success) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid query parameters.' } })
  }

  const { search, city, state, specialty, is_partner, page, limit } = query.data
  const offset = (page - 1) * limit

  let q = db
    .from('india_site_profiles')
    .select('id, institution_name, city, state, site_type, specialties, active_trials, pi_count, total_patients, is_partner, is_verified, org_id', { count: 'exact' })
    .order('is_partner',    { ascending: false })
    .order('active_trials', { ascending: false })
    .range(offset, offset + limit - 1)

  if (search)                q = q.ilike('institution_name', `%${search}%`)
  if (city)                  q = q.ilike('city', `%${city}%`)
  if (state)                 q = q.ilike('state', `%${state}%`)
  if (specialty)             q = q.contains('specialties', [specialty])
  if (is_partner === 'true') q = q.eq('is_partner', true)
  if (is_partner === 'false') q = q.eq('is_partner', false)

  const { data: sites, count, error } = await q
  if (error) throw new Error(error.message)

  return res.json({
    sites:       sites || [],
    total:       count || 0,
    page,
    page_size:   limit,
    total_pages: Math.ceil((count || 0) / limit),
  })
}, { methods: ['GET'] })
