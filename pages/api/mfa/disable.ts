import type { NextApiRequest, NextApiResponse } from 'next'
import { withApiHandler, type ApiContext } from '../../../lib/api-handler'
import { writeAudit, extractRequestContext } from '../../../lib/audit'
import { decryptSecret, verifyTOTPCode } from '../../../lib/mfa'

// Disabling MFA needs to prove the requester still controls the
// authenticator device — otherwise a hijacked session alone (without the
// device) could turn off the account's second factor. This app has no
// password to re-check (Google OAuth / magic-link only), so a currently
// valid TOTP code is the equivalent re-authentication step here.
async function handler(req: NextApiRequest, res: NextApiResponse, ctx: ApiContext) {
  const { code } = req.body
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'A current 6-digit code is required to disable MFA.' })
  }

  const { data: user } = await ctx.db.from('users')
    .select('mfa_enabled, mfa_secret_encrypted, mfa_last_time_step').eq('id', ctx.user.id).single()

  if (!user?.mfa_enabled) {
    return res.status(400).json({ error: 'MFA is not currently enabled.' })
  }

  let secret: string
  try {
    secret = decryptSecret(user.mfa_secret_encrypted)
  } catch {
    return res.status(500).json({ error: 'Could not verify the current code. Please try again.' })
  }

  const result = await verifyTOTPCode(secret, code, user.mfa_last_time_step)
  const reqCtx = extractRequestContext(req as any)
  if (!result.valid) {
    writeAudit({ action: 'auth:mfa_failed', org_id: ctx.org.id, user_id: ctx.user.id, ...reqCtx, outcome: 'failure', metadata: { stage: 'disable' } })
    return res.status(401).json({ error: 'Invalid code — MFA was not disabled.' })
  }

  await ctx.db.from('users').update({
    mfa_enabled:           false,
    mfa_secret_encrypted:  null,
    mfa_backup_codes:      [],
    mfa_last_time_step:    null,
    mfa_enrolled_at:       null,
  }).eq('id', ctx.user.id)

  writeAudit({ action: 'auth:mfa_disabled', org_id: ctx.org.id, user_id: ctx.user.id, ...reqCtx, outcome: 'success' })
  return res.status(200).json({ disabled: true })
}

export default withApiHandler(handler, { methods: ['POST'] })
