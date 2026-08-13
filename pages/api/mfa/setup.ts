import type { NextApiRequest, NextApiResponse } from 'next'
import { withApiHandler, type ApiContext } from '../../../lib/api-handler'
import { generateTOTPSecret, buildOtpAuthUri, generateEnrollmentQRCode, encryptSecret } from '../../../lib/mfa'

// Step 1 of enrollment: generate a fresh secret, store it encrypted but
// NOT yet enabled (mfa_enabled stays false until verify-setup confirms
// the user actually has it in a real authenticator app — see that
// route's own comment for why this two-step confirmation matters).
// Any authenticated user can call this for their OWN account; there is
// no privileged-role check here deliberately — MFA is opt-in-available
// to everyone, only ENFORCED (via middleware.ts) for owner/admin.
async function handler(req: NextApiRequest, res: NextApiResponse, ctx: ApiContext) {
  const secret = generateTOTPSecret()
  const uri = buildOtpAuthUri(secret, ctx.user.email)
  const qrCodeDataUrl = await generateEnrollmentQRCode(uri)

  await ctx.db.from('users')
    .update({ mfa_secret_encrypted: encryptSecret(secret), mfa_enabled: false })
    .eq('id', ctx.user.id)

  // The secret is returned in plaintext here ONLY as manual-entry
  // fallback text for authenticator apps that can't scan a QR code —
  // standard practice (every real-world TOTP enrollment flow does this).
  // It is never returned again after this response; only the encrypted
  // form is ever stored.
  return res.status(200).json({ secret, qrCodeDataUrl })
}

export default withApiHandler(handler, { methods: ['POST'], skipMfaCheck: true })
