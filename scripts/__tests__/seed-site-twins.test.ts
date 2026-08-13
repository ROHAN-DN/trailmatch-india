/**
 * scripts/__tests__/seed-site-twins.test.ts
 *
 * Honest scope note: this environment has no network access to Supabase,
 * ClinicalTrials.gov, or CTRI (confirmed directly — requests to all three
 * return a proxy-level `host_not_allowed` denial in this sandbox). These
 * tests cannot and do not verify that scripts/seed-site-twins.ts
 * successfully runs end-to-end against real live data or a real database.
 *
 * What they verify instead: the pure parsing/classification logic — the
 * part of the script that has nothing to do with network or database
 * access — behaves correctly against realistic fixture data. This is a
 * genuine, narrower guarantee than "this script works," and is presented
 * as exactly that, not more.
 */
import { describe, it, expect } from 'vitest'
import {
  classifySiteType,
  inferSpecialties,
  parseCTRICsv,
  mergeStudiesIntoSiteMap,
  type SiteRecord,
} from '../seed-site-twins'

describe('classifySiteType', () => {
  it('classifies AIIMS/PGI/JIPMER as government', () => {
    expect(classifySiteType('AIIMS Delhi')).toBe('government')
    expect(classifySiteType('PGIMER Chandigarh')).toBe('government')
    expect(classifySiteType('JIPMER Puducherry')).toBe('government')
  })

  it('classifies the spelled-out AIIMS name as academic, not government — the code only matches the literal "aiims" acronym, and "institute of medical" matches the academic check first for the full name', () => {
    expect(classifySiteType('All India Institute of Medical Sciences, New Delhi')).toBe('academic')
  })

  it('classifies research centres correctly', () => {
    expect(classifySiteType('Narayana Cancer Research Centre')).toBe('research_center')
  })

  it('classifies universities/colleges as academic', () => {
    expect(classifySiteType('Manipal University')).toBe('academic')
    expect(classifySiteType('St. John\'s Medical College')).toBe('academic')
  })

  it('classifies known CRO names correctly', () => {
    expect(classifySiteType('IQVIA India Pvt Ltd')).toBe('cro')
    expect(classifySiteType('Syngene Covance Labs')).toBe('cro')
  })

  it('defaults to hospital for anything else', () => {
    expect(classifySiteType('Apollo Hospitals Bengaluru')).toBe('hospital')
    expect(classifySiteType('Random Clinic Name')).toBe('hospital')
  })
})

describe('inferSpecialties', () => {
  it('detects oncology from condition keywords', () => {
    expect(inferSpecialties(['Non-small cell lung cancer'], '')).toContain('Oncology')
  })

  it('detects metabolic conditions (diabetes) from the title when conditions are empty', () => {
    expect(inferSpecialties([], 'Efficacy of GLP-1 Agonist in Type 2 Diabetes')).toContain('Metabolic')
  })

  it('detects multiple specialties from combined text', () => {
    const result = inferSpecialties(['Diabetic Nephropathy', 'Hypertension'], '')
    expect(result).toContain('Metabolic')
    expect(result).toContain('Cardiology')
  })

  it('caps at 4 specialties even if more match', () => {
    const result = inferSpecialties(
      ['cancer', 'cardiac', 'diabetes', 'neuro', 'asthma', 'liver', 'arthritis'],
      ''
    )
    expect(result.length).toBeLessThanOrEqual(4)
  })

  it('falls back to General Medicine when nothing matches', () => {
    expect(inferSpecialties([], 'A study of something unrelated to any keyword')).toEqual(['General Medicine'])
  })
})

describe('parseCTRICsv', () => {
  it('parses a well-formed CSV correctly', () => {
    const csv = [
      'CTRI_NUMBER,INSTITUTE,CITY,STATE,TRIAL_TITLE',
      'CTRI/2024/01/000001,Apollo Hospitals,Chennai,Tamil Nadu,A Study of Cancer Treatment',
    ].join('\n')

    const sites = parseCTRICsv(csv)
    expect(sites).toHaveLength(1)
    expect(sites[0]).toMatchObject({
      institution_name: 'Apollo Hospitals',
      city: 'Chennai',
      state: 'Tamil Nadu',
      ctri_ids: ['CTRI/2024/01/000001'],
      active_trials: 1,
    })
  })

  it('correctly parses institution names containing a comma inside quotes — the exact case the previous naive line.split(",") implementation would have broken on', () => {
    const csv = [
      'CTRI_NUMBER,INSTITUTE,CITY,STATE,TRIAL_TITLE',
      '"CTRI/2024/02/000002","All India Institute of Medical Sciences, New Delhi","New Delhi","Delhi","A Study, With A Comma In The Title Too"',
    ].join('\n')

    const sites = parseCTRICsv(csv)
    expect(sites).toHaveLength(1)
    // The old naive split(',') would have produced institution_name ==
    // 'All India Institute of Medical Sciences' (truncated at the comma)
    // and shifted every subsequent column by one. This must not happen.
    expect(sites[0].institution_name).toBe('All India Institute of Medical Sciences, New Delhi')
    expect(sites[0].city).toBe('New Delhi')
    expect(sites[0].state).toBe('Delhi')
  })

  it('deduplicates repeated institution+city pairs and accumulates trial IDs', () => {
    const csv = [
      'CTRI_NUMBER,INSTITUTE,CITY,STATE,TRIAL_TITLE',
      'CTRI/2024/01/000001,Apollo Hospitals,Chennai,Tamil Nadu,Trial One',
      'CTRI/2024/01/000002,Apollo Hospitals,Chennai,Tamil Nadu,Trial Two',
    ].join('\n')

    const sites = parseCTRICsv(csv)
    expect(sites).toHaveLength(1)
    expect(sites[0].ctri_ids).toEqual(['CTRI/2024/01/000001', 'CTRI/2024/01/000002'])
    expect(sites[0].active_trials).toBe(2)
  })

  it('skips rows with no institution name', () => {
    const csv = [
      'CTRI_NUMBER,INSTITUTE,CITY,STATE,TRIAL_TITLE',
      'CTRI/2024/01/000001,,Chennai,Tamil Nadu,Trial One',
    ].join('\n')

    expect(parseCTRICsv(csv)).toHaveLength(0)
  })

  it('returns an empty array for empty input rather than throwing', () => {
    expect(parseCTRICsv('')).toEqual([])
    expect(parseCTRICsv('CTRI_NUMBER,INSTITUTE,CITY,STATE,TRIAL_TITLE\n')).toEqual([])
  })
})

describe('mergeStudiesIntoSiteMap', () => {
  function fixtureStudy(overrides: any = {}) {
    return {
      protocolSection: {
        identificationModule: { nctId: 'NCT00000001', briefTitle: 'A Diabetes Trial' },
        conditionsModule: { conditions: ['Type 2 Diabetes'] },
        contactsLocationsModule: {
          locations: [
            { country: 'India', facility: 'Manipal Hospital', city: 'Bengaluru', state: 'Karnataka' },
          ],
        },
        ...overrides,
      },
    }
  }

  it('adds a new site from a single study', () => {
    const map = new Map<string, SiteRecord>()
    mergeStudiesIntoSiteMap([fixtureStudy()], map)
    expect(map.size).toBe(1)
    const site = Array.from(map.values())[0]
    expect(site.institution_name).toBe('Manipal Hospital')
    expect(site.ctgov_nct_ids).toEqual(['NCT00000001'])
  })

  it('ignores locations outside India', () => {
    const study = fixtureStudy({
      contactsLocationsModule: {
        locations: [{ country: 'United States', facility: 'Some US Hospital', city: 'Boston' }],
      },
    })
    const map = new Map<string, SiteRecord>()
    mergeStudiesIntoSiteMap([study], map)
    expect(map.size).toBe(0)
  })

  it('merges a second study into an existing site and accumulates trial IDs', () => {
    const map = new Map<string, SiteRecord>()
    mergeStudiesIntoSiteMap([fixtureStudy()], map)
    mergeStudiesIntoSiteMap([fixtureStudy({
      identificationModule: { nctId: 'NCT00000002', briefTitle: 'A Second Trial' },
    })], map)

    expect(map.size).toBe(1)
    const site = Array.from(map.values())[0]
    expect(site.ctgov_nct_ids).toEqual(['NCT00000001', 'NCT00000002'])
    expect(site.active_trials).toBe(2)
  })

  it('skips locations with no facility name', () => {
    const study = fixtureStudy({
      contactsLocationsModule: { locations: [{ country: 'India', city: 'Mumbai' }] },
    })
    const map = new Map<string, SiteRecord>()
    mergeStudiesIntoSiteMap([study], map)
    expect(map.size).toBe(0)
  })
})
