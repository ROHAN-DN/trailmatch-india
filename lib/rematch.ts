/**
 * lib/rematch.ts
 * Scheduled re-matching engine.
 * Compares a patient's current matches against a fresh match run
 * and identifies genuinely NEW trials not seen before.
 */

import { matchPatient, type Patient, type TrialMatch, type SourceStatus } from './matcher'
import { readStructuredClinicalData } from './clinical-data'
import { generateReportPDF } from './pdf'
import { sendMatchReport } from './email'
import { notifyNewTrials, notifyBatchComplete } from './whatsapp'
import { supabaseAdmin } from './supabase'
import { createSupabaseTrialCriteriaCacheStore } from './trial-criteria-cache'
import { resolveLLMConfig, type LLMProviderConfig } from './llm-provider'

export interface RematchSummary {
  patientId:    string
  patientCode:  string
  diagnosis:    string
  newTrials:    TrialMatch[]
  allMatches:   TrialMatch[]
  hasNewTrials: boolean
  sourceStatus: SourceStatus
}

// ── Compare two match sets — return genuinely new NCT IDs ─────
export function findNewTrials(
  previousMatches: TrialMatch[],
  currentMatches:  TrialMatch[]
): TrialMatch[] {
  const prevIds = new Set(previousMatches.map(m => m.nctId).filter(Boolean))
  return currentMatches.filter(m =>
    m.nctId &&
    !prevIds.has(m.nctId) &&
    (m.matchStrength === 'STRONG' || m.matchStrength === 'PARTIAL')
  )
}

// ── Re-match a single patient ─────────────────────────────────
export async function rematchPatient(
  patient: Patient & { id: string },
  previousMatches: TrialMatch[],
  llmConfig?: LLMProviderConfig
): Promise<RematchSummary> {
  let clinicalData = null
  if (patient.org_id) {
    const clinical = await readStructuredClinicalData(supabaseAdmin(), patient.org_id, patient.id)
    if (!('error' in clinical)) clinicalData = clinical
  }
  const trialCriteriaCache = createSupabaseTrialCriteriaCacheStore(supabaseAdmin())
  const result    = await matchPatient(patient, clinicalData, trialCriteriaCache, llmConfig)
  const newTrials = findNewTrials(previousMatches, result.matches)

  return {
    patientId:    patient.id,
    patientCode:  patient.patient_code,
    diagnosis:    patient.diagnosis,
    newTrials,
    allMatches:   result.matches,
    hasNewTrials: newTrials.length > 0,
    sourceStatus: result.sourceStatus,
  }
}

// ── Main scheduled job — runs for all active orgs ─────────────
export async function runScheduledRematch() {
  const db  = supabaseAdmin()
  const log = (msg: string) => console.log(`[rematch ${new Date().toISOString()}] ${msg}`)

  log('Starting scheduled re-match run')

  // Fetch all active (non-archived) patients that have at least one previous match
  const { data: patients, error } = await db
    .from('patients')
    .select(`
      id, patient_code, age, sex, location, diagnosis, stage,
      medications, labs, comorbidities, prior_treatments,
      biomarkers, allergies, ecog_status, notes,
      org_id,
      organizations!inner (id, name, brand_color)
    `)
    .eq('is_archived', false)

  if (error || !patients?.length) {
    log('No patients found or DB error: ' + error?.message)
    return { processed: 0, withNewTrials: 0 }
  }

  log(`Processing ${patients.length} patients`)

  let processed   = 0
  let withNewTrials = 0
  const orgSummaries: Record<string, { strongTotal: number; partialTotal: number; failed: number; patients: number }> = {}
  // This loop spans many different orgs in one run (unlike the per-org
  // batch matcher in pages/api/match/index.ts, where a single upfront
  // resolve is correct) — a naive single pre-resolve would be wrong
  // here. But orgs with more than one patient due for re-match in the
  // same run would still redundantly re-fetch their own config once per
  // patient without this — cache per org_id instead, resolved lazily on
  // first encounter within this run.
  const llmConfigCache = new Map<string, LLMProviderConfig>()

  for (const patient of patients) {
    try {
      // Get most recent match result for this patient
      const { data: lastResult } = await db
        .from('match_results')
        .select('matches, created_at, id')
        .eq('patient_id', patient.id)
        .eq('status', 'done')
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      // Skip if matched in the last 6 days (avoid re-matching too often)
      if (lastResult?.created_at) {
        const daysSince = (Date.now() - new Date(lastResult.created_at).getTime()) / (1000 * 60 * 60 * 24)
        if (daysSince < 6) {
          log(`Skipping ${patient.patient_code} — matched ${Math.round(daysSince)}d ago`)
          continue
        }
      }

      const previousMatches: TrialMatch[] = lastResult?.matches || []

      // Run fresh match
      const patientOrgId = (patient as any).org_id as string | undefined
      let llmConfig = patientOrgId ? llmConfigCache.get(patientOrgId) : undefined
      if (!llmConfig) {
        llmConfig = await resolveLLMConfig(patientOrgId)
        if (patientOrgId) llmConfigCache.set(patientOrgId, llmConfig)
      }
      const summary = await rematchPatient(patient as any, previousMatches, llmConfig)
      processed++

      // Org stats
      const oid = patient.org_id
      if (!orgSummaries[oid]) orgSummaries[oid] = { strongTotal: 0, partialTotal: 0, failed: 0, patients: 0 }
      orgSummaries[oid].patients++
      orgSummaries[oid].strongTotal  += summary.newTrials.filter(m => m.matchStrength === 'STRONG').length
      orgSummaries[oid].partialTotal += summary.newTrials.filter(m => m.matchStrength === 'PARTIAL').length

      // Store new result row
      const { data: newResult } = await db.from('match_results').insert({
        patient_id:      patient.id,
        org_id:          patient.org_id,
        status:          'done',
        trials_searched: summary.allMatches.length,
        matches:         summary.allMatches,
        summary:         `Scheduled weekly re-match. ${summary.newTrials.length} new trial(s) found since last run.`,
        source_status:   summary.sourceStatus,
        updated_at:      new Date().toISOString(),
      }).select().single()

      if (summary.hasNewTrials) {
        withNewTrials++
        log(`${patient.patient_code}: ${summary.newTrials.length} new trial(s) found`)

        // Get coordinator contact for this org
        const { data: coordinator } = await db
          .from('users')
          .select('name, email')
          .eq('org_id', patient.org_id)
          .in('role', ['owner', 'admin'])
          .limit(1)
          .single()

        const { data: orgWhatsApp } = await db
          .from('org_notifications')
          .select('whatsapp_number, notify_on_new_trials')
          .eq('org_id', patient.org_id)
          .single()

        // WhatsApp notification if configured
        if (orgWhatsApp?.whatsapp_number && orgWhatsApp?.notify_on_new_trials) {
          try {
            await notifyNewTrials({
              phone:           orgWhatsApp.whatsapp_number,
              coordinatorName: coordinator?.name || 'Coordinator',
              patientCode:     patient.patient_code,
              diagnosis:       patient.diagnosis,
              newTrials:       summary.newTrials.map(t => ({
                title:      t.title,
                nctId:      t.nctId,
                matchScore: t.matchScore,
              })),
              orgName: (patient as any).organizations?.name,
            })
            log(`WhatsApp sent to ${orgWhatsApp.whatsapp_number} for ${patient.patient_code}`)
          } catch (e: any) {
            log(`WhatsApp failed for ${patient.patient_code}: ${e.message}`)
          }
        }

        // Email notification with full PDF
        if (coordinator?.email && newResult) {
          try {
            const fullResult = {
              summary:        `Weekly re-match: ${summary.newTrials.length} new trial(s) found for ${patient.patient_code}.`,
              trialsSearched: summary.allMatches.length,
              ctgovCount:     summary.allMatches.filter(m => m.source === 'ClinicalTrials.gov').length,
              ctriCount:      summary.allMatches.filter(m => m.source === 'CTRI').length,
              matches:        summary.allMatches,
              notMatched:     [],
              sourceStatus:   summary.sourceStatus,
            }
            const pdfBuffer = generateReportPDF(patient as any, fullResult)
            await sendMatchReport({
              to:        coordinator.email,
              patient:   patient as any,
              result:    fullResult,
              pdfBuffer,
              orgName:   (patient as any).organizations?.name,
              brandColor: (patient as any).organizations?.brand_color,
            })
            log(`Email sent to ${coordinator.email} for ${patient.patient_code}`)
          } catch (e: any) {
            log(`Email failed for ${patient.patient_code}: ${e.message}`)
          }
        }
      } else {
        log(`${patient.patient_code}: no new trials`)
      }

      // Rate limit — avoid hitting Claude API too fast
      await new Promise(r => setTimeout(r, 1500))

    } catch (e: any) {
      log(`Error processing ${patient.patient_code}: ${e.message}`)
      const oid = patient.org_id
      if (!orgSummaries[oid]) orgSummaries[oid] = { strongTotal: 0, partialTotal: 0, failed: 0, patients: 0 }
      orgSummaries[oid].failed++
    }
  }

  // Record run in audit log
  await db.from('audit_log').insert({
    action:   'scheduled_rematch_complete',
    metadata: { processed, withNewTrials, orgs: Object.keys(orgSummaries).length },
  })

  log(`Done. Processed: ${processed}, with new trials: ${withNewTrials}`)
  return { processed, withNewTrials }
}
