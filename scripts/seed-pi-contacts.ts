/**
 * scripts/seed-pi-contacts.ts
 * Fetches India-site recruiting trials from ClinicalTrials.gov and
 * populates the pi_contacts table.
 *
 * Run once after migration 002:
 *   npx ts-node --project tsconfig.scripts.json scripts/seed-pi-contacts.ts
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL     = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const SPECIALTY_KEYWORDS: Record<string, string> = {
  diabetes:'endocrinology', insulin:'endocrinology', thyroid:'endocrinology',
  cancer:'oncology', tumor:'oncology', carcinoma:'oncology', lymphoma:'oncology',
  leukemia:'oncology', oncol:'oncology', melanoma:'oncology',
  cardiac:'cardiology', heart:'cardiology', coronary:'cardiology', hypertension:'cardiology',
  neuro:'neurology', brain:'neurology', stroke:'neurology', epilepsy:'neurology',
  kidney:'nephrology', renal:'nephrology',
  lung:'pulmonology', respiratory:'pulmonology', copd:'pulmonology', asthma:'pulmonology',
  arthritis:'rheumatology', lupus:'rheumatology', autoimmune:'rheumatology',
  liver:'gastroenterology', hepat:'gastroenterology', gastr:'gastroenterology',
  hiv:'infectious_disease', covid:'infectious_disease', tuberculos:'infectious_disease',
  mental:'psychiatry', depression:'psychiatry', schizophrenia:'psychiatry',
  dermat:'dermatology', skin:'dermatology',
  ophthalm:'ophthalmology', eye:'ophthalmology',
  orthop:'orthopaedics', bone:'orthopaedics',
  paediatric:'paediatrics', pediatric:'paediatrics',
  obstetric:'obstetrics', gynaecol:'obstetrics',
  uro:'urology', bladder:'urology',
}

function detectSpecialty(conditions: string[]): string {
  const text = conditions.join(' ').toLowerCase()
  for (const [k, v] of Object.entries(SPECIALTY_KEYWORDS)) if (text.includes(k)) return v
  return 'general'
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function fetchPage(pageToken?: string): Promise<{ studies: any[]; nextPageToken?: string }> {
  const params = new URLSearchParams({
    'filter.overallStatus': 'RECRUITING',
    'filter.locn':          'India',
    'fields':               'NCTId,BriefTitle,Condition,ContactsLocations',
    'pageSize':             '100',
  })
  if (pageToken) params.set('pageToken', pageToken)

  const res = await fetch(`https://clinicaltrials.gov/api/v2/studies?${params}`)

  if (res.status === 429) {
    console.log('Rate limited — waiting 30s...')
    await sleep(30_000)
    return fetchPage(pageToken)
  }
  if (!res.ok) {
    console.error(`CT.gov API error: ${res.status}`)
    return { studies: [] }
  }
  const data = await res.json()
  return { studies: data.studies || [], nextPageToken: data.nextPageToken }
}

function extractContacts(study: any): any[] {
  const p = study.protocolSection || {}
  const id = p.identificationModule || {}
  const locs = p.contactsLocationsModule || {}
  const conds = p.conditionsModule?.conditions || []
  const specialty = detectSpecialty(conds)
  const nctId = id.nctId || null
  const title = id.briefTitle || ''
  const contacts: any[] = []

  for (const location of locs.locations || []) {
    if (location.country !== 'India') continue
    for (const contact of location.contacts || []) {
      if (!contact.name && !contact.email && !contact.phone) continue
      contacts.push({
        nct_id: nctId, trial_title: title,
        pi_name: contact.name || null, pi_email: contact.email || null, pi_phone: contact.phone || null,
        pi_institution: location.facility || null, pi_city: location.city || null, pi_state: location.state || null,
        specialty, source: 'ctgov',
      })
    }
  }

  const hasIndia = (locs.locations || []).some((l: any) => l.country === 'India')
  if (hasIndia) {
    for (const central of locs.centralContacts || []) {
      if (!central.name && !central.email) continue
      contacts.push({
        nct_id: nctId, trial_title: title,
        pi_name: central.name || null, pi_email: central.email || null, pi_phone: central.phone || null,
        pi_institution: null, pi_city: null, pi_state: null, specialty, source: 'ctgov',
      })
    }
  }
  return contacts
}

async function main() {
  console.log('Starting PI contact seeding from ClinicalTrials.gov...\n')
  let totalContacts = 0, totalStudies = 0, page = 1
  let nextToken: string | undefined

  do {
    process.stdout.write(`Page ${page}... `)
    const { studies, nextPageToken } = await fetchPage(nextToken)
    if (!studies.length) { console.log('No more studies — ending.'); break }

    totalStudies += studies.length
    const batch: any[] = []
    for (const study of studies) batch.push(...extractContacts(study))

    if (batch.length > 0) {
      const CHUNK = 200
      for (let i = 0; i < batch.length; i += CHUNK) {
        const chunk = batch.slice(i, i + CHUNK)
        const { error } = await db.from('pi_contacts').upsert(chunk, { onConflict: 'nct_id,pi_email', ignoreDuplicates: true })
        if (error) console.error(`Upsert error page ${page}:`, error.message)
        else totalContacts += chunk.length
      }
    }
    console.log(`${studies.length} studies, ${batch.length} contacts (total: ${totalContacts})`)
    nextToken = nextPageToken
    page++
    await sleep(500)
  } while (nextToken)

  console.log('\n─────────────────────────────────')
  console.log(`Studies processed: ${totalStudies}`)
  console.log(`Contacts upserted: ${totalContacts}`)
  console.log('─────────────────────────────────')

  const { count } = await db.from('pi_contacts').select('*', { count: 'exact', head: true })
  console.log(`Total records in pi_contacts: ${count}`)

  if ((count || 0) < 5000) {
    console.warn('\n⚠ Fewer contacts than expected — check CT.gov India site filtering.')
  } else {
    console.log('\n✅ Seeding successful.')
  }
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1) })


// ═══════════════════════════════════════════════════════════════════
// CTRI (Clinical Trials Registry India) seeding — Phase 1 gap fix
// ═══════════════════════════════════════════════════════════════════
// CTRI public search API: https://ctri.nic.in/Clinicaltrials/searchf.php
// CTRI does not have a formal REST API; we scrape the public CSV export.
// Export URL: https://ctri.nic.in/ctri/Utils/exportData.php
// Falls back gracefully if CTRI is unreachable.

async function fetchCTRIPIContacts(): Promise<void> {
  console.log('\n=== Fetching CTRI India PI contacts ===')

  const CTRI_EXPORT_URL =
    'https://ctri.nic.in/ctri/Utils/exportData.php?Id=all&stype=full'

  let csvText: string
  try {
    const res = await fetch(CTRI_EXPORT_URL, {
      headers: { 'User-Agent': 'TrialMatchIndia/1.0 (research tool)' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      console.warn(`CTRI export returned HTTP ${res.status} — skipping CTRI seeding`)
      return
    }
    csvText = await res.text()
  } catch (e) {
    console.warn('CTRI unreachable — skipping CTRI seed. Run manually later.')
    return
  }

  const lines = csvText.split('\n').filter(Boolean)
  if (lines.length < 2) {
    console.warn('CTRI export was empty — skipping')
    return
  }

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  const rows    = lines.slice(1)

  const contacts: any[] = []
  for (const line of rows) {
    const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''))
    const row: Record<string,string> = {}
    headers.forEach((h, i) => { row[h] = cols[i] || '' })

    // CTRI CSV columns vary by export version — handle common field names
    const ctriId    = row['CTRI_NUMBER'] || row['Trial_ID']           || ''
    const piName    = row['PI_NAME']     || row['Principal_Investigator'] || ''
    const piInst    = row['INSTITUTE']   || row['Site_Institution']   || ''
    const piCity    = row['CITY']        || row['Site_City']          || ''
    const piState   = row['STATE']       || row['Site_State']         || ''
    const piEmail   = row['PI_EMAIL']    || row['Email']              || ''
    const titleRaw  = row['TRIAL_TITLE'] || row['Title']              || ''

    if (!ctriId || !piName || !piInst) continue

    const specialty = inferSpecialtyFromTitle(titleRaw)
    contacts.push({
      ctri_id:        ctriId,
      nct_id:         null,   // CTRI trials may not have NCT IDs
      pi_name:        piName.slice(0, 200),
      pi_institution: piInst.slice(0, 300),
      pi_city:        piCity.slice(0, 100),
      pi_state:       piState.slice(0, 100),
      pi_email:       piEmail.includes('@') ? piEmail.toLowerCase() : null,
      specialty,
      trial_title:    titleRaw.slice(0, 500),
      source:         'ctri',
      times_contacted: 0,
      email_bounced:  false,
      verified:       false,
    })
  }

  if (contacts.length === 0) {
    console.log('No CTRI contacts parsed from export')
    return
  }

  console.log(`Parsed ${contacts.length} CTRI PI contacts`)

  let inserted = 0
  for (let i = 0; i < contacts.length; i += 100) {
    const batch = contacts.slice(i, i + 100)
    const { error } = await db.from('pi_contacts').upsert(batch, {
      onConflict: 'ctri_id,pi_name',
      ignoreDuplicates: false,
    })
    if (error) console.warn(`CTRI batch error (${i}):`, error.message)
    else inserted += batch.length
    process.stdout.write(`\r  Upserted ${Math.min(i + 100, contacts.length)}/${contacts.length}`)
  }
  console.log(`\nCTRI: inserted/updated ${inserted} records`)
}

function inferSpecialtyFromTitle(title: string): string {
  const t = title.toLowerCase()
  const map: [string, string[]][] = [
    ['oncology',       ['cancer','tumor','oncol','carcinoma','lymphoma','leukemia']],
    ['cardiology',     ['cardiac','heart','coronary','hypertension','cardiovascular']],
    ['endocrinology',  ['diabetes','insulin','thyroid','metabolic','obesity']],
    ['neurology',      ['neuro','parkinson','alzheimer','epilepsy','stroke']],
    ['respiratory',    ['asthma','copd','pulmonary','lung','respiratory']],
    ['gastroenterology',['liver','hepat','gastro','ibd','crohn','bowel']],
    ['rheumatology',   ['arthritis','lupus','autoimmune','rheumat']],
    ['infectious',     ['hiv','covid','tuberculosis','malaria','infection']],
  ]
  for (const [specialty, kws] of map) {
    if (kws.some(k => t.includes(k))) return specialty
  }
  return 'general_medicine'
}

// Extend the main function to run CTRI after CT.gov.
// Guarded the same way as scripts/seed-site-twins.ts and for the same
// reason — this used to run unconditionally at module load, so importing
// any function from this file (e.g. for a future test) would trigger a
// live seeding run against real ClinicalTrials.gov/CTRI and Supabase.
if (require.main === module) {
  ;(async function extendedMain() {
    await main()
    await fetchCTRIPIContacts()
    console.log('\n✅ Seeding complete (CT.gov + CTRI)')
  })()
}
