/**
 * lib/api-handler.ts
 * Production API handler wrapper. Used by every Phase 2 API route.
 *
 * Provides: auth, method guard, org type gate, audit logging, error serialisation.
 *
 * Session shape from NextAuth: session.user.org_id (snake_case — see [...nextauth].ts)
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth/next'
import { supabaseAdmin } from './supabase'
import { writeAudit, extractRequestContext, type AuditAction } from './audit'
import {
  AppError, UnauthorisedError, WrongOrgTypeError,
  serialiseError, toAppError,
} from './errors'
import type { OrgType, Organization } from './types/domain'

export interface ApiContext {
  user:      { id: string; org_id: string; email: string; role: string }
  org:       Organization
  db:        ReturnType<typeof supabaseAdmin>
  requestId: string
  ipAddress: string
  userAgent: string
}

export interface ApiHandlerOptions {
  methods?:     string[]
  orgTypes?:    OrgType[]
  audit?:       AuditAction
  auditEntity?: string
  /**
   * Exempts this route from the MFA-verified check below. Only ever
   * needed by the MFA setup/verification routes themselves
   * (pages/api/mfa/setup.ts, verify-setup.ts, verify.ts) — an unverified
   * session must still be able to reach the routes that let it become
   * verified, or enrollment/login step-up would be a permanent
   * deadlock. pages/api/mfa/disable.ts deliberately does NOT set this —
   * disabling MFA should require already being verified this session,
   * not just being mid-enrollment.
   */
  skipMfaCheck?: boolean
}

type ApiHandlerFn = (req: NextApiRequest, res: NextApiResponse, ctx: ApiContext) => Promise<void>

export function withApiHandler(fn: ApiHandlerFn, options: ApiHandlerOptions = {}) {
  return async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
    const { methods, orgTypes, audit, auditEntity } = options
    const reqCtx = extractRequestContext(req as any)

    // Method guard
    if (methods && !methods.includes(req.method || '')) {
      res.setHeader('Allow', methods.join(', '))
      return void res.status(405).json({ error: { code:'METHOD_NOT_ALLOWED', message:`Method ${req.method} not allowed.` } })
    }

    // Auth — import authOptions lazily to avoid circular dep issues
    let session: any
    try {
      const { authOptions } = await import('../pages/api/auth/[...nextauth]')
      session = await getServerSession(req, res, authOptions)
    } catch {
      return void res.status(500).json({ error: { code:'AUTH_CONFIG', message:'Auth configuration error.' } })
    }

    if (!session?.user) {
      writeAudit({ action:'auth:login_failed', ...reqCtx, outcome:'failure', error_code:'NO_SESSION' })
      return void res.status(401).json({ error: serialiseError(new UnauthorisedError()) })
    }

    // NextAuth sets org_id (snake_case) — see pages/api/auth/[...nextauth].ts
    const sessionUser = session.user as any

    // MFA gate — session.user.mfaStatus is recomputed from a fresh
    // database read on every session callback invocation (see
    // pages/api/auth/[...nextauth].ts's session callback), the same
    // freshness this file already relied on for role/org_id before MFA
    // existed. middleware.ts also enforces this, universally, but from
    // a JWT-only fast path that can go stale for a role change mid-session
    // (see that file's own header comment) — this check is what stays
    // correct regardless, for the 13 routes that go through this wrapper.
    if (!options.skipMfaCheck && sessionUser?.mfaStatus && sessionUser.mfaStatus !== 'verified' && sessionUser.mfaStatus !== 'not_required') {
      return void res.status(403).json({ error: { code: 'MFA_REQUIRED', message: 'MFA verification required to continue.' } })
    }

    const orgId = sessionUser?.org_id || sessionUser?.orgId

    if (!orgId) {
      return void res.status(401).json({ error: serialiseError(
        new UnauthorisedError('Session is missing organisation context. Please sign out and back in.')
      ) })
    }

    // Load org
    const db = supabaseAdmin()
    const { data: org, error: orgErr } = await db
      .from('organizations').select('*').eq('id', orgId).single()

    if (orgErr || !org) {
      return void res.status(401).json({ error: serialiseError(
        new UnauthorisedError('Organisation not found.')
      ) })
    }

    // Org type gate
    if (orgTypes?.length && !orgTypes.includes(org.org_type as OrgType)) {
      const err = new WrongOrgTypeError(orgTypes.join(' or '), org.org_type)
      writeAudit({ action:'security:suspicious_access', org_id:orgId, user_id:sessionUser?.id, ...reqCtx, outcome:'failure', error_code:err.code, metadata:{ required:orgTypes, actual:org.org_type, path:req.url } })
      return void res.status(403).json({ error: serialiseError(err) })
    }

    const ctx: ApiContext = {
      user:      { id: sessionUser.id, org_id: orgId, email: sessionUser.email || '', role: sessionUser.role || 'member' },
      org:       org as Organization,
      db,
      requestId: reqCtx.request_id,
      ipAddress: reqCtx.ip_address,
      userAgent: reqCtx.user_agent,
    }

    try {
      await fn(req, res, ctx)
      if (audit) writeAudit({ action:audit, org_id:orgId, user_id:sessionUser?.id, entity_type:auditEntity, ...reqCtx, outcome:'success' })
    } catch (err: unknown) {
      const appErr = toAppError(err)
      if (appErr.status >= 500) {
        console.error(`[api] ${req.method} ${req.url}`, { code:appErr.code, msg:appErr.message, orgId })
      }
      if (audit) writeAudit({ action:audit, org_id:orgId, user_id:sessionUser?.id, entity_type:auditEntity, ...reqCtx, outcome:'failure', error_code:appErr.code })
      return void res.status(appErr.status).json({ error: serialiseError(appErr) })
    }
  }
}
