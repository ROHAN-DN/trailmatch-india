/**
 * pages/api/prescreening/whatsapp.ts — Production rewrite
 *
 * POST { checklist_id, phone, patient_code, trial_title }
 *
 * Coordinator-triggered WhatsApp send of pre-screening checklist to patient.
 * Phone number is never stored — it's ephemeral per send.
 * Audit log records only last 4 digits for privacy.
 */
import { z } from 'zod'
import { withApiHandler } from '../../../lib/api-handler'
import { writeAudit } from '../../../lib/audit'
import { sendWhatsApp, buildWhatsAppDeepLink } from '../../../lib/whatsapp'
import { NotFoundError, ValidationError } from '../../../lib/errors'
import type { ChecklistItem } from '../../../lib/types/domain'

const SendSchema = z.object({
  checklist_id: z.string().uuid('Invalid checklist ID'),
  phone:        z.string()
    .transform(p => p.replace(/\D/g, ''))
    .refine(p => p.length >= 10, { message: 'Phone number must be at least 10 digits' }),
  patient_code: z.string().max(50).optional(),
  trial_title:  z.string().max(300).optional(),
})

const CATEGORY_HEADERS: Record<string, string> = {
  labs:        '🧪 Lab reports to bring',
  documents:   '📄 Documents to carry',
  medications: '💊 Medication information',
  preparation: '📋 Day-of preparation',
  questions:   '❓ Questions for the PI',
}
const CAT_ORDER = ['labs', 'documents', 'medications', 'preparation', 'questions']

export default withApiHandler(async (req, res, ctx) => {
  const { db, user, org } = ctx

  const body = SendSchema.safeParse(req.body)
  if (!body.success) {
    const fe: Record<string, string> = {}
    for (const i of body.error.issues) fe[i.path.join('.')] = i.message
    throw new ValidationError(body.error.issues[0].message, fe)
  }

  const { checklist_id, phone, patient_code, trial_title } = body.data

  /* Load checklist and verify org ownership */
  const { data: row, error } = await db
    .from('prescreening_checklists')
    .select('checklist, trial_title, nct_id, status')
    .eq('id',     checklist_id)
    .eq('org_id', org.id)
    .single()

  if (error || !row) throw new NotFoundError('Checklist', checklist_id)

  const items: ChecklistItem[] = row.checklist || []
  if (items.length === 0) {
    throw new ValidationError('Checklist is empty — generate it first before sending.', {
      checklist_id: 'Checklist has no items',
    })
  }

  const titleToUse  = trial_title || row.trial_title || row.nct_id
  const codeToUse   = patient_code || 'Patient'

  /* Build WhatsApp message */
  const requiredItems = items.filter(i => i.required)
  const optionalItems = items.filter(i => !i.required)

  const lines: string[] = [
    `*TrialMatch India — Pre-screening Checklist*`,
    ``,
    `Hello, please prepare the following before your screening visit.`,
    ``,
    `*Trial:* ${titleToUse.length > 70 ? titleToUse.slice(0, 67) + '…' : titleToUse}`,
    `*Patient ref:* ${codeToUse}`,
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `*MUST BRING (required)*`,
    `━━━━━━━━━━━━━━━━━━`,
  ]

  const grouped: Record<string, ChecklistItem[]> = {}
  for (const item of requiredItems) {
    if (!grouped[item.category]) grouped[item.category] = []
    grouped[item.category].push(item)
  }

  for (const cat of CAT_ORDER) {
    const catItems = grouped[cat]
    if (!catItems?.length) continue
    lines.push(``, `${CATEGORY_HEADERS[cat] || cat.toUpperCase()}`)
    for (const item of catItems) {
      lines.push(`• ${item.item}`)
      if (item.notes) lines.push(`  _${item.notes}_`)
    }
  }

  if (optionalItems.length > 0) {
    lines.push(``, `━━━━━━━━━━━━━━━━━━`, `*OPTIONAL (helpful to have)*`)
    for (const item of optionalItems.slice(0, 4)) {
      lines.push(`◦ ${item.item}`)
    }
  }

  lines.push(
    ``,
    `Please arrive 30 minutes before your appointment.`,
    `For questions, contact your study coordinator.`,
    ``,
    `_TrialMatch India · ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}_`,
    `_This is an AI-assisted checklist. Confirm all items with the site coordinator._`
  )

  const message = lines.join('\n')

  // Always build the deep link first — this requires no Business API call,
  // no template approval, and works today for every recipient. It opens
  // the COORDINATOR's own WhatsApp with the message pre-filled, ready to send.
  const deepLink = buildWhatsAppDeepLink(phone, message)

  // Attempt automatic delivery as a bonus, not a requirement.
  // Previously this threw ExternalServiceError on any failure — which, for
  // a one-off patient number that has never messaged TrialMatch's business
  // number, is EVERY SINGLE TIME. The coordinator got a hard error on a
  // feature that can never succeed via the Business API alone without an
  // approved template. The deep link above is the real, working path.
  //
  // No patient-facing template exists yet (DPDP Act consent rules around
  // automated patient messaging need separate legal review before
  // submitting one to Gupshup) — so this is a single opportunistic
  // free-form attempt only, not routed through sendWhatsAppSmart's
  // template lookup. Failure here is expected, not exceptional.
  let deliveryChannel: 'freeform' | 'none' = 'none'
  try {
    await Promise.race([
      sendWhatsApp({ to: phone, message }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ])
    deliveryChannel = 'freeform'
  } catch {
    // Expected for cold numbers — deep link below is the real delivery path
  }

  /* Audit — only last 4 digits stored */
  writeAudit({
    action:      'prescreening:whatsapp_sent',
    org_id:      org.id,
    user_id:     user.id,
    entity_type: 'prescreening_checklists',
    entity_id:   checklist_id,
    metadata:    {
      phone_last4:      phone.slice(-4),
      patient_code:     codeToUse,
      item_count:       items.length,
      delivery_channel: deliveryChannel,
    },
    ip_address:  ctx.ipAddress,
  })

  return res.json({
    ok:               true,
    auto_sent:        deliveryChannel === 'freeform',
    deep_link:        deepLink,
    message_preview:  message,
    message: deliveryChannel === 'freeform'
      ? `Sent automatically to +${phone.slice(-10)}`
      : `Tap "Open in WhatsApp" to send from your own number — automatic delivery isn't available for this number yet.`,
  })
}, { methods: ['POST'] })
