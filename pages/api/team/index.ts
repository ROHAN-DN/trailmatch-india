import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'
import { checkLimit } from '../../../lib/gate'
import { Resend } from 'resend'

const resendClient = () => new Resend(process.env.RESEND_API_KEY) // lazy — see lib/email.ts for why (eager construction throws when RESEND_API_KEY is unset, crashing `next build`)

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user = session.user as any
  const db   = supabaseAdmin()

  // ── GET — list team ───────────────────────────────────────────
  if (req.method === 'GET') {
    const { data: members } = await db.from('users')
      .select('id, name, email, role, last_login, created_at')
      .eq('org_id', user.org_id)
      .eq('is_active', true)
      .order('created_at')

    const { data: invites } = await db.from('invitations')
      .select('id, email, role, created_at, expires_at')
      .eq('org_id', user.org_id)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())

    return res.json({ members: members || [], invites: invites || [] })
  }

  // Only admins/owners can modify team
  if (!['owner', 'admin'].includes(user.role)) {
    return res.status(403).json({ error: 'Admin access required' })
  }

  // ── POST — invite member ──────────────────────────────────────
  if (req.method === 'POST') {
    const { email, role = 'member' } = req.body
    if (!email) return res.status(400).json({ error: 'Email required' })

    // max_users was never enforced anywhere in this file — an org at its
    // plan's user cap could send unlimited invites. This is a best-effort
    // early check (doesn't account for other pending invites also not
    // yet accepted) — the check that actually matters for correctness is
    // in the signIn callback (pages/api/auth/[...nextauth].ts), which is
    // the real point a new users row gets created. This one exists so
    // the admin sending the invite gets a clear answer now instead of the
    // invitee being silently blocked later.
    const userGate = await checkLimit(user.org_id, 'users')
    if (!userGate.allowed) return res.status(402).json({ error: userGate.message, upgrade: userGate.upgrade })

    // Check if already a member
    const { data: existing } = await db.from('users').select('id').eq('email', email).single()
    if (existing) return res.status(409).json({ error: 'User already a member' })

    // Create / refresh invite
    const { data: invite, error } = await db.from('invitations')
      .upsert({ org_id: user.org_id, invited_by: user.id, email, role }, { onConflict: 'org_id,email' })
      .select().single()

    if (error) return res.status(500).json({ error: error.message })

    // Fetch org name for email
    const { data: org } = await db.from('organizations').select('name').eq('id', user.org_id).single()

    const acceptUrl = `${process.env.NEXT_PUBLIC_APP_URL}/auth/accept-invite?token=${invite.token}`

    await resendClient().emails.send({
      from:    process.env.RESEND_FROM_EMAIL!,
      to:      email,
      subject: `You've been invited to ${org?.name} on TrialMatch India`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
          <div style="background:#0F6E56;padding:18px 24px;border-radius:10px 10px 0 0">
            <h1 style="color:#fff;margin:0;font-size:18px;font-weight:500">TrialMatch India</h1>
          </div>
          <div style="background:#fff;padding:28px 24px;border:1px solid #E2E0D8;border-top:none;border-radius:0 0 10px 10px">
            <p style="color:#1C1B18;font-size:15px;line-height:1.6;margin:0 0 8px">
              <strong>${user.name || user.email}</strong> has invited you to join
              <strong>${org?.name}</strong> on TrialMatch India as a <strong>${role}</strong>.
            </p>
            <p style="color:#72706A;font-size:13px;line-height:1.6;margin:0 0 20px">
              TrialMatch India is an AI-powered clinical trial matching platform for India.
            </p>
            <a href="${acceptUrl}" style="display:inline-block;background:#0F6E56;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px">
              Accept invitation
            </a>
            <p style="color:#B4B2A9;font-size:11px;margin:20px 0 0;line-height:1.6">
              This invitation expires in 7 days. If you didn't expect this, you can ignore it.
            </p>
          </div>
        </div>`,
    })

    return res.status(201).json({ invite })
  }

  // ── PATCH — change role ───────────────────────────────────────
  if (req.method === 'PATCH') {
    const { user_id, role } = req.body
    if (!['member', 'admin', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' })
    }
    // Prevent demoting last owner
    if (user_id === user.id) return res.status(400).json({ error: 'Cannot change your own role' })

    const { error } = await db.from('users')
      .update({ role })
      .eq('id', user_id)
      .eq('org_id', user.org_id)

    if (error) return res.status(500).json({ error: error.message })
    return res.json({ success: true })
  }

  // ── DELETE — remove member or cancel invite ───────────────────
  if (req.method === 'DELETE') {
    const { user_id, invite_id } = req.body

    if (invite_id) {
      await db.from('invitations').delete().eq('id', invite_id).eq('org_id', user.org_id)
      return res.json({ success: true })
    }

    if (user_id === user.id) return res.status(400).json({ error: 'Cannot remove yourself' })
    await db.from('users').update({ is_active: false }).eq('id', user_id).eq('org_id', user.org_id)
    return res.json({ success: true })
  }

  res.setHeader('Allow', ['GET', 'POST', 'PATCH', 'DELETE'])
  res.status(405).end()
}
