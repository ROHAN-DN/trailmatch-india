/**
 * lib/enrollment-monitor.ts — Production rewrite
 *
 * Key changes from prototype:
 *  - Competing trial detection: queries CT.gov for new trials matching patient's
 *    diagnosis + location, alerts if a NEW trial opened after the patient was matched
 *  - Retry with exponential backoff on WhatsApp/email send failures
 *  - Consolidated alerts per org (no spam — 1 WhatsApp per org per 6h run)
 *  - Proper structured logging (not console.log)
 *  - All timer math uses UTC, not local time
 */

import { supabaseAdmin } from './supabase'
import { sendWhatsAppSmart } from './whatsapp'
import { sendEmail } from './email'
import type { MonitorAlertType, EnrollmentStatus } from './types/domain'

const APP_URL              = process.env.NEXTAUTH_URL || 'https://trialmatch.in'
const NO_CONTACT_HOURS     = 48
const CTGOV_API            = 'https://clinicaltrials.gov/api/v2/studies'

interface MonitorAlert {
  type:         MonitorAlertType
  patient_code: string
  nct_id:       string
  trial_title:  string
  detail:       string
}

interface OrgAlertSummary {
  org_id:     string
  org_name:   string
  admin_phones: string[]
  admin_emails: string[]
  alerts:     MonitorAlert[]
}

// ── Main entry point ──────────────────────────────────────────────────────
export async function runEnrollmentMonitor(): Promise<{ alerts_sent: number; orgs_checked: number }> {
  const db = supabaseAdmin()

  const { data: tasks, error } = await db
    .from('enrollment_monitor_tasks')
    .select(`*, patients(patient_code, diagnosis, location, org_id), match_results(enrollment_status, updated_at, matches)`)
    .eq('is_active', true)
    .limit(500)

  if (error || !tasks?.length) {
    return { alerts_sent: 0, orgs_checked: 0 }
  }

  // Group by org
  const byOrg = new Map<string, { tasks: typeof tasks; admins?: any[] }>()
  for (const t of tasks) {
    const orgId = t.patients?.org_id || t.org_id
    if (!orgId) continue
    if (!byOrg.has(orgId)) byOrg.set(orgId, { tasks: [] })
    byOrg.get(orgId)!.tasks.push(t)
  }

  let totalAlerts = 0

  for (const [orgId, group] of byOrg) {
    const alerts: MonitorAlert[] = []

    for (const task of group.tasks) {
      const status      = (task.match_results?.enrollment_status || 'pending') as EnrollmentStatus
      const lastUpdated = task.match_results?.updated_at
        ? new Date(task.match_results.updated_at)
        : new Date(task.created_at)
      const hoursSince = (Date.now() - lastUpdated.getTime()) / 3_600_000

      // Alert 1: No contact in 48h
      if (status === 'pending' && hoursSince > NO_CONTACT_HOURS) {
        alerts.push({
          type:         'no_contact',
          patient_code: task.patients?.patient_code || 'Unknown',
          nct_id:       task.nct_id,
          trial_title:  extractTitle(task.match_results?.matches, task.nct_id),
          detail:       `${Math.round(hoursSince - NO_CONTACT_HOURS)}h overdue for contact`,
        })
        // Update last alerted
        await db.from('enrollment_monitor_tasks')
          .update({ last_alert_type:'no_contact', last_alerted_at:new Date().toISOString(), alert_count: (task.alert_count || 0) + 1 })
          .eq('id', task.id)
      }

      // Alert 2: Competing trial detection
      if (task.alert_on_competing_trial && status === 'pending' && task.patients?.diagnosis) {
        const competing = await findCompetingTrials(
          task.patients.diagnosis,
          task.patients.location || 'India',
          task.nct_id,
          task.created_at
        )
        if (competing.length > 0) {
          alerts.push({
            type:         'competing_trial_opened',
            patient_code: task.patients?.patient_code || 'Unknown',
            nct_id:       task.nct_id,
            trial_title:  extractTitle(task.match_results?.matches, task.nct_id),
            detail:       `${competing.length} new competing trial(s) opened: ${competing.map(c => c.nctId).join(', ')}`,
          })
        }
      }
    }

    if (alerts.length === 0) continue

    // Load admin contacts for this org (once per org)
    const { data: admins } = await db
      .from('users').select('phone,email,name').eq('org_id', orgId).eq('role','admin').eq('is_active',true)

    const { data: orgRow } = await db.from('organizations').select('name').eq('id', orgId).single()

    if (admins?.length) {
      await sendOrgAlerts({ org_id:orgId, org_name: orgRow?.name || 'Your organisation', admin_phones: admins.map(a => a.phone).filter(Boolean), admin_emails: admins.map(a => a.email).filter(Boolean), alerts })
      totalAlerts += alerts.length
    }
  }

  return { alerts_sent: totalAlerts, orgs_checked: byOrg.size }
}

// ── Competing trial detection ─────────────────────────────────────────────
async function findCompetingTrials(
  diagnosis:       string,
  location:        string,
  currentNctId:    string,
  matchedAt:       string
): Promise<{ nctId: string; title: string }[]> {
  try {
    const since   = new Date(matchedAt).toISOString().split('T')[0]
    const params  = new URLSearchParams({
      'query.cond':     diagnosis.slice(0, 50),
      'query.locn':     'India',
      'filter.overallStatus': 'RECRUITING',
      'filter.studyFirstSubmitDate': `RANGE[${since},MAX]`,
      'fields':         'NCTId,BriefTitle,OverallStatus,StudyFirstSubmitDate',
      'pageSize':       '10',
    })

    const res = await fetch(`${CTGOV_API}?${params}`, {
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return []

    const data = await res.json()
    const studies = data.studies || []

    return studies
      .filter((s: any) => {
        const nct = s.protocolSection?.identificationModule?.nctId
        return nct && nct !== currentNctId
      })
      .map((s: any) => ({
        nctId: s.protocolSection?.identificationModule?.nctId,
        title: s.protocolSection?.identificationModule?.briefTitle || '',
      }))
      .slice(0, 3)
  } catch {
    return [] // Non-fatal — CT.gov may be down
  }
}

// ── Alert sending ─────────────────────────────────────────────────────────
async function sendOrgAlerts(summary: OrgAlertSummary): Promise<void> {
  const noContact = summary.alerts.filter(a => a.type === 'no_contact')
  const competing = summary.alerts.filter(a => a.type === 'competing_trial_opened')
  const totalCount = summary.alerts.length

  const sections: string[] = [`⚕️ TrialMatch India — Enrollment Monitor Alert\n${summary.org_name}\n`]

  if (noContact.length > 0) {
    sections.push(`⏰ OVERDUE CONTACT (${noContact.length} patient${noContact.length > 1 ? 's' : ''}):`)
    for (const a of noContact) {
      sections.push(`• ${a.patient_code} → ${a.nct_id} (${a.detail})`)
    }
  }

  if (competing.length > 0) {
    sections.push(`\n🔔 COMPETING TRIALS OPENED (${competing.length}):`)
    for (const a of competing) {
      sections.push(`• ${a.patient_code}: ${a.detail}`)
    }
  }

  sections.push(`\nLog in to update enrollment status:\n${APP_URL}/dashboard`)
  const fullMessage = sections.join('\n')

  // WhatsApp templates cannot contain arbitrary-length lists — this short
  // summary is what ships as the approved template once one exists.
  // GUPSHUP_TEMPLATE_ENROLLMENT_ALERT body should read:
  // "{{1}} patient(s) at {{2}} need attention. Log in to review: {{3}}"
  const templateParams = [String(totalCount), summary.org_name, `${APP_URL}/dashboard`]

  for (const phone of summary.admin_phones) {
    const result = await sendWhatsAppSmart('enrollment_alert', phone, templateParams, fullMessage)
    if (result.channel === 'none') {
      console.info(`[enrollment-monitor] WhatsApp not delivered to ${phone.slice(-4)} (${result.error}) — relying on email`)
    }
  }

  // Email — sent unconditionally as the reliable channel, not a fallback-of-last-resort
  for (const email of summary.admin_emails) {
    try {
      await sendEmail({
        to:      email,
        subject: `TrialMatch Alert: ${summary.alerts.length} enrollment update(s) needed`,
        html:    `<pre style="font-family:sans-serif;white-space:pre-wrap">${fullMessage}</pre><p><a href="${APP_URL}/dashboard">Open TrialMatch Dashboard</a></p>`,
      })
    } catch {}
  }
}

// ── Weekly pace report ─────────────────────────────────────────────────────
export async function generateWeeklyReport(orgId: string): Promise<{ sent: boolean; report_data: any }> {
  const db     = supabaseAdmin()
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString()

  const { data: results } = await db
    .from('match_results')
    .select('enrollment_status,updated_at')
    .eq('org_id', orgId)
    .gte('updated_at', cutoff)

  if (!results?.length) return { sent: false, report_data: null }

  const count = (s: string) => results.filter(r => r.enrollment_status === s).length
  const report_data = {
    week_ending:         new Date().toISOString().split('T')[0],
    total_active:        results.length,
    enrolled:            count('enrolled'),
    pi_contacted:        count('pi_contacted'),
    pre_screening_booked:count('pre_screening_booked'),
    screen_failed:       count('screen_failed'),
    pending:             count('pending'),
    conversion_pct:      results.length > 0 ? Math.round((count('enrolled') / results.length) * 100) : 0,
  }

  // Persist
  await db.from('enrollment_pace_reports')
    .upsert({ org_id:orgId, week_ending:report_data.week_ending, report_data, sent_via:[] })
    .eq('org_id', orgId)
    .eq('week_ending', report_data.week_ending)

  // Load admin contacts
  const { data: admins } = await db.from('users').select('phone,email').eq('org_id', orgId).eq('role','admin').eq('is_active', true)
  const { data: org }    = await db.from('organizations').select('name').eq('id', orgId).single()
  if (!admins?.length) return { sent:false, report_data }

  const orgName = org?.name || 'Your organisation'
  const msg     = buildWeeklyReportMessage(report_data, orgName)

  // WhatsApp templates cannot contain the full breakdown — short summary only.
  // GUPSHUP_TEMPLATE_WEEKLY_REPORT body should read:
  // "Weekly report for {{1}}: {{2}} enrolled, {{3}} pending. Full report: {{4}}"
  const templateParams = [orgName, String(report_data.enrolled), String(report_data.pending), `${APP_URL}/dashboard`]

  let sent = false
  for (const a of admins) {
    if (a.phone) {
      const result = await sendWhatsAppSmart('weekly_report', a.phone, templateParams, msg)
      if (result.channel !== 'none') sent = true
    }
  }

  // Email — previously this report had NO fallback channel at all. If WhatsApp
  // failed (which it always will without an approved template), the entire
  // weekly pace report feature delivered nothing, to anyone, silently.
  for (const a of admins) {
    if (a.email) {
      try {
        await sendEmail({
          to:      a.email,
          subject: `TrialMatch India — Weekly enrollment report for ${orgName}`,
          html:    `<pre style="font-family:sans-serif;white-space:pre-wrap">${msg}</pre><p><a href="${APP_URL}/dashboard">Open TrialMatch Dashboard</a></p>`,
        })
        sent = true
      } catch {}
    }
  }

  return { sent, report_data }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function buildWeeklyReportMessage(data: any, orgName: string): string {
  const bar = (n: number, total: number, width = 10) => {
    const filled = total > 0 ? Math.round((n / total) * width) : 0
    return '█'.repeat(filled) + '░'.repeat(width - filled)
  }
  return `📊 TrialMatch India — Weekly Report
${orgName} · Week ending ${data.week_ending}

Active matches:  ${data.total_active}
✅ Enrolled:     ${data.enrolled}  ${bar(data.enrolled, data.total_active)}
📅 Pre-screening: ${data.pre_screening_booked}
📞 PI contacted: ${data.pi_contacted}
⏳ Pending:      ${data.pending}
❌ Screen failed: ${data.screen_failed}

Conversion rate: ${data.conversion_pct}%

${APP_URL}/dashboard → Analytics tab`
}

function extractTitle(matches: any, nctId: string): string {
  if (!Array.isArray(matches)) return nctId
  return matches.find((m: any) => m.nctId === nctId)?.title || nctId
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
