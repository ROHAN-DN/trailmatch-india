import type { NextApiRequest, NextApiResponse } from 'next'
import { withApiHandler, type ApiContext } from '../../../lib/api-handler'
import { writeAudit, extractRequestContext } from '../../../lib/audit'
import { decryptSecret, verifyTOTPCode, verifyBackupCode } from '../../../lib/mfa'

// Called after primary auth (Google/magic-link) has already succeeded —
// getServerSession returns a real session here, just one middleware.ts
// won't treat as fully authorized yet for a privileged role until this
// endpoint confirms the second factor. The client is responsible for
// calling next-auth's session update() after a successful response here,
// which is what actually flips the JWT's mfaVerified claim (see
// pages/api/auth/[...nextauth].ts's jwt callback) — this endpoint only
// validates the code; it does not and cannot mutate the session token
// directly from a plain API route handler.
async function handler(req: NextApiRequest, res: NextApiResponse, ctx: ApiContext) {
  const { code } = req.body
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'A code is required.' })
  }

  const { data: user } = await ctx.db.from('users')
    .select('mfa_enabled, mfa_secret_encrypted, mfa_last_time_step, mfa_backup_codes')
    .eq('id', ctx.user.id).single()

  if (!user?.mfa_enabled) {
    return res.status(400).json({ error: 'MFA is not enabled on this account.' })
  }

  const reqCtx = extractRequestContext(req as any)
  const normalized = code.trim()

  // Backup codes are formatted with a hyphen (XXXXX-XXXXX) and are never
  // 6 plain digits, so the two are unambiguous to tell apart — try TOTP
  // first (the expected common case), fall back to backup-code matching.
  if (/^\d{6}$/.test(normalized)) {
    let secret: string
    try {
      secret = decryptSecret(user.mfa_secret_encrypted)
    } catch {
      return res.status(500).json({ error: 'Could not verify — please try again or use a backup code.' })
    }

    const result = await verifyTOTPCode(secret, normalized, user.mfa_last_time_step)
    if (result.valid) {
      await ctx.db.from('users').update({ mfa_last_time_step: result.timeStep }).eq('id', ctx.user.id)
      writeAudit({ action: 'auth:mfa_verified', org_id: ctx.org.id, user_id: ctx.user.id, ...reqCtx, outcome: 'success' })
      return res.status(200).json({ verified: true })
    }
  } else {
    const result = verifyBackupCode(normalized, user.mfa_backup_codes || [])
    if (result.valid) {
      // Single-use — remove exactly the matched hash, keep every other
      // unused code intact.
      const remaining = (user.mfa_backup_codes || []).filter((h: string) => h !== result.matchedHash)
      await ctx.db.from('users').update({ mfa_backup_codes: remaining }).eq('id', ctx.user.id)
      writeAudit({ action: 'auth:mfa_backup_code_used', org_id: ctx.org.id, user_id: ctx.user.id, ...reqCtx, outcome: 'success', metadata: { remaining_codes: remaining.length } })
      return res.status(200).json({ verified: true, backupCodeUsed: true, remainingBackupCodes: remaining.length })
    }
  }

  writeAudit({ action: 'auth:mfa_failed', org_id: ctx.org.id, user_id: ctx.user.id, ...reqCtx, outcome: 'failure', metadata: { stage: 'login' } })
  return res.status(401).json({ error: 'Invalid code. Check your authenticator app, or use a backup code.' })
}

export default withApiHandler(handler, { methods: ['POST'], skipMfaCheck: true })
