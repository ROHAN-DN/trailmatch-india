/**
 * lib/whatsapp.ts
 * Gupshup WhatsApp Business API integration
 * Docs: https://docs.gupshup.io/docs/whatsapp-api
 *
 * Setup:
 *  1. Sign up at https://www.gupshup.io
 *  2. Create a WhatsApp app → get API key + source number
 *  3. Register message templates (required for outbound messages)
 *  4. Add env vars:
 *     GUPSHUP_API_KEY=your_api_key
 *     GUPSHUP_SOURCE_NUMBER=919XXXXXXXXX   (your WA business number, no +)
 *     GUPSHUP_APP_NAME=TrialMatchIndia
 */

const GUPSHUP_BASE = 'https://api.gupshup.io/sm/api/v1'

export interface WhatsAppMessage {
  to:      string   // recipient number e.g. "919876543210" (no + or spaces)
  message: string   // plain text for session messages
}

export interface TemplateMessage {
  to:           string
  templateId:   string            // Gupshup template ID
  params:       string[]          // template parameter values in order
}

// ── Send a free-form text message (within 24h session window) ─
export async function sendWhatsApp({ to, message }: WhatsAppMessage) {
  const clean = to.replace(/\D/g, '')   // strip non-digits
  const dest  = clean.startsWith('91') ? clean : `91${clean}`

  const body = new URLSearchParams({
    channel:   'whatsapp',
    source:    process.env.GUPSHUP_SOURCE_NUMBER!,
    destination: dest,
    message:   JSON.stringify({ type: 'text', text: message }),
    'src.name': process.env.GUPSHUP_APP_NAME || 'TrialMatchIndia',
  })

  const res = await fetch(`${GUPSHUP_BASE}/msg`, {
    method:  'POST',
    headers: {
      apikey:         process.env.GUPSHUP_API_KEY!,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body: body.toString(),
  })

  const data = await res.json()
  if (!res.ok || data.status === 'error') {
    throw new Error(`Gupshup error: ${data.message || JSON.stringify(data)}`)
  }
  return data
}

// ── Smart send: template if approved, else opportunistic free-form, ──
// ── else tell the caller to use a fallback channel (usually email) ───
//
// WHY THIS EXISTS:
// Every Phase 2 feature (enrollment alerts, engagement notifications,
// weekly reports) sends a SYSTEM-INITIATED first message to a real
// coordinator. WhatsApp Business API policy requires a pre-approved
// template for any message outside a 24h customer-initiated session
// window. Before this function existed, every Phase 2 call site used
// the free-form sendWhatsApp() directly — which works when YOU test it
// (because you messaged the sandbox number first) and silently fails
// for every real coordinator who has never messaged the business number.
//
// This function makes that failure mode impossible to ship silently:
//   1. If an approved template ID is configured for this message type
//      (via env var) → send via template. Always works, any recipient.
//   2. Else → try free-form once, with a short timeout. This succeeds
//      opportunistically for any number that DID message first (e.g. a
//      coordinator who replied to a previous message) — free, no harm
//      in trying. Failure here is EXPECTED for cold numbers, not an error.
//   3. Either way, returns which channel succeeded (or none) so the
//      caller can fall through to email/UI display without losing the
//      notification entirely.
export type WhatsAppMessageType =
  | 'enrollment_alert'
  | 'weekly_report'
  | 'engagement_notify_coordinator'
  | 'engagement_notify_sponsor'

const TEMPLATE_ENV_VARS: Record<WhatsAppMessageType, string> = {
  enrollment_alert:               'GUPSHUP_TEMPLATE_ENROLLMENT_ALERT',
  weekly_report:                  'GUPSHUP_TEMPLATE_WEEKLY_REPORT',
  engagement_notify_coordinator:  'GUPSHUP_TEMPLATE_ENGAGEMENT_COORDINATOR',
  engagement_notify_sponsor:      'GUPSHUP_TEMPLATE_ENGAGEMENT_SPONSOR',
}

export interface SmartSendResult {
  channel: 'template' | 'freeform' | 'none'
  error?:  string
}

export async function sendWhatsAppSmart(
  type:    WhatsAppMessageType,
  to:      string,
  /** Variables in template order, e.g. [count, orgName, link] */
  params:  string[],
  /** Plain-text fallback used only for the opportunistic free-form attempt */
  freeformMessage: string
): Promise<SmartSendResult> {
  const templateId = process.env[TEMPLATE_ENV_VARS[type]]

  // 1. Approved template exists — use it. Works for any recipient, any time.
  if (templateId) {
    try {
      await sendTemplate({ to, templateId, params })
      return { channel: 'template' }
    } catch (e: any) {
      // Template send failed (rare — bad number, Gupshup outage). Fall through.
      console.warn(`[whatsapp] Template send failed for ${type}:`, e.message)
    }
  }

  // 2. No template configured yet — try free-form opportunistically.
  // This is EXPECTED to fail for most recipients (no open session window).
  // That is not an error condition; it's the reason this function exists.
  try {
    await Promise.race([
      sendWhatsApp({ to, message: freeformMessage }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ])
    return { channel: 'freeform' }
  } catch {
    return { channel: 'none', error: templateId ? 'template_failed_and_no_session' : 'no_template_no_session' }
  }
}

// ── wa.me deep link — opens the SENDER's own WhatsApp with the message ──
// ── pre-filled. No Business API, no template approval, works today. ────
// Used for the patient-facing pre-screening checklist send, where the
// recipient is a one-off phone number with no system account and no
// open session — the coordinator sends it from their own WhatsApp.
export function buildWhatsAppDeepLink(phone: string, message: string): string {
  const clean = phone.replace(/\D/g, '')
  const dest  = clean.startsWith('91') ? clean : `91${clean.slice(-10)}`
  return `https://wa.me/${dest}?text=${encodeURIComponent(message)}`
}

// ── Send a pre-approved template message (for first contact) ──────────────
async function sendTemplate({ to, templateId, params }: TemplateMessage) {
  const clean = to.replace(/\D/g, '')
  const dest  = clean.startsWith('91') ? clean : `91${clean}`

  const body = new URLSearchParams({
    channel:     'whatsapp',
    source:      process.env.GUPSHUP_SOURCE_NUMBER!,
    destination: dest,
    template:    JSON.stringify({ id: templateId, params }),
    'src.name':  process.env.GUPSHUP_APP_NAME || 'TrialMatchIndia',
  })

  const res = await fetch(`${GUPSHUP_BASE}/template/msg`, {
    method:  'POST',
    headers: {
      apikey:          process.env.GUPSHUP_API_KEY!,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })

  const data = await res.json()
  if (!res.ok || data.status === 'error') {
    throw new Error(`Gupshup template error: ${data.message || JSON.stringify(data)}`)
  }
  return data
}

// ── High-level notification helpers ───────────────────────────

/**
 * Notify coordinator when a batch match job completes.
 * Uses a free-form message if within 24h session, else template.
 */
export async function notifyMatchComplete({
  phone,
  coordinatorName,
  patientCode,
  diagnosis,
  strongMatches,
  partialMatches,
  totalSearched,
  reportUrl,
  orgName = 'TrialMatch India',
}: {
  phone:            string
  coordinatorName:  string
  patientCode:      string
  diagnosis:        string
  strongMatches:    number
  partialMatches:   number
  totalSearched:    number
  reportUrl?:       string
  orgName?:         string
}) {
  const lines = [
    `*${orgName} — Trial Match Report* ✅`,
    ``,
    `Hi ${coordinatorName},`,
    ``,
    `Your trial match for *${patientCode}* (${diagnosis}) is ready.`,
    ``,
    `📊 *Results:*`,
    `• Trials screened: ${totalSearched}`,
    `• ✅ Strong matches: *${strongMatches}*`,
    `• 🔶 Partial matches: ${partialMatches}`,
    ``,
    reportUrl
      ? `📄 Full report (PDF): ${reportUrl}`
      : `Log in to view the full report with eligibility breakdown and next steps.`,
    ``,
    `_This is an AI-assisted decision support tool. All matches must be verified by the PI at each site._`,
  ]

  await sendWhatsApp({ to: phone, message: lines.join('\n') })
}

/**
 * Notify coordinator of new matching trials found during scheduled re-matching.
 */
export async function notifyNewTrials({
  phone,
  coordinatorName,
  patientCode,
  diagnosis,
  newTrials,
  orgName = 'TrialMatch India',
}: {
  phone:           string
  coordinatorName: string
  patientCode:     string
  diagnosis:       string
  newTrials:       { title: string; nctId: string; matchScore: number }[]
  orgName?:        string
}) {
  const trialLines = newTrials.slice(0, 3).map(
    (t, i) => `${i + 1}. *${t.title.slice(0, 55)}${t.title.length > 55 ? '…' : ''}*\n   Match score: ${t.matchScore}% · ${t.nctId}`
  )

  const lines = [
    `*${orgName} — New Trial Matches Found* 🔔`,
    ``,
    `Hi ${coordinatorName},`,
    ``,
    `Our weekly re-match found *${newTrials.length} new trial(s)* for patient *${patientCode}* (${diagnosis}):`,
    ``,
    ...trialLines,
    ``,
    `These trials were not available in the previous match. Log in to see full eligibility details and next steps.`,
    ``,
    `_Powered by TrialMatch India_`,
  ]

  await sendWhatsApp({ to: phone, message: lines.join('\n') })
}

/**
 * Notify coordinator when a batch job completes (multiple patients).
 */
export async function notifyBatchComplete({
  phone,
  coordinatorName,
  totalPatients,
  strongTotal,
  partialTotal,
  failedCount,
  orgName = 'TrialMatch India',
}: {
  phone:            string
  coordinatorName:  string
  totalPatients:    number
  strongTotal:      number
  partialTotal:     number
  failedCount:      number
  orgName?:         string
}) {
  const lines = [
    `*${orgName} — Batch Match Complete* ✅`,
    ``,
    `Hi ${coordinatorName},`,
    ``,
    `Your batch match job has finished.`,
    ``,
    `📊 *Summary:*`,
    `• Patients processed: ${totalPatients}`,
    `• Total strong matches: *${strongTotal}*`,
    `• Total partial matches: ${partialTotal}`,
    failedCount > 0 ? `• ⚠️ Failed: ${failedCount}` : '',
    ``,
    `Log in to view individual patient reports and download PDFs.`,
    ``,
    `_TrialMatch India — AI-assisted decision support_`,
  ].filter(Boolean)

  await sendWhatsApp({ to: phone, message: lines.join('\n') })
}
