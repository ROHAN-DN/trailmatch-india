/**
 * pages/api/pi-contacts/index.ts
 * GET  → search PI directory (by nct_id, city, specialty, institution, search)
 * POST → log an outreach attempt
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user = session.user as any
  const db   = supabaseAdmin()

  if (req.method === 'GET') {
    const { nct_id, ctri_id, city, specialty, institution, search, page = '1' } = req.query
    const limit  = 20
    const offset = (+page - 1) * limit

    let query = db.from('pi_contacts').select('*', { count: 'exact' }).eq('email_bounced', false)

    if (nct_id)      query = query.eq('nct_id', nct_id as string)
    if (ctri_id)     query = query.eq('ctri_id', ctri_id as string)
    if (city)        query = query.ilike('pi_city', `%${city}%`)
    if (specialty)   query = query.eq('specialty', specialty as string)
    if (institution) query = query.ilike('pi_institution', `%${institution}%`)
    if (search) query = query.or(`pi_name.ilike.%${search}%,pi_institution.ilike.%${search}%,trial_title.ilike.%${search}%`)

    const { data, count, error } = await query
      // Supabase's .order() takes `nullsFirst`, not `nullsLast` — the latter
      // isn't a recognised option and was silently ignored, so PIs with no
      // response_rate yet were sorting by Postgres's DESC default (NULLS
      // FIRST) — i.e. showing up at the TOP of the list ahead of PIs with an
      // actual known response rate. `nullsFirst: false` is the correct way
      // to express "nulls last" here.
      .order('response_rate', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return res.status(500).json({ error: error.message })
    return res.json({ contacts: data || [], total: count || 0, page: +page })
  }

  if (req.method === 'POST') {
    const { pi_contact_id, patient_id, match_result_id, action, notes } = req.body
    if (!pi_contact_id || !action) {
      return res.status(400).json({ error: 'pi_contact_id and action are required' })
    }

    const { error: logErr } = await db.from('pi_outreach_log').insert({
      org_id: user.org_id, user_id: user.id, pi_contact_id,
      patient_id: patient_id || null, match_result_id: match_result_id || null,
      action, notes: notes || null,
    })
    if (logErr) return res.status(500).json({ error: logErr.message })

    if (['email_sent', 'whatsapp_sent', 'phone_called'].includes(action)) {
      await db.rpc('increment_pi_contacted', { pi_id: pi_contact_id })
    }
    if (action === 'pi_responded') {
      await db.rpc('increment_pi_responded', { pi_id: pi_contact_id })
    }

    await db.from('audit_log').insert({
      org_id: user.org_id, user_id: user.id, action: 'pi_outreach_logged',
      entity: 'pi_contact', entity_id: pi_contact_id,
      metadata: { action, patient_id, match_result_id },
    })

    return res.json({ success: true })
  }

  res.setHeader('Allow', ['GET', 'POST'])
  res.status(405).end()
}
