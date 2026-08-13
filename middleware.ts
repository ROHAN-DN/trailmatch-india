/**
 * middleware.ts
 *
 * The single, universal enforcement point for "has this session
 * completed MFA, if its role requires it." Deliberately centralized
 * rather than added to each route individually: this codebase has 13
 * routes using the shared lib/api-handler.ts wrapper and 20 more with
 * their own inline getServerSession calls (confirmed by grep before
 * writing this) — asking a security control to depend on 20+ separate
 * files being updated consistently and correctly is a real, concrete
 * risk of one being missed. Middleware runs on every request regardless.
 *
 * Deliberate design tradeoff, stated plainly: this reads mfaRequired and
 * mfaVerified from the JWT (via getToken(), no DB call — this needs to
 * be cheap, it runs on every single request) rather than freshly
 * re-querying the user's current role on every request. mfaRequired is
 * baked in at sign-in time (see pages/api/auth/[...nextauth].ts's jwt
 * callback) and can go stale for the lifetime of a session (up to the
 * 30-day maxAge) if a role changes mid-session. This is NOT the only
 * enforcement layer, specifically to close that gap: lib/api-handler.ts's
 * withApiHandler ALSO checks session.user.mfaStatus, which the session
 * callback recomputes fresh from the database on every call (same
 * pattern this codebase already used for role/org_id before MFA
 * existed). For the 13 routes using that wrapper, enforcement is always
 * fresh regardless of this middleware. For everything else, this
 * middleware is the backstop — fast and universal, with a known,
 * documented, bounded staleness window instead of no coverage at all.
 *
 * mfaVerified itself (as opposed to mfaRequired) does NOT have this
 * staleness problem — it's set to false at sign-in and only ever flipped
 * to true by an explicit client-triggered session update() after
 * pages/api/mfa/verify.ts confirms a real code, so it's always accurate
 * for whatever it claims to represent.
 */

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'

// Paths that stay reachable regardless of MFA status — either because
// they're how a person becomes verified in the first place (the MFA
// routes themselves would be unreachable, permanently locking out
// exactly the person trying to complete the check, if they weren't
// exempt), or because they don't represent a logged-in user's own
// session at all (webhooks and cron jobs authenticate with their own
// secret, not a user's session — see pages/api/billing/webhook.ts and
// pages/api/cron/*.ts).
const MFA_EXEMPT_PREFIXES = [
  '/api/auth',             // NextAuth's own routes (signin, callback, session, csrf, signout)
  '/api/mfa',              // the MFA setup/verify/disable routes themselves
  '/api/billing/webhook',  // Stripe signature auth, not a user session
  '/api/cron',             // CRON_SECRET auth, not a user session
  '/api/abdm/callback',    // external redirect, session-ID validated separately (see scripts/security-audit.js's own check for this)
  '/auth',                 // signin/error/verify/mfa-challenge/mfa-enroll pages
]

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (MFA_EXEMPT_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next()
  }

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) {
    // No session at all — not this middleware's job to enforce login.
    // Every route already has its own real auth check (withApiHandler or
    // an inline getServerSession call); this only ever gates an
    // ALREADY-authenticated session that hasn't cleared MFA yet.
    return NextResponse.next()
  }

  if (!token.mfaRequired || token.mfaVerified) {
    return NextResponse.next()
  }

  // A real, logged-in session, whose role required MFA at sign-in, that
  // has not completed a step-up challenge this session.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'MFA verification required to continue. Complete your authenticator check first.' },
      { status: 403 }
    )
  }

  // The mfa-challenge page itself checks the fresh, DB-backed
  // session.user.mfaStatus (must_enroll vs must_verify) client-side and
  // shows the right flow — this redirect's only job is getting the
  // person there.
  const redirectUrl = new URL('/auth/mfa-challenge', req.url)
  redirectUrl.searchParams.set('from', pathname)
  return NextResponse.redirect(redirectUrl)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
