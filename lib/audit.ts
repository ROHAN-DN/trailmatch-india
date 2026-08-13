/**
 * lib/audit.ts
 * Production audit logging for TrialMatch India.
 *
 * Every meaningful action in the system produces an audit record.
 * Required by: DPDP Act 2023, ICH GCP E6(R2), ISO 27001.
 *
 * Design: fire-and-forget writes (non-blocking).
 * The caller never waits for audit writes — system actions are not
 * gated on audit success. However, failures are console.errored and
 * tracked via a counter so ops can detect audit log write failures.
 */

import { supabaseAdmin } from './supabase'
import type { AuditLogEntry } from './types/domain'

export type AuditAction =
  // Auth
  | 'auth:login'
  | 'auth:logout'
  | 'auth:login_failed'
  | 'auth:session_expired'
  | 'auth:mfa_enrolled'
  | 'auth:mfa_disabled'
  | 'auth:mfa_verified'
  | 'auth:mfa_failed'
  | 'auth:mfa_backup_code_used'
  // Patients
  | 'patient:created'
  | 'patient:updated'
  | 'patient:archived'
  | 'patient:viewed_phi'
  | 'patient:bulk_import'
  // Matching
  | 'match:job_started'
  | 'match:job_completed'
  | 'match:result_viewed'
  | 'match:result_exported'
  // Reports
  | 'report:pdf_generated'
  | 'report:pdf_downloaded'
  | 'report:pdf_emailed'
  // Pre-screening
  | 'prescreening:checklist_generated'
  | 'prescreening:checklist_reviewed'
  | 'prescreening:whatsapp_sent'
  // Protocols (Sponsor)
  | 'protocol:uploaded'
  | 'protocol:ai_parsed'
  | 'protocol:updated'
  | 'protocol:archived'
  // Feasibility (Sponsor)
  | 'feasibility:sponsor_run'
  | 'feasibility:result_viewed'
  // Engagement
  | 'engagement:initiated'
  | 'engagement:coordinator_notified'
  | 'engagement:responded'
  | 'engagement:closed'
  | 'engagement:invite_link_generated'
  // Consent (DPDP Act)
  | 'consent:recorded'
  | 'consent:withdrawn'
  | 'consent:dpdp_request_processed'
  // Team
  | 'team:user_invited'
  | 'team:user_role_changed'
  | 'team:user_deactivated'
  // Billing
  | 'billing:plan_changed'
  | 'billing:payment_processed'
  | 'billing:payment_failed'
  // Data management
  | 'data:export_hms'
  | 'data:retention_applied'
  | 'data:erasure_requested'
  // AI calls
  | 'ai:match_called'
  | 'ai:prescreening_called'
  | 'ai:protocol_parsed'
  | 'ai:monitor_alert_sent'
  // Site network
  | 'site:twin_viewed'
  | 'site:twin_refresh_run'
  // Security
  | 'security:suspicious_access'
  | 'security:rate_limit_hit'

export interface AuditWriteInput {
  org_id?:        string
  user_id?:       string
  session_id?:    string
  action:         AuditAction
  entity_type?:   string
  entity_id?:     string
  before_state?:  Record<string, any>
  after_state?:   Record<string, any>
  ip_address?:    string
  user_agent?:    string
  request_id?:    string
  outcome?:       'success' | 'failure' | 'partial'
  error_code?:    string
  error_message?: string
  metadata?:      Record<string, any>
}

// Track write failures so ops can monitor audit log health
let auditWriteFailures = 0
export const getAuditFailureCount = () => auditWriteFailures

/**
 * Write an audit log entry. Non-blocking — never throws.
 * Returns the created record ID for tracing, or null on failure.
 */
export async function writeAudit(input: AuditWriteInput): Promise<string | null> {
  const db = supabaseAdmin()
  try {
    const { data, error } = await db
      .from('audit_log')
      .insert({
        org_id:        input.org_id,
        user_id:       input.user_id,
        session_id:    input.session_id,
        action:        input.action,
        entity_type:   input.entity_type,
        entity_id:     input.entity_id,
        before_state:  sanitiseState(input.before_state),
        after_state:   sanitiseState(input.after_state),
        ip_address:    input.ip_address,
        user_agent:    input.user_agent?.slice(0, 500),
        request_id:    input.request_id,
        outcome:       input.outcome ?? 'success',
        error_code:    input.error_code,
        error_message: input.error_message?.slice(0, 500),
        metadata:      input.metadata ?? {},
      })
      .select('id')
      .single()

    if (error) {
      auditWriteFailures++
      console.error('[audit] Write failed:', error.message, { action: input.action, org_id: input.org_id })
      return null
    }
    return data?.id ?? null
  } catch (e) {
    auditWriteFailures++
    console.error('[audit] Unexpected error:', e)
    return null
  }
}

/**
 * Extract audit context from a Next.js API request object.
 * Handles X-Forwarded-For (Vercel edge) and standard headers.
 */
export function extractRequestContext(req: { headers: Record<string, any> }): {
  ip_address:  string
  user_agent:  string
  request_id:  string
} {
  const forwarded = req.headers['x-forwarded-for']
  const ip        = typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : req.headers['x-real-ip'] || 'unknown'

  return {
    ip_address: ip,
    user_agent: req.headers['user-agent'] || 'unknown',
    request_id: req.headers['x-request-id'] || generateRequestId(),
  }
}

function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Sanitise state objects before writing to audit log.
 * Removes known PII fields that should never appear in audit records.
 * Audit records capture WHAT changed and WHO changed it — not raw patient data.
 */
function sanitiseState(state?: Record<string, any>): Record<string, any> | undefined {
  if (!state) return undefined
  const PHI_FIELDS = [
    'abha_id', 'aadhaar', 'phone', 'email', 'address',
    'patient_name', 'coordinator_phone', 'raw_text',
  ]
  const sanitised = { ...state }
  for (const field of PHI_FIELDS) {
    if (field in sanitised) {
      sanitised[field] = '[REDACTED]'
    }
  }
  return sanitised
}

/**
 * Convenience: build audit context from a NextAuth session.
 */
export function sessionAuditContext(session: any): {
  org_id:     string
  user_id:    string
  session_id: string
} {
  const user = session?.user as any
  return {
    org_id:     user?.orgId  || user?.org_id || '',
    user_id:    user?.id     || user?.sub    || '',
    session_id: session?.id  || '',
  }
}

/**
 * Thin helper — wraps an async operation and writes a matched audit entry
 * for both success and failure paths.
 *
 * Usage:
 *   const result = await audited({
 *     action: 'engagement:initiated',
 *     ...sessionAuditContext(session),
 *     entity_type: 'site_engagement_requests',
 *     entity_id: request.id,
 *     metadata: { protocol_id, site_org_id },
 *   }, async () => {
 *     return await doTheWork()
 *   })
 */
export async function audited<T>(
  context: Omit<AuditWriteInput, 'outcome' | 'error_code'>,
  fn: () => Promise<T>
): Promise<T> {
  try {
    const result = await fn()
    writeAudit({ ...context, outcome: 'success' }) // fire-and-forget
    return result
  } catch (err: any) {
    writeAudit({
      ...context,
      outcome:       'failure',
      error_code:    err.code || 'UNKNOWN',
      error_message: err.message,
    }) // fire-and-forget
    throw err
  }
}
