/**
 * lib/ctri-bulk-export.ts
 *
 * CTRI's live "Trial Search" page (what lib/matcher.ts's fetchCTRI has
 * always used) requires a CAPTCHA on submission — confirmed by fetching
 * the real page directly, outside this app, during this project's audit.
 * A bare GET request can never satisfy that, so that endpoint is
 * architecturally a dead end for automated matching, not just fragile.
 *
 * scripts/seed-site-twins.ts already references a DIFFERENT CTRI
 * endpoint — `ctri.nic.in/ctri/Utils/exportData.php?Id=all&stype=full` —
 * for a completely separate purpose (seeding the site-twin directory).
 * That endpoint's shape (a bulk data EXPORT, not an interactive search
 * FORM) is architecturally the kind of endpoint that typically isn't
 * CAPTCHA-gated — CAPTCHAs defend interactive forms against scraping,
 * not usually a registry's own bulk-export feature. Nobody has actually
 * verified this endpoint works, what it returns, or its real column
 * structure — including this pass. ctri.nic.in is not reachable from
 * this sandbox (not on the network allowlist for direct fetches, and
 * this exact URL never surfaced in a fetchable search result either).
 *
 * Given that genuine uncertainty, this module is deliberately built to
 * discover its own success or failure rather than assume either:
 *   - Column matching is alias-based and case/punctuation-insensitive,
 *     not a hard-coded exact header list — because the real header text
 *     has never been confirmed.
 *   - A response is only trusted as usable data if it structurally looks
 *     like the CSV this code expects (has a header row, and enough of
 *     the core fields could be located) — anything else is reported as
 *     an explicit mapping failure, with exactly which fields couldn't be
 *     found, not silently treated as "zero trials."
 *   - lib/matcher.ts's fetchCTRI (see that file) only trusts this
 *     module's output when it reports success, and falls back to the
 *     existing CAPTCHA-detecting search-scrape otherwise — so if this
 *     endpoint turns out not to work either, behaviour doesn't regress,
 *     it degrades to exactly what existed before this module.
 *
 * The first real deployment against a live network is what actually
 * settles which of these paths (if either) works — this module's job is
 * to make that immediately observable (via the `unmappedFields` /
 * `looksValid` it returns) rather than hide it behind a guess.
 */

import Papa from 'papaparse'

export interface CTRIBulkTrial {
  ctriId:            string
  title:             string
  condition:         string
  phase:             string
  sponsor:           string
  recruitmentStatus: string
  minAge:            string
  maxAge:            string
  eligibilityText:   string
  city:              string
  state:             string
}

export interface CTRIBulkParseResult {
  trials:         CTRIBulkTrial[]
  totalRowsSeen:  number
  /** Logical fields this parse could NOT find a matching column for, at all. Non-empty for the core fields (trialId, title) means the file's structure didn't match any known alias — treat as unusable, not as "zero trials." */
  unmappedFields: string[]
  /** True only when both trialId and title were mapped AND at least one row produced a plausible CTRI ID. False means: don't trust `trials` as real data, even if it's an empty array. */
  looksValid:     boolean
}

// Every alias list includes the exact strings scripts/seed-site-twins.ts's
// parseCTRICsv already assumed (CTRI_NUMBER, Trial_ID, TRIAL_TITLE, Title,
// etc.) — that represents a previous, real research attempt at this same
// question for a different purpose, and is at least as credible a
// starting point as anything guessed fresh here. Additional variants are
// derived from the WHO Trial Registration Data Set's own item names
// (authoritative, WHO-published terminology every primary registry,
// CTRI included, is required to report against — see who.int/tools/
// clinical-trials-registry-platform/network/who-data-set), since a
// registry's own export is a plausible place to find its field names
// echoing that standard vocabulary.
const CTRI_EXPORT_FIELD_ALIASES: Record<keyof Omit<CTRIBulkTrial, 'eligibilityText'> | 'eligibilityText', string[]> = {
  ctriId: [
    'CTRI_NUMBER', 'Trial_ID', 'CTRI Number', 'CTRI No', 'CTRI_No', 'Registration Number',
    'Reg No', 'REG_ID', 'Primary Registry and Trial Identifying Number',
  ],
  title: [
    'TRIAL_TITLE', 'Title', 'Public Title', 'PUBLIC_TITLE', 'Scientific Title', 'SCIENTIFIC_TITLE',
  ],
  condition: [
    'Health Condition', 'HEALTH_CONDITION', 'Condition', 'DISEASE', 'Health_Condition',
    'Health Condition(s) or Problem(s) Studied', 'Health Type',
  ],
  phase: ['Phase', 'PHASE', 'Study Phase', 'Phase of Trial'],
  sponsor: [
    'Sponsor', 'SPONSOR', 'Primary Sponsor', 'PRIMARY_SPONSOR', 'Source of Monetary or Material Support',
  ],
  recruitmentStatus: [
    'Recruitment Status', 'RECRUITMENT_STATUS', 'Status', 'STATUS', 'Overall Status', 'Public Status',
  ],
  minAge: ['Minimum Age', 'MIN_AGE', 'Age From', 'AGE_FROM', 'Age Min'],
  maxAge: ['Maximum Age', 'MAX_AGE', 'Age To', 'AGE_TO', 'Age Max'],
  eligibilityText: [
    'Inclusion Criteria', 'INCLUSION_CRITERIA', 'Eligibility Criteria', 'ELIGIBILITY_CRITERIA',
    'Inclusion/Exclusion Criteria', 'Key Inclusion and Exclusion Criteria', 'Inclusion Exclusion Criteria',
  ],
  city:  ['CITY', 'Site_City', 'City', 'Recruitment City'],
  state: ['STATE', 'Site_State', 'State', 'Recruitment State'],
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Case/punctuation-insensitive alias matching, built once per file (headers are shared across every row) rather than re-matched per row. */
function buildFieldMap(actualHeaders: string[]): { fieldMap: Partial<Record<keyof typeof CTRI_EXPORT_FIELD_ALIASES, string>>; unmapped: string[] } {
  const normalizedToActual = new Map<string, string>()
  for (const h of actualHeaders) normalizedToActual.set(normalizeHeader(h), h)

  const fieldMap: Partial<Record<keyof typeof CTRI_EXPORT_FIELD_ALIASES, string>> = {}
  const unmapped: string[] = []
  for (const [logicalField, aliases] of Object.entries(CTRI_EXPORT_FIELD_ALIASES)) {
    const actualHeader = aliases.map(normalizeHeader).map(a => normalizedToActual.get(a)).find((v): v is string => !!v)
    if (actualHeader) fieldMap[logicalField as keyof typeof CTRI_EXPORT_FIELD_ALIASES] = actualHeader
    else unmapped.push(logicalField)
  }
  return { fieldMap, unmapped }
}

function readField(row: Record<string, string>, actualHeader: string | undefined): string {
  if (!actualHeader) return ''
  return (row[actualHeader] ?? '').trim()
}

/**
 * Parses CTRI's bulk export CSV. Pure, synchronous, no I/O — the fetch
 * itself lives in lib/matcher.ts, same separation used throughout this
 * codebase (see lib/rule-based-extraction.ts) so this can be unit-tested
 * with fixture text alone.
 */
export function parseCTRIBulkExport(csvText: string): CTRIBulkParseResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true })
  const headers = parsed.meta.fields || []
  const { fieldMap, unmapped } = buildFieldMap(headers)

  const trials: CTRIBulkTrial[] = []
  for (const row of parsed.data) {
    const ctriId = readField(row, fieldMap.ctriId)
    // CTRI's real ID format is CTRI/YYYY/MM/NNNNNN — requiring that shape
    // (not just a non-empty cell) is what actually distinguishes "this
    // row is a real trial record" from noise like a blank trailing row,
    // a totals/footer row, or a column genuinely mismapped to something
    // that isn't an ID at all.
    if (!/CTRI\/\d{4}\/\d{2}\/\d+/i.test(ctriId)) continue
    trials.push({
      ctriId: ctriId.match(/CTRI\/\d{4}\/\d{2}\/\d+/i)![0].toUpperCase(),
      title:             readField(row, fieldMap.title),
      condition:         readField(row, fieldMap.condition),
      phase:             readField(row, fieldMap.phase),
      sponsor:           readField(row, fieldMap.sponsor),
      recruitmentStatus: readField(row, fieldMap.recruitmentStatus),
      minAge:            readField(row, fieldMap.minAge),
      maxAge:            readField(row, fieldMap.maxAge),
      eligibilityText:   readField(row, fieldMap.eligibilityText),
      city:              readField(row, fieldMap.city),
      state:             readField(row, fieldMap.state),
    })
  }

  // "Valid" requires the two fields nothing else can substitute for
  // (an unidentifiable or untitled trial isn't usable regardless of what
  // else was mapped) AND at least one row that actually parsed as a real
  // trial — a file with the right headers but zero real ID-shaped rows
  // is just as untrustworthy as one with the wrong headers entirely.
  const looksValid = !unmapped.includes('ctriId') && !unmapped.includes('title') && trials.length > 0

  return { trials, totalRowsSeen: parsed.data.length, unmappedFields: unmapped, looksValid }
}

/** Case-insensitive substring match of the diagnosis against the fields most likely to mention it — this is a bulk export of every trial, so filtering to the patient's diagnosis happens here, not via a search query. */
export function filterCTRIBulkTrialsByDiagnosis(trials: CTRIBulkTrial[], diagnosis: string): CTRIBulkTrial[] {
  const needle = diagnosis.trim().toLowerCase()
  if (!needle) return []
  return trials.filter(t =>
    t.title.toLowerCase().includes(needle) || t.condition.toLowerCase().includes(needle)
  )
}
