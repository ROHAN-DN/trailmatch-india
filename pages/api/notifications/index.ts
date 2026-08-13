import { requireFeature } from '../../../lib/gate'
/**
 * pages/api/notifications/index.ts
 * CRUD for org notification preferences (WhatsApp + email toggles)
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'
import { waitUntil } from '@vercel/functions'

export const config = { maxDuration: 300, externalResolver: true }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user = session.user as any
  const db   = supabaseAdmin()

  // ── GET — fetch notification settings ────────────────────────
  if (req.method === 'GET') {
    const { data } = await db
      .from('org_notifications')
      .select('*')
      .eq('org_id', user.org_id)
      .single()

    return res.json({ settings: data || null })
  }

  // ── PUT — upsert notification settings ───────────────────────
  if (req.method === 'PUT') {
    if (!['owner', 'admin'].includes(user.role)) {
      return res.status(403).json({ error: 'Admin access required' })
    }

    const {
      whatsapp_number,
      notify_on_match_complete,
      notify_on_new_trials,
      notify_on_batch_complete,
      notify_email,
      email_on_match_complete,
      email_on_new_trials,
    } = req.body

    // Validate WhatsApp number format
    if (whatsapp_number) {
      const clean = whatsapp_number.replace(/\D/g, '')
      if (clean.length < 10 || clean.length > 13) {
        return res.status(400).json({ error: 'Invalid WhatsApp number. Use format: 9876543210 or 919876543210' })
      }
    }

    const { data, error } = await db
      .from('org_notifications')
      .upsert({
        org_id:                    user.org_id,
        whatsapp_number:           whatsapp_number || null,
        notify_on_match_complete:  notify_on_match_complete ?? true,
        notify_on_new_trials:      notify_on_new_trials ?? true,
        notify_on_batch_complete:  notify_on_batch_complete ?? true,
        notify_email,
        email_on_match_complete:   email_on_match_complete ?? true,
        email_on_new_trials:       email_on_new_trials ?? true,
        updated_at:                new Date().toISOString(),
      }, { onConflict: 'org_id' })
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })

    await db.from('audit_log').insert({
      org_id:   user.org_id,
      user_id:  user.id,
      action:   'update_notification_settings',
      metadata: { whatsapp_number: !!whatsapp_number },
    })

    return res.json({ settings: data })
  }

  // ── POST — send a test WhatsApp message ───────────────────────
  if (req.method === 'POST') {
    const { action } = req.body

    if (action === 'test_whatsapp') {
      if (!await requireFeature(user.org_id, 'whatsapp', res)) return
      const { data: notifSettings } = await db
        .from('org_notifications')
        .select('whatsapp_number')
        .eq('org_id', user.org_id)
        .single()

      if (!notifSettings?.whatsapp_number) {
        return res.status(400).json({ error: 'No WhatsApp number configured' })
      }

      const { sendWhatsApp } = await import('../../../lib/whatsapp')
      await sendWhatsApp({
        to:      notifSettings.whatsapp_number,
        message: `✅ *TrialMatch India — Test Message*\n\nYour WhatsApp notifications are set up correctly!\n\nYou'll receive match reports and new trial alerts on this number.\n\n_Sent from TrialMatch India_`,
      })

      return res.json({ success: true, message: 'Test message sent' })
    }

    if (action === 'trigger_rematch') {
      if (!await requireFeature(user.org_id, 'rematch', res)) return
      // Manual re-match trigger (admin only)
      if (!['owner', 'admin'].includes(user.role)) {
        return res.status(403).json({ error: 'Admin access required' })
      }
      const { runScheduledRematch } = await import('../../../lib/rematch')
      res.status(202).json({ message: 'Re-match started' })
      waitUntil(runScheduledRematch().catch(console.error))
      return
    }

    return res.status(400).json({ error: 'Unknown action' })
  }

  res.setHeader('Allow', ['GET', 'PUT', 'POST'])
  res.status(405).end()
}
