/**
 * pages/api/match/index.ts  (v2 — with WhatsApp + email notifications)
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'
import { matchPatient } from '../../../lib/matcher'
import { createSupabaseTrialCriteriaCacheStore } from '../../../lib/trial-criteria-cache'
import { readStructuredClinicalData } from '../../../lib/clinical-data'
import { generateReportPDF } from '../../../lib/pdf'
import { sendMatchReport, sendEmail } from '../../../lib/email'
import { notifyMatchComplete, notifyBatchComplete } from '../../../lib/whatsapp'
import { matchRateLimit } from '../../../lib/ratelimit'
import { checkMonthlyMatchJobLimit } from '../../../lib/gate'
import { processInChunks } from '../../../lib/concurrency'
import { waitUntil } from '@vercel/functions'

// Vercel can freeze/terminate a serverless function once its response has
// been sent. Code below res.status(202) is NOT guaranteed to keep running
// without waitUntil() — this tells the runtime to keep the instance alive
// until the wrapped promise settles, which is required for this
// "respond now, process in background" pattern to reliably complete.
export const config = { maxDuration: 300 }

// Patients within a batch used to be matched strictly one at a time — safe,
// but each patient involves concurrent CTgov/CTRI/RxNorm fetches plus one
// Claude API call, and 20 of those run sequentially is a real risk of
// approaching the maxDuration ceiling above under realistic latency. Full
// parallelism (all 20 at once) isn't the right fix either — that risks
// looking like abuse to CTgov/CTRI/RxNorm's public APIs and to Anthropic's
// own per-account concurrency limits. 4 is a conservative middle ground:
// a meaningful (~4x in the best case) reduction in total wall-clock time
// for a full 20-patient batch, without meaningfully increasing load on any
// single external dependency. See lib/concurrency.ts.
const BATCH_MATCH_CONCURRENCY = 4

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', ['POST']); return res.status(405).end() }

  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user = session.user as any

  const limit = await matchRateLimit(user.org_id)
  if (!limit.ok) return res.status(429).json({ error: limit.message })

  const monthlyGate = await checkMonthlyMatchJobLimit(user.org_id)
  if (!monthlyGate.allowed) return res.status(402).json({ error: monthlyGate.message, upgrade: monthlyGate.upgrade })

  const db   = supabaseAdmin()
  const org_id = user.org_id
  const trialCriteriaCache = createSupabaseTrialCriteriaCacheStore(db)

  const { patient_ids, send_email = false, email_to } = req.body as {
    patient_ids: string[]; send_email?: boolean; email_to?: string
  }

  if (!patient_ids?.length) return res.status(400).json({ error: 'patient_ids required' })
  if (patient_ids.length > 20) return res.status(400).json({ error: 'Max 20 patients per batch' })

  const { data: patients, error: pErr } = await db
    .from('patients').select('*').in('id', patient_ids).eq('org_id', org_id)
  if (pErr || !patients?.length) return res.status(404).json({ error: 'Patients not found' })

  const [{ data: org }, { data: notifSettings }] = await Promise.all([
    db.from('organizations').select('name, brand_color').eq('id', org_id).single(),
    db.from('org_notifications').select('*').eq('org_id', org_id).single(),
  ])

  const { data: job } = await db.from('match_jobs').insert({
    org_id, created_by: user.id,
    name: `Match — ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`,
    status: 'running', total_patients: patients.length, done_patients: 0,
    started_at: new Date().toISOString(),
  }).select().single()

  await db.from('match_results').insert(
    patients.map(p => ({ job_id: job!.id, patient_id: p.id, org_id, status: 'pending' }))
  )

  res.status(202).json({ job_id: job!.id, total: patients.length })

  // Everything below runs after the response has already been sent to the
  // client. Wrapped in waitUntil() so Vercel keeps this invocation alive
  // until the batch finishes, instead of risking early termination.
  waitUntil(processBatch())

  async function processOnePatient(patient: any): Promise<{ strong: number; partial: number; failed: boolean }> {
    // Everything for this one patient lives inside this single try/catch —
    // including the initial status update, which the original sequential
    // version left outside its try/catch (a real, if unlikely, latent bug:
    // a transient DB error on just that one call would have aborted the
    // entire remaining batch, not just this patient). Now under bounded
    // concurrency that same gap would be worse — an uncaught rejection
    // here would reject the whole Promise.all for this patient's chunk,
    // silently orphaning its chunk-mates from lib/concurrency.ts's
    // perspective (see that file's own header comment on why `worker`
    // must never reject). This function is now guaranteed to always
    // resolve, never reject, regardless of what fails inside it.
    try {
      await db.from('match_results').update({ status: 'running' })
        .eq('job_id', job!.id).eq('patient_id', patient.id)

      const clinical = await readStructuredClinicalData(db, org_id, patient.id)
      const clinicalData = 'error' in clinical ? null : clinical
      if ('error' in clinical) console.warn(`[match] Could not load structured clinical data for ${patient.id}, proceeding without deterministic evaluation:`, clinical.error)

      const result    = await matchPatient(patient, clinicalData, trialCriteriaCache)
      const pdfBuffer = generateReportPDF(patient, result)
      const fileName  = `${org_id}/${job!.id}/${patient.patient_code}.pdf`

      await supabaseAdmin().storage.from('reports')
        .upload(fileName, pdfBuffer, { contentType: 'application/pdf', upsert: true })
      const { data: urlData } = supabaseAdmin().storage.from('reports').getPublicUrl(fileName)
      const reportUrl = urlData?.publicUrl || null

      let emailSentAt = null
      if (send_email && email_to) {
        try {
          await sendMatchReport({ to: email_to, patient, result, pdfBuffer, orgName: org?.name, brandColor: org?.brand_color })
          emailSentAt = new Date().toISOString()
        } catch (e) { console.error('Email failed:', e) }
      }

      if (notifSettings?.notify_email && notifSettings?.email_on_match_complete && patients!.length === 1) {
        try { await sendMatchReport({ to: notifSettings.notify_email, patient, result, pdfBuffer, orgName: org?.name, brandColor: org?.brand_color }) }
        catch (e) { console.error('Notif email failed:', e) }
      }

      const strong  = result.matches.filter(m => m.matchStrength === 'STRONG').length
      const partial = result.matches.filter(m => m.matchStrength === 'PARTIAL').length

      if (notifSettings?.whatsapp_number && notifSettings?.notify_on_match_complete && patients!.length === 1) {
        try {
          await notifyMatchComplete({
            phone: notifSettings.whatsapp_number, coordinatorName: user.name || 'Coordinator',
            patientCode: patient.patient_code, diagnosis: patient.diagnosis,
            strongMatches: strong, partialMatches: partial,
            totalSearched: result.trialsSearched || 0, reportUrl, orgName: org?.name,
          })
        } catch (e) { console.error('WhatsApp failed:', e) }
      }

      // Email notification runs in parallel with WhatsApp — not as a fallback.
      // WhatsApp requires an open 24h session to deliver; a coordinator who hasn't
      // messaged the business number recently gets nothing from WhatsApp alone.
      // Email guarantees delivery regardless of session state.
      if (notifSettings?.notify_email && notifSettings?.email_on_match_complete && patients!.length === 1) {
        // Already sent above via sendMatchReport — skip duplicate
      } else if (notifSettings?.notify_email && notifSettings?.notify_on_match_complete) {
        try {
          await sendEmail({
            to:      notifSettings.notify_email,
            subject: `Match complete — ${patient.patient_code} (${strong} strong, ${partial} partial)`,
            html:    `<p>The trial match for <strong>${patient.patient_code}</strong> (${patient.diagnosis}) is ready.</p><p>${strong} strong match${strong !== 1 ? 'es' : ''}, ${partial} partial. Screened ${result.trialsSearched || 0} trials.</p>${reportUrl ? `<p><a href="${reportUrl}">Download PDF report</a></p>` : ''}<p><a href="${process.env.NEXTAUTH_URL}/dashboard">Open TrialMatch dashboard</a></p>`,
          })
        } catch (e) { console.error('Match-complete email failed:', e) }
      }

      await db.from('match_results').update({
        status: 'done', trials_searched: result.trialsSearched,
        ctgov_count: result.ctgovCount, ctri_count: result.ctriCount,
        summary: result.summary, matches: result.matches, not_matched: result.notMatched,
        source_status: result.sourceStatus,
        report_url: reportUrl, email_sent_at: emailSentAt, updated_at: new Date().toISOString(),
      }).eq('job_id', job!.id).eq('patient_id', patient.id)

      // Enrollment monitor task creation: this used to be done here directly
      // via `.insert({...}).onConflict('match_result_id').ignore()` — but
      // `.onConflict()` is not a real method on the Supabase JS query builder
      // after `.insert()` (that's not how conflict handling works in
      // supabase-js v2; it requires `.upsert(data, { onConflict, ... })`
      // instead). That call threw a TypeError on every single successful
      // match, which was caught by the surrounding try/catch below and
      // silently flipped this match_results row to status:'error' — AFTER
      // the PDF/email/WhatsApp notification had already gone out. A
      // coordinator would receive "your results are ready" and then see the
      // job marked failed on the dashboard.
      //
      // migration 013_fixes.sql adds a DB trigger
      // (create_enrollment_monitor_task, AFTER UPDATE ON match_results) that
      // creates this row automatically and correctly — using real SQL
      // `ON CONFLICT (match_result_id) DO NOTHING`, backed by a unique
      // constraint that same migration adds (fixed — see
      // FIXES_2026-07-28.md; the constraint's own creation had an
      // unrelated syntax bug that silently prevented it from ever being
      // created) — every time a match_results row transitions to
      // status='done', which is exactly what the update above just did.
      // That trigger is the single source of truth for this now;
      // duplicating it here in application code was both broken and, once
      // fixed, redundant.

      return { strong, partial, failed: false }
    } catch (err: any) {
      try {
        await db.from('match_results').update({ status: 'error', error_msg: err.message })
          .eq('job_id', job!.id).eq('patient_id', patient.id)
      } catch (innerErr) {
        // Even the error-status write itself failed — log it, but this
        // function still must resolve rather than throw (see this
        // function's own opening comment).
        console.error(`[match] Failed to record error status for patient ${patient.id}:`, innerErr)
      }
      return { strong: 0, partial: 0, failed: true }
    }
  }

  async function processBatch() {
    let strongTotal = 0, partialTotal = 0, failedCount = 0, done = 0

    await processInChunks(
      patients!,
      BATCH_MATCH_CONCURRENCY,
      processOnePatient,
      async (chunkResults) => {
        // Aggregated here, once per chunk, after Promise.all for that
        // chunk has already resolved — this runs on the main thread
        // between chunks, never concurrently with itself, so these three
        // counters can never race regardless of how many patients were
        // just processed in parallel within the chunk that just finished.
        for (const r of chunkResults) {
          strongTotal += r.strong; partialTotal += r.partial
          if (r.failed) failedCount++
        }
        done += chunkResults.length
        await db.from('match_jobs').update({ done_patients: done }).eq('id', job!.id)
      }
    )

    await db.from('match_jobs').update({
      status: failedCount === patients!.length ? 'failed' : 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', job!.id)

    if (patients!.length > 1 && notifSettings?.whatsapp_number && notifSettings?.notify_on_batch_complete) {
      try {
        await notifyBatchComplete({
          phone: notifSettings.whatsapp_number, coordinatorName: user.name || 'Coordinator',
          totalPatients: patients!.length, strongTotal, partialTotal, failedCount, orgName: org?.name,
        })
      } catch (e) { console.error('Batch WhatsApp failed:', e) }
    }
  }
}
