/**
 * scripts/seed-site-twins.ts
 * India Site Twin Network Seeder (Phase 2 — Week 7-8)
 *
 * Fetches all India-site clinical trials from ClinicalTrials.gov API v2,
 * extracts unique institutions, and upserts them into india_site_profiles.
 *
 * Run once after migration 006_site_twin.sql:
 *   npx ts-node --project tsconfig.scripts.json scripts/seed-site-twins.ts
 *
 * Then run site-twin-refresh weekly to keep metrics current.
 */

import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import Papa from 'papaparse'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface CTGovLocation {
  facility?: string
  city?:     string
  state?:    string
  country?:  string
  contacts?: { name?: string; email?: string; phone?: string; role?: string }[]
}

export interface SiteRecord {
  institution_name: string
  city:             string
  state:            string
  site_type:        string
  specialties:      string[]
  ctgov_nct_ids:    string[]
  ctri_ids?:        string[]   // populated by fetchCTRISites() below; optional since fetchCTgovSites() doesn't set it
  active_trials:    number
  pi_count:         number
}

// Classify site type from institution name
export function classifySiteType(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('research') && (n.includes('centre') || n.includes('center'))) return 'research_center'
  if (n.includes('aiims') || n.includes('pgi') || n.includes('jipmer')) return 'government'
  if (n.includes('university') || n.includes('college') || n.includes('institute of medical')) return 'academic'
  if (n.includes('cro') || n.includes('quintiles') || n.includes('covance') || n.includes('iqvia') || n.includes('labcorp')) return 'cro'
  return 'hospital'
}

// Infer specialties from trial title / condition keywords
export function inferSpecialties(conditions: string[], title: string): string[] {
  const text = [...conditions, title].join(' ').toLowerCase()
  const map: Record<string, string[]> = {
    'Oncology':        ['cancer','tumor','oncol','carcinoma','lymphoma','leukemia','sarcoma','glioma'],
    'Cardiology':      ['heart','cardiac','coronary','cardiovascular','hypertension','arrhythmia','atrial'],
    'Metabolic':       ['diabet','insulin','hba1c','metabolic','obesity','lipid','thyroid'],
    'Neurology':       ['neuro','alzheimer','parkinson','epilepsy','stroke','multiple sclerosis','dementia'],
    'Respiratory':     ['asthma','copd','pulmonary','lung','respiratory','bronchial'],
    'Gastroenterology':['liver','hepat','gastro','ibd','crohn','ulcerative','bowel','colon'],
    'Rheumatology':    ['arthritis','rheumat','lupus','autoimmune','inflammatory'],
    'Infectious':      ['hiv','hepatitis','tuberculosis','malaria','covid','infection','antimicrobial'],
    'Dermatology':     ['skin','dermat','psoriasis','eczema','atopic'],
    'Rare Disease':    ['rare','orphan','genetic','enzyme','lysosomal'],
  }
  const found: string[] = []
  for (const [specialty, keywords] of Object.entries(map)) {
    if (keywords.some(k => text.includes(k))) found.push(specialty)
  }
  return found.length > 0 ? found.slice(0, 4) : ['General Medicine']
}

async function fetchIndiaSites(): Promise<SiteRecord[]> {
  const siteMap = new Map<string, SiteRecord>()
  let pageToken: string | undefined
  let total = 0
  let pages = 0

  console.log('Fetching India clinical trial sites from ClinicalTrials.gov...')

  do {
    const params = new URLSearchParams({
      'query.locn': 'India',
      'filter.overallStatus': 'RECRUITING,ACTIVE_NOT_RECRUITING',
      'fields': 'NCTId,BriefTitle,Condition,LocationFacility,LocationCity,LocationState,LocationCountry,LocationContactName,LocationContactEMail,LocationContactPhone',
      'pageSize': '100',
      ...(pageToken ? { pageToken } : {}),
    })

    const url = `https://clinicaltrials.gov/api/v2/studies?${params}`

    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
      })
      if (!response.ok) {
        console.warn(`CT.gov API error: ${response.status}`)
        break
      }

      const data = await response.json()
      const studies = data.studies || []

      mergeStudiesIntoSiteMap(studies, siteMap)

      total += studies.length
      pages++
      pageToken = data.nextPageToken
      process.stdout.write(`\r  Processed ${total} studies, ${siteMap.size} unique sites so far...`)

    } catch (e) {
      console.warn('\nFetch error:', e)
      break
    }

    // Small delay to be respectful to the API
    await new Promise(r => setTimeout(r, 300))

  } while (pageToken && pages < 50)  // cap at 5,000 studies for seed run

  console.log(`\n\nFound ${siteMap.size} unique India sites from ${total} studies.`)
  return Array.from(siteMap.values())
}

/**
 * Parses a page of ClinicalTrials.gov API v2 study results and merges each
 * India-located site into the given siteMap. Pure (no network I/O) so it
 * can be unit-tested with fixture data — see
 * scripts/__tests__/seed-site-twins.test.ts.
 */
export function mergeStudiesIntoSiteMap(studies: any[], siteMap: Map<string, SiteRecord>): void {
  for (const study of studies) {
    const nctId      = study.protocolSection?.identificationModule?.nctId || ''
    const title      = study.protocolSection?.identificationModule?.briefTitle || ''
    const conditions = study.protocolSection?.conditionsModule?.conditions || []
    const locations  = study.protocolSection?.contactsLocationsModule?.locations || []

    for (const loc of locations) {
      if (!loc.country || loc.country !== 'India') continue
      if (!loc.facility) continue

      const key = `${loc.facility.toLowerCase().trim()}|${(loc.city || '').toLowerCase().trim()}`

      if (!siteMap.has(key)) {
        siteMap.set(key, {
          institution_name: loc.facility.trim(),
          city:             loc.city || '',
          state:            loc.state || '',
          site_type:        classifySiteType(loc.facility),
          specialties:      inferSpecialties(conditions, title),
          ctgov_nct_ids:    [nctId],
          active_trials:    1,
          pi_count:         0,
        })
      } else {
        const existing = siteMap.get(key)!
        if (!existing.ctgov_nct_ids.includes(nctId)) {
          existing.ctgov_nct_ids.push(nctId)
          existing.active_trials++
        }
        // Merge specialties
        for (const s of inferSpecialties(conditions, title)) {
          if (!existing.specialties.includes(s)) existing.specialties.push(s)
        }
        existing.specialties = existing.specialties.slice(0, 6)
      }
    }
  }
}

// FIX 3: Use the upsert_site_profile() RPC (created in migration 013_fixes.sql)
// instead of the broken JS-client upsert. The old onConflict:'institution_name,city'
// targeted column names but the unique index uses lower() expressions — causing
// duplicate rows on every seed run. The RPC uses ON CONFLICT (institution_city_key)
// which is a real generated column with a proper unique index.
async function upsertSites(sites: SiteRecord[]) {
  console.log(`\nUpserting ${sites.length} sites via upsert_site_profile RPC...`)
  let success = 0
  let errors  = 0

  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]
    const { error } = await supabase.rpc('upsert_site_profile', {
      p_institution_name: s.institution_name,
      p_city:             s.city             || '',
      p_state:            s.state            || '',
      p_site_type:        s.site_type,
      p_specialties:      s.specialties,
      p_ctgov_nct_ids:    s.ctgov_nct_ids,
      p_ctri_ids:         s.ctri_ids         || [],
      p_active_trials:    s.active_trials,
    })

    if (error) {
      errors++
      if (errors <= 5) console.warn(`\n  RPC error for "${s.institution_name}":`, error.message)
    } else {
      success++
    }

    if ((i + 1) % 50 === 0 || i === sites.length - 1) {
      process.stdout.write(`\r  Processed ${i + 1}/${sites.length} (${success} ok, ${errors} err)`)
    }
  }

  console.log(`\n\nDone. Upserted: ${success} · Errors: ${errors}`)
}

// FIX 5: Add CTRI site seeding (roadmap Week 7-8 said "CT.gov + CTRI")
// CTRI doesn't have a formal REST API. We use their public search export.
// Falls back gracefully if CTRI is unreachable — CT.gov sites are still seeded.
async function fetchCTRISites(): Promise<SiteRecord[]> {
  console.log('\nFetching CTRI India sites...')

  const CTRI_URL = 'https://ctri.nic.in/ctri/Utils/exportData.php?Id=all&stype=full'

  let csvText: string
  try {
    const res = await fetch(CTRI_URL, {
      headers: { 'User-Agent': 'TrialMatchIndia/2.0 (research; contact@trialmatch.in)' },
      signal:  AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      console.warn(`  CTRI returned HTTP ${res.status} — skipping CTRI sites`)
      return []
    }
    csvText = await res.text()
  } catch (e: any) {
    console.warn(`  CTRI unreachable (${e.message}) — skipping CTRI sites`)
    return []
  }

  const sites = parseCTRICsv(csvText)
  console.log(`  Found ${sites.length} unique CTRI sites`)
  return sites
}

/**
 * Parses CTRI's CSV export into deduplicated SiteRecords. Extracted as a
 * pure function (no network I/O) so it can be unit-tested with fixture data
 * — see scripts/__tests__/seed-site-twins.test.ts.
 *
 * Uses papaparse (already a dependency, used elsewhere for HMS CSV import)
 * instead of a naive `line.split(',')`. The naive split breaks on any
 * quoted field containing a comma — a real risk here, not a theoretical
 * one: CTRI institution names routinely include one, e.g.
 * "All India Institute of Medical Sciences, New Delhi". A naive split
 * would misalign every column after the first embedded comma.
 */
export function parseCTRICsv(csvText: string): SiteRecord[] {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  })

  const siteMap = new Map<string, SiteRecord>()

  for (const row of parsed.data) {
    const ctriId    = row['CTRI_NUMBER'] || row['Trial_ID'] || ''
    const piInst    = row['INSTITUTE']   || row['Site_Institution'] || row['ORGANISATION'] || ''
    const piCity    = row['CITY']        || row['Site_City']        || ''
    const piState   = row['STATE']       || row['Site_State']       || ''
    const titleRaw  = row['TRIAL_TITLE'] || row['Title']            || ''

    if (!piInst || piInst.trim().length < 3) continue

    const key = `${piInst.toLowerCase().trim()}|${piCity.toLowerCase().trim()}`
    if (siteMap.has(key)) {
      const existing = siteMap.get(key)!
      if (ctriId && !existing.ctri_ids!.includes(ctriId)) existing.ctri_ids!.push(ctriId)
      existing.active_trials++
    } else {
      siteMap.set(key, {
        institution_name: piInst.trim(),
        city:             piCity.trim(),
        state:            piState.trim(),
        site_type:        classifySiteType(piInst),
        specialties:      inferSpecialties([], titleRaw),
        ctgov_nct_ids:    [],
        ctri_ids:         ctriId ? [ctriId] : [],
        active_trials:    1,
        pi_count:         0,
      })
    }
  }

  return Array.from(siteMap.values())
}

async function main() {
  console.log('=== TrialMatch India — Site Twin Network Seeder ===')
  console.log('Prerequisite: migration 013_fixes.sql must be run first.\n')

  // CT.gov sites
  const ctgovSites = await fetchIndiaSites()
  if (ctgovSites.length === 0) {
    console.log('No CT.gov sites found. Check your network connection.')
    process.exit(1)
  }

  // FIX 5: CTRI sites
  const ctriSites = await fetchCTRISites()

  // Merge: CT.gov sites take precedence; CTRI adds new sites not on CT.gov
  const allSites = [...ctgovSites]
  const ctgovKeys = new Set(ctgovSites.map(s =>
    `${s.institution_name.toLowerCase()}|${(s.city || '').toLowerCase()}`
  ))
  for (const s of ctriSites) {
    const k = `${s.institution_name.toLowerCase()}|${(s.city || '').toLowerCase()}`
    if (!ctgovKeys.has(k)) allSites.push(s)
  }

  console.log(`\nTotal unique sites to seed: ${allSites.length} (CT.gov: ${ctgovSites.length}, CTRI-only: ${allSites.length - ctgovSites.length})`)

  await upsertSites(allSites)

  const { count } = await supabase
    .from('india_site_profiles')
    .select('*', { count: 'exact', head: true })

  console.log(`\n✅ india_site_profiles now has ${count} rows.`)
  console.log('\nNext steps:')
  console.log('1. Run: SELECT refresh_site_twin_performance(); in Supabase SQL editor')
  console.log('2. Visit the Site Network tab in your dashboard')
}

// Guarded so importing this module's pure functions for testing (see
// scripts/__tests__/seed-site-twins.test.ts) doesn't trigger a live run —
// previously main() executed unconditionally at module load, meaning
// simply importing classifySiteType/parseCTRICsv/etc. for a unit test
// would have made real network calls to ClinicalTrials.gov/CTRI and
// real writes to Supabase.
if (require.main === module) {
  main().catch(e => {
    console.error('Seeder failed:', e)
    process.exit(1)
  })
}
