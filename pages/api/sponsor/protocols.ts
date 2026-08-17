/**
 * pages/api/sponsor/protocols.ts — Production rewrite
 * Full Zod validation, audit logging, typed errors, api-handler wrapper.
 */
import { z } from 'zod'
import type { NextApiRequest, NextApiResponse } from 'next'
import { withApiHandler } from '../../../lib/api-handler'
import { parseProtocol } from '../../../lib/protocol-parser'
import { writeAudit } from '../../../lib/audit'
import { NotFoundError, ValidationError, DatabaseError } from '../../../lib/errors'
import type { ProtocolCreate } from '../../../lib/types/domain'

const SPONSOR_TYPES = ['pharma', 'biotech', 'cro'] as const

const ProtocolCreateSchema = z.object({
  title:              z.string().min(3, 'Title must be at least 3 characters').max(300),
  raw_text:           z.string().max(50_000).optional(),
  phase:              z.enum(['Phase I','Phase II','Phase III','Phase IV','Phase I/II','Phase II/III']).optional(),
  therapeutic_area:   z.string().max(100).optional(),
  inclusion_criteria: z.array(z.object({
    field:    z.string(),
    operator: z.string(),
    value:    z.union([z.string(), z.number(), z.array(z.number()).length(2)]),
    label:    z.string(),
  })).optional(),
  exclusion_criteria: z.array(z.object({
    field:    z.string(),
    operator: z.string(),
    value:    z.union([z.string(), z.number(), z.array(z.number()).length(2)]),
    label:    z.string(),
  })).optional(),
  parse_with_ai: z.boolean().optional(),
})

const ProtocolUpdateSchema = ProtocolCreateSchema.partial().extend({
  status:  z.enum(['draft','active','archived']).optional(),
  reparse: z.boolean().optional(),
})

export default withApiHandler(
  async (req, res, ctx) => {
    const { org, db, user } = ctx

    if (!SPONSOR_TYPES.includes(org.org_type as any)) {
      return res.status(403).json({ error: {
        code:    'WRONG_ORG_TYPE',
        message: 'The sponsor portal is available to pharma, biotech, and CRO organisations only.',
      }})
    }

    // ── GET single ─────────────────────────────────────────────────────
    if (req.method === 'GET' && req.query.id) {
      const { data, error } = await db
        .from('protocols')
        .select('*')
        .eq('id', req.query.id as string)
        .eq('org_id', org.id)
        .single()

      if (error || !data) throw new NotFoundError('Protocol', req.query.id as string)

      writeAudit({ action:'feasibility:result_viewed', org_id:org.id, user_id:user.id, entity_type:'protocols', entity_id:data.id, ip_address:ctx.ipAddress })
      return res.json({ protocol: data })
    }

    // ── GET list ────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { data, error } = await db
        .from('protocols')
        .select('id,title,phase,therapeutic_area,status,parsed_by_ai,mapped_codes,created_at,updated_at')
        .eq('org_id', org.id)
        .neq('status', 'archived')
        .order('created_at', { ascending: false })

      if (error) throw new DatabaseError('list protocols', error.message)
      return res.json({ protocols: data || [] })
    }

    // ── POST: create ────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const parsed = ProtocolCreateSchema.safeParse(req.body)
      if (!parsed.success) {
        const fieldErrors: Record<string,string> = {}
        for (const issue of parsed.error.issues) fieldErrors[issue.path.join('.')] = issue.message
        throw new ValidationError('Invalid protocol data.', fieldErrors)
      }

      const body = parsed.data
      let inclusion_criteria = body.inclusion_criteria || []
      let exclusion_criteria = body.exclusion_criteria || []
      let mapped_codes       = { icd10:[], snomed:[], loinc:[] }
      let parsed_title       = body.title
      let parsed_phase       = body.phase
      let parsed_area        = body.therapeutic_area
      let parsed_by_ai       = false
      let parse_warning:string | undefined

      // AI parse if raw_text provided
      if (body.raw_text && body.parse_with_ai !== false) {
        try {
          const aiResult = await parseProtocol(body.raw_text, org.id)
          if (aiResult.inclusion_criteria.length > 0 || aiResult.exclusion_criteria.length > 0) {
            inclusion_criteria = aiResult.inclusion_criteria
            exclusion_criteria = aiResult.exclusion_criteria
            mapped_codes       = aiResult.mapped_codes
            parsed_title       = body.title || aiResult.title || 'Untitled Protocol'
            parsed_phase       = body.phase  || aiResult.phase as any
            parsed_area        = body.therapeutic_area || aiResult.therapeutic_area
            parsed_by_ai       = true
          } else {
            parse_warning = 'AI parsing produced no criteria. Please add criteria manually.'
          }
        } catch (e: any) {
          parse_warning = 'AI parsing failed. Protocol saved — please add criteria manually.'
          console.error('[protocol-parser] AI parse failed:', e.message)
        }
      }

      const { data, error } = await db
        .from('protocols')
        .insert({
          org_id:             org.id,
          created_by:         user.id,
          title:              parsed_title,
          phase:              parsed_phase,
          therapeutic_area:   parsed_area,
          inclusion_criteria,
          exclusion_criteria,
          mapped_codes,
          raw_text:           body.raw_text,
          parsed_by_ai,
          status:             'draft',
        })
        .select()
        .single()

      if (error) throw new DatabaseError('create protocol', error.message)

      writeAudit({ action:'protocol:uploaded', org_id:org.id, user_id:user.id, entity_type:'protocols', entity_id:data.id, after_state:{ title:data.title, phase:data.phase, parsed_by_ai }, ip_address:ctx.ipAddress, metadata:{ criterion_count: inclusion_criteria.length + exclusion_criteria.length } })
      if (parsed_by_ai) writeAudit({ action:'protocol:ai_parsed', org_id:org.id, user_id:user.id, entity_type:'protocols', entity_id:data.id, ip_address:ctx.ipAddress })

      return res.status(201).json({ protocol: data, warning: parse_warning })
    }

    // ── PATCH: update ───────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      if (!req.query.id) throw new ValidationError('Protocol id is required', { id: 'Required' })

      const parsed = ProtocolUpdateSchema.safeParse(req.body)
      if (!parsed.success) {
        const fieldErrors: Record<string,string> = {}
        for (const issue of parsed.error.issues) fieldErrors[issue.path.join('.')] = issue.message
        throw new ValidationError('Invalid update data.', fieldErrors)
      }

      const body = parsed.data
      const update: Record<string,any> = { updated_at: new Date().toISOString() }
      const allowed = ['title','phase','therapeutic_area','inclusion_criteria','exclusion_criteria','status','mapped_codes']
      for (const k of allowed) if ((body as any)[k] !== undefined) update[k] = (body as any)[k]

      if (body.raw_text && body.reparse) {
        try {
          const aiResult = await parseProtocol(body.raw_text, org.id)
          if (aiResult.inclusion_criteria.length > 0) {
            update.inclusion_criteria = aiResult.inclusion_criteria
            update.exclusion_criteria = aiResult.exclusion_criteria
            update.mapped_codes       = aiResult.mapped_codes
            update.parsed_by_ai       = true
            update.raw_text           = body.raw_text
            writeAudit({ action:'protocol:ai_parsed', org_id:org.id, user_id:user.id, entity_type:'protocols', entity_id:req.query.id as string, ip_address:ctx.ipAddress })
          }
        } catch (e: any) { console.error('[protocol-parser] Reparse failed:', e.message) }
      }

      const { data, error } = await db
        .from('protocols').update(update).eq('id', req.query.id as string).eq('org_id', org.id).select().single()

      if (error || !data) throw new NotFoundError('Protocol', req.query.id as string)

      writeAudit({ action:'protocol:updated', org_id:org.id, user_id:user.id, entity_type:'protocols', entity_id:data.id, after_state:{ status:data.status, title:data.title }, ip_address:ctx.ipAddress })
      return res.json({ protocol: data })
    }

    // ── DELETE: archive ─────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (!req.query.id) throw new ValidationError('Protocol id is required', { id:'Required' })

      await db.from('protocols').update({ status:'archived', updated_at:new Date().toISOString() }).eq('id', req.query.id as string).eq('org_id', org.id)

      writeAudit({ action:'protocol:archived', org_id:org.id, user_id:user.id, entity_type:'protocols', entity_id:req.query.id as string, ip_address:ctx.ipAddress })
      return res.json({ ok: true })
    }
  },
  { methods: ['GET','POST','PATCH','DELETE'] }
)
