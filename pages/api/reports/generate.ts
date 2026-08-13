/**
 * pages/api/reports/generate.ts
 *
 * FIX 1: The PDF download link in PreScreeningChecklistCard pointed here
 * but this route didn't exist — causing a 404 for every coordinator
 * who clicked "Download PDF" after reviewing a checklist.
 *
 * GET /api/reports/generate?job_id=&include_prescreening=1&nct_id=
 * GET /api/reports/generate?match_result_id=&include_prescreening=1&nct_id=
 *
 * Loads patient + match result + (optionally) pre-screening checklist,
 * calls generateReportPDF() with the prescreening option, returns the PDF.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'
import { generateReportPDF } from '../../../lib/pdf'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).end()
  }

  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorised' })

  const user   = session.user as any
  const orgId  = user.org_id
  const db     = supabaseAdmin()

  const { job_id, match_result_id, include_prescreening, nct_id } = req.query

  if (!job_id && !match_result_id) {
    return res.status(400).json({ error: 'job_id or match_result_id is required' })
  }

  // ── Load match result + patient ──────────────────────────────────────────
  let q = db
    .from('match_results')
    .select('*, patients(*)')
    .eq('org_id', orgId)
    .eq('status', 'done')

  if (match_result_id) q = q.eq('id', match_result_id as string)
  else                  q = (q.eq('job_id', job_id as string) as any).limit(1)

  const { data, error } = await (q as any).single()

  if (error || !data) {
    return res.status(404).json({ error: 'Match result not found or not yet complete.' })
  }

  const patient = data.patients
  if (!patient) {
    return res.status(404).json({ error: 'Patient record not found for this result.' })
  }

  // Reconstruct the MatchResult shape expected by generateReportPDF
  const result = {
    matches:        data.matches        || [],
    summary:        data.summary        || '',
    trialsSearched: data.trials_searched || 0,
    ctgovCount:     data.ctgov_count    || 0,
    ctriCount:      data.ctri_count     || 0,
    notMatched:     data.not_matched    || [],
  }

  // ── Load pre-screening checklist (optional) ──────────────────────────────
  let prescreeningOption: any = undefined

  if (include_prescreening === '1' && nct_id) {
    const { data: cl } = await db
      .from('prescreening_checklists')
      .select('nct_id, trial_title, checklist, status')
      .eq('match_result_id', data.id)
      .eq('nct_id',          nct_id as string)
      .eq('org_id',          orgId)
      .eq('status',          'reviewed')   // only include reviewed checklists in PDF
      .single()

    // Unreviewed checklist: still include but with a note
    if (!cl) {
      const { data: clAny } = await db
        .from('prescreening_checklists')
        .select('nct_id, trial_title, checklist, status')
        .eq('match_result_id', data.id)
        .eq('nct_id',          nct_id as string)
        .eq('org_id',          orgId)
        .single()

      if (clAny?.checklist?.length) {
        prescreeningOption = {
          nct_id:      clAny.nct_id,
          trial_title: clAny.trial_title || (nct_id as string),
          checklist:   clAny.checklist,
          status:      clAny.status,
        }
      }
    } else if (cl?.checklist?.length) {
      prescreeningOption = {
        nct_id:      cl.nct_id,
        trial_title: cl.trial_title || (nct_id as string),
        checklist:   cl.checklist,
        status:      cl.status,
      }
    }
  }

  // ── Generate PDF ─────────────────────────────────────────────────────────
  let pdfBuffer: Buffer
  try {
    pdfBuffer = generateReportPDF(
      patient,
      result as any,
      prescreeningOption ? { prescreening: prescreeningOption } : undefined
    )
  } catch (e: any) {
    console.error('[reports/generate] PDF generation failed:', e.message)
    return res.status(500).json({ error: 'PDF generation failed. Please try again.' })
  }

  const filename = `trialmatch-${patient.patient_code}-${new Date().toISOString().split('T')[0]}.pdf`

  res.setHeader('Content-Type',        'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Cache-Control',       'private, no-cache, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  return res.send(pdfBuffer)
}
