import type { NextApiRequest, NextApiResponse } from 'next'
import { withApiHandler, type ApiContext } from '../../../lib/api-handler'
import { writeAudit, extractRequestContext } from '../../../lib/audit'
import {
  decryptSecret, verifyTOTPCode,
  generateBackupCodes, hashBackupCode,
} from '../../../lib/mfa'

// Step 2 of enrollment: the user must prove they actually have the
// secret in a working authenticator app — scanning a QR code alone
// doesn't confirm that (the app could be misconfigured, the code could
// have been entered wrong, the user could be looking at the wrong
// account). Only after a real, valid code is submitted does mfa_enabled
// actually flip to true. Backup codes are generated and returned here,
// exactly once — this is the only response that will ever contain them
// in plaintext; only their hashes are stored.
async function handler(req: NextApiRequest, res: NextApiResponse, ctx: ApiContext) {
  const { code } = req.body
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'A 6-digit code is required.' })
  }

  const { data: user } = await ctx.db.from('users')
    .select('mfa_secret_encrypted, mfa_enabled').eq('id', ctx.user.id).single()

  if (!user?.mfa_secret_encrypted) {
    return res.status(400).json({ error: 'No MFA enrollment in progress. Start setup again.' })
  }
  if (user.mfa_enabled) {
    return res.status(400).json({ error: 'MFA is already enabled on this account.' })
  }

  let secret: string
  try {
    secret = decryptSecret(user.mfa_secret_encrypted)
  } catch {
    return res.status(500).json({ error: 'Could not read the pending MFA secret. Please start setup again.' })
  }

  const result = await verifyTOTPCode(secret, code)
  if (!result.valid) {
    const reqCtx = extractRequestContext(req as any)
    writeAudit({ action: 'auth:mfa_failed', org_id: ctx.org.id, user_id: ctx.user.id, ...reqCtx, outcome: 'failure', metadata: { stage: 'enrollment_confirmation' } })
    return res.status(400).json({ error: 'That code is not valid. Check your authenticator app and try again.' })
  }

  const backupCodes = generateBackupCodes()
  await ctx.db.from('users').update({
    mfa_enabled:        true,
    mfa_enrolled_at:     new Date().toISOString(),
    mfa_last_time_step:  result.timeStep,
    mfa_backup_codes:    backupCodes.map(hashBackupCode),
  }).eq('id', ctx.user.id)

  const reqCtx = extractRequestContext(req as any)
  writeAudit({ action: 'auth:mfa_enrolled', org_id: ctx.org.id, user_id: ctx.user.id, ...reqCtx, outcome: 'success' })

  return res.status(200).json({ enabled: true, backupCodes })
}

export default withApiHandler(handler, { methods: ['POST'], skipMfaCheck: true })
