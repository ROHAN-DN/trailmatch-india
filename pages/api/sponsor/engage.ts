/**
 * pages/api/sponsor/engage.ts — Production rewrite
 * State machine, idempotency, Zod validation, full audit trail.
 */
import { z } from 'zod'
import type { NextApiRequest, NextApiResponse } from 'next'
import { withApiHandler } from '../../../lib/api-handler'
import { writeAudit } from '../../../lib/audit'
import { sendWhatsAppSmart } from '../../../lib/whatsapp'
import { sendEmail } from '../../../lib/email'
import { NotFoundError, ValidationError, ConflictError, ForbiddenError, DatabaseError } from '../../../lib/errors'
import type { EngagementStatus } from '../../../lib/types/domain'

const SPONSOR_TYPES = ['pharma','biotech','cro']
const APP_URL = process.env.NEXTAUTH_URL || 'https://trialmatch.in'

const InitiateSchema = z.object({
  protocol_id:     z.string().uuid('Invalid protocol ID'),
  site_org_id:     z.string().uuid().optional(),
  site_profile_id: z.string().uuid().optional(),
  message:         z.string().max(1000).optional(),
}).refine(d => d.site_org_id || d.site_profile_id, {
  message: 'Either site_org_id or site_profile_id is required',
})

const RespondSchema = z.object({
  status:               z.enum(['interested','declined','meeting_booked']),
  coordinator_response: z.string().min(10).max(2000).optional(),
}).refine(d => d.status !== 'interested' || !!d.coordinator_response?.trim(), {
  message: 'A response describing site capacity and availability is required when expressing interest.',
  path:    ['coordinator_response'],
})

const TRANSITIONS: Record<EngagementStatus, EngagementStatus[]> = {
  requested:            ['coordinator_notified'],
  coordinator_notified: ['interested','declined'],
  interested:           ['meeting_booked','closed'],
  declined:             ['closed'],
  meeting_booked:       ['closed'],
  closed:               [],
}

export default withApiHandler(async (req, res, ctx) => {
  const { org, db, user } = ctx
  const isSponsor = SPONSOR_TYPES.includes(org.org_type)

  if (req.method === 'GET') {
    let q = db.from('site_engagement_requests')
      .select('*,protocols(title,phase,therapeutic_area),india_site_profiles(institution_name,city,state)')
      .order('created_at', { ascending: false }).limit(100)
    q = isSponsor ? q.eq('sponsor_org_id', org.id) : q.eq('site_org_id', org.id)
    const { data, error } = await q
    if (error) throw new DatabaseError('list engagements', error.message)

    // Identity reveal: once coordinator says "interested" or beyond,
    // both parties see each other. Before that, sponsor is anonymous.
    // Load org names for revealed engagements only.
    const revealedStatuses = ["interested", "meeting_booked", "closed"]
    const requests = await Promise.all((data || []).map(async (req: any) => {
      if (!revealedStatuses.includes(req.status)) return req

      // Coordinator sees sponsor org name
      if (!isSponsor && req.sponsor_org_id) {
        const { data: sponsorOrg } = await db
          .from('organizations').select('name, city, org_type').eq('id', req.sponsor_org_id).single()
        req.sponsor_org = sponsorOrg || null
      }

      // Sponsor sees site org name + contact email (generic org contact, not personal)
      if (isSponsor && req.site_org_id) {
        const { data: siteOrg } = await db
          .from('organizations').select('name, city').eq('id', req.site_org_id).single()
        const { data: siteAdmins } = await db
          .from('users').select('email').eq('org_id', req.site_org_id)
          .eq('role', 'admin').eq('is_active', true).limit(1)
        req.site_org = siteOrg || null
        req.site_contact_email = siteAdmins?.[0]?.email || null
      }

      return req
    }))

    return void res.json({ requests })
  }

  if (req.method === 'PATCH') {
    if (isSponsor) throw new ForbiddenError('Only site coordinators can respond to engagement requests.')
    if (!req.query.id) throw new ValidationError('id is required', { id:'Required' })

    const parsed = RespondSchema.safeParse(req.body)
    if (!parsed.success) {
      const fe: Record<string,string> = {}
      for (const i of parsed.error.issues) fe[i.path.join('.')] = i.message
      throw new ValidationError(parsed.error.issues[0].message, fe)
    }

    const { status, coordinator_response } = parsed.data

    const { data: current } = await db.from('site_engagement_requests').select('*').eq('id', req.query.id).eq('site_org_id', org.id).single()
    if (!current) throw new NotFoundError('Engagement request', req.query.id as string)

    if (!(TRANSITIONS[current.status as EngagementStatus] || []).includes(status)) {
      throw new ValidationError(`Cannot move from '${current.status}' to '${status}'. This request may have already been responded to.`, { status: 'Invalid transition' })
    }

    const { data: updated, error } = await db.from('site_engagement_requests')
      .update({ status, coordinator_response: coordinator_response || null, responded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', req.query.id).eq('site_org_id', org.id).select().single()

    if (error || !updated) throw new DatabaseError('respond to engagement', error?.message || 'Update failed')

    writeAudit({ action:'engagement:responded', org_id:org.id, user_id:user.id, entity_type:'site_engagement_requests', entity_id:updated.id, before_state:{ status:current.status }, after_state:{ status, has_response:!!coordinator_response }, ip_address:ctx.ipAddress })

    // Notify sponsor (non-blocking)
    ;(async () => {
      const { data: admins } = await db.from('users').select('phone,email').eq('org_id', updated.sponsor_org_id).eq('role','admin').eq('is_active',true)
      const statusText = status === 'interested' ? 'expressed interest ✅' : status === 'declined' ? 'declined ❌' : 'booked a meeting 📅'
      const msg = `📩 TrialMatch India\n\nA site has ${statusText} your engagement request.${coordinator_response ? `\n\nMessage: "${coordinator_response.slice(0,300)}"` : ''}\n\nView in dashboard: ${APP_URL}/dashboard`

      // WhatsApp templates can't carry the variable-length response text —
      // GUPSHUP_TEMPLATE_ENGAGEMENT_SPONSOR body: "A site has responded {{1}} to your engagement request. View: {{2}}"
      const templateParams = [statusText.replace(/[✅❌📅]/g, '').trim(), `${APP_URL}/dashboard`]

      for (const a of admins || []) {
        if (a.phone) await sendWhatsAppSmart('engagement_notify_sponsor', a.phone, templateParams, msg)
        // Previously this notification had no email path at all — if WhatsApp
        // failed (guaranteed without an approved template), the sponsor never
        // learned a coordinator had responded, through any channel.
        if (a.email) {
          try {
            await sendEmail({
              to:      a.email,
              subject: `A site has responded to your engagement request`,
              html:    `<p>A site has <strong>${statusText.replace(/[✅❌📅]/g, '').trim()}</strong> your engagement request.</p>${coordinator_response ? `<p><em>"${coordinator_response}"</em></p>` : ''}<p><a href="${APP_URL}/dashboard">View in TrialMatch dashboard</a></p>`,
            })
          } catch {}
        }
      }
    })().catch(() => {})

    return void res.json({ request: updated })
  }

  if (req.method !== 'POST') return void res.status(405).end()
  if (!isSponsor) throw new ForbiddenError('Only sponsor organisations can initiate site engagements.')

  const parsed = InitiateSchema.safeParse(req.body)
  if (!parsed.success) {
    const fe: Record<string,string> = {}
    for (const i of parsed.error.issues) fe[i.path.join('.')] = i.message
    throw new ValidationError(parsed.error.issues[0].message, fe)
  }

  const { protocol_id, site_org_id, site_profile_id, message: sponsorMessage } = parsed.data

  const { data: protocol } = await db.from('protocols').select('id,title,phase,therapeutic_area,status').eq('id', protocol_id).eq('org_id', org.id).single()
  if (!protocol) throw new NotFoundError('Protocol', protocol_id)
  if (protocol.status === 'archived') throw new ValidationError('Cannot engage using an archived protocol.', { protocol_id:'Protocol is archived' })

  // Non-partner: return invite link
  if (!site_org_id && site_profile_id) {
    const { data: sp } = await db.from('india_site_profiles').select('institution_name,city').eq('id', site_profile_id).single()
    const inviteLink = `${APP_URL}/auth/signin?utm_source=sponsor_engage&ref_site=${site_profile_id}&ref_sponsor=${org.id}`
    writeAudit({ action:'engagement:invite_link_generated', org_id:org.id, user_id:user.id, entity_type:'india_site_profiles', entity_id:site_profile_id, metadata:{ protocol_id }, ip_address:ctx.ipAddress })
    return void res.json({ non_partner:true, site_name:sp?.institution_name||'Site', invite_link:inviteLink, message:`${sp?.institution_name||'This site'} is not yet a TrialMatch partner. Share the invite link with their research coordinator.` })
  }

  // Idempotency check
  const { data: existing } = await db.from('site_engagement_requests').select('id,status').eq('protocol_id',protocol_id).eq('sponsor_org_id',org.id).eq('site_org_id',site_org_id).not('status','in','("declined","closed")').maybeSingle()
  if (existing) throw new ConflictError('An active engagement request already exists for this site and protocol.', { existing_id:existing.id, status:existing.status })

  const { data: request, error: insertErr } = await db.from('site_engagement_requests')
    .insert({ protocol_id, sponsor_org_id:org.id, site_org_id, status:'requested', sponsor_message:sponsorMessage||null, notified_via:'both' })
    .select().single()

  if (insertErr || !request) throw new DatabaseError('create engagement', insertErr?.message||'Insert failed')

  writeAudit({ action:'engagement:initiated', org_id:org.id, user_id:user.id, entity_type:'site_engagement_requests', entity_id:request.id, after_state:{ protocol_id, site_org_id, status:'requested' }, ip_address:ctx.ipAddress })

  // Notify coordinators (non-blocking)
  let notified = false
  ;(async () => {
    const { data: admins } = await db.from('users').select('email,phone').eq('org_id', site_org_id).eq('role','admin').eq('is_active',true)
    if (!admins?.length) return
    const area  = protocol.therapeutic_area || 'clinical research'
    const phase = protocol.phase || 'clinical study'
    const waMsg = `🔬 TrialMatch India\n\nA sponsor is interested in your site for a ${area} trial (${phase}).\n\nLog in to respond:\n${APP_URL}/dashboard\n\nGo to Engagements tab.${sponsorMessage ? `\n\n"${sponsorMessage.slice(0,200)}"` : ''}`

    // WhatsApp templates can't carry the optional sponsor message text —
    // GUPSHUP_TEMPLATE_ENGAGEMENT_COORDINATOR body:
    // "A sponsor is interested in your site for a {{1}} trial. View and respond: {{2}}"
    const templateParams = [area, `${APP_URL}/dashboard`]

    for (const a of admins) {
      const result = await sendWhatsAppSmart('engagement_notify_coordinator', a.phone || '', templateParams, waMsg)
      if (a.phone && result.channel !== 'none') notified = true
      if (a.email) { try { await sendEmail({ to:a.email, subject:`Site engagement request — ${area} trial`, html:`<p>A sponsor is interested in your site for a <strong>${area}</strong> study (${phase}).</p><p>Log in to <a href="${APP_URL}/dashboard">TrialMatch India</a> — go to the Engagements tab to respond.</p>` }); notified = true } catch {} }
    }
    if (notified) await db.from('site_engagement_requests').update({ status:'coordinator_notified', notified_at:new Date().toISOString() }).eq('id',request.id)
  })().catch(() => {})

  return void res.status(201).json({ request_id:request.id, notified, message:'Engagement request sent. The site coordinator will be notified via WhatsApp and email.' })
}, { methods: ['GET','POST','PATCH'] })
