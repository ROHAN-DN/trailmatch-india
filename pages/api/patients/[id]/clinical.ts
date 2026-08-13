import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../../auth/[...nextauth]'
import { supabaseAdmin } from '../../../../lib/supabase'
import { readStructuredClinicalData } from '../../../../lib/clinical-data'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).end(`Method ${req.method} not allowed`)
  }

  const { id } = req.query
  if (typeof id !== 'string') return res.status(400).json({ error: 'Missing patient id' })

  const user   = session.user as any
  const db     = supabaseAdmin()
  const org_id = user.org_id

  // Confirm the patient actually belongs to this org before returning
  // anything — readStructuredClinicalData already scopes every query by
  // org_id too, but this gives a clean 404 instead of a confusing empty
  // result for a patient ID that exists in a different org.
  const { data: patient, error: patientError } = await db
    .from('patients').select('id').eq('id', id).eq('org_id', org_id).single()
  if (patientError || !patient) return res.status(404).json({ error: 'Patient not found' })

  const result = await readStructuredClinicalData(db, org_id, id)
  if ('error' in result) return res.status(500).json({ error: result.error })

  return res.json(result)
}
