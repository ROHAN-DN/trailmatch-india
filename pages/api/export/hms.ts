/**
 * pages/api/export/hms.ts — Production rewrite
 * GET /api/export/hms?job_id=<uuid>
 *
 * Returns a UTF-8 BOM CSV download in Insta HMS clinical_trial_referrals format.
 * Audit-logged as a data export event (DPDP Act compliance).
 */
import { withApiHandler } from '../../../lib/api-handler'
import { writeAudit } from '../../../lib/audit'
import { buildHMSExportRows, rowsToCSV } from '../../../lib/hms-export'
import { NotFoundError } from '../../../lib/errors'

export default withApiHandler(async (req, res, ctx) => {
  const { db, user, org } = ctx
  const { job_id } = req.query

  let q = db
    .from('match_results')
    .select('*, patients(*)')
    .eq('org_id', org.id)
    .eq('status', 'done')
    .order('created_at', { ascending: false })
    .limit(500)

  if (job_id) q = q.eq('job_id', job_id as string)

  const { data: results, error } = await q

  if (error)                   throw new Error(error.message)
  if (!results?.length)        throw new NotFoundError('Match results for this job')

  /* Load PI contacts for top trial per result */
  const nctIds = [...new Set(
    results.map((r: any) => r.matches?.[0]?.nctId).filter(Boolean)
  )]

  const { data: pis } = await db
    .from('pi_contacts')
    .select('nct_id, pi_name, pi_institution, pi_phone')
    .in('nct_id', nctIds.slice(0, 200))
    .eq('email_bounced', false)

  const piByNct: Record<string, any> = {}
  for (const pi of pis || []) {
    if (!piByNct[pi.nct_id]) piByNct[pi.nct_id] = pi
  }

  const rows = buildHMSExportRows(results, piByNct)
  const csv  = rowsToCSV(rows)

  const filename = job_id
    ? `trialmatch-hms-${(job_id as string).slice(0, 8)}-${new Date().toISOString().split('T')[0]}.csv`
    : `trialmatch-hms-export-${new Date().toISOString().split('T')[0]}.csv`

  writeAudit({
    action:      'data:export_hms',
    org_id:      org.id,
    user_id:     user.id,
    entity_type: 'match_results',
    entity_id:   job_id as string | undefined,
    metadata:    { row_count: rows.length, filename },
    ip_address:  ctx.ipAddress,
  })

  res.setHeader('Content-Type',        'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Cache-Control',       'no-store')
  return res.send(csv)
}, { methods: ['GET'] })
