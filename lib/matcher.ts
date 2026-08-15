import { createChatCompletion } from './llm-provider'
import {
  evaluateCriteria, summarizeDeterministicResults, CriterionArray,
  type Criterion, type EvaluableClinicalData, type EvaluatedCriterion,
} from './eligibility-rules'
import { extractCriteriaRuleBased } from './rule-based-extraction'
import { enrichMedicationsWithRxNorm } from './rxnorm'
import { hashEligibilityText, type TrialCriteriaCacheStore } from './trial-criteria-cache'
import { parseCTRIBulkExport, filterCTRIBulkTrialsByDiagnosis } from './ctri-bulk-export'

// Real Anthropic client construction moved to lib/llm-provider.ts, which
// also holds the temporary free-model testing shim — see that file's
// header comment for how to use it and why it's there.

export interface Patient {
  id?:              string
  patient_code:     string
  age:              number
  sex:              string
  location:         string
  diagnosis:        string
  stage?:           string
  medications?:     string
  labs?:            string
  comorbidities?:   string
  prior_treatments?: string
  biomarkers?:      string
  allergies?:       string
  ecog_status?:     string
  notes?:           string
}

// Structured clinical data for one patient — see migration 017 and
// lib/clinical-data.ts. Optional throughout this file: a patient entered
// only through the legacy free-text fields (pre-structured-intake) simply
// gets no deterministic evaluation, and every criterion falls back to
// Claude's own interpretation, exactly as it did before this feature
// existed. Structured data being available is what unlocks it, not a
// required precondition for matching to work at all.
export type ClinicalData = EvaluableClinicalData

// Only two real sources exist. Intentionally strict (not `string`) — if a
// third "source" value is ever reintroduced (e.g. an AI-fallback path),
// every place that constructs a TrialMatch will fail to compile until it's
// handled explicitly, instead of silently typechecking like a free-text
// value would. This mirrors the shared type in lib/types/domain.ts, which
// was already this strict — lib/matcher.ts previously kept its own looser
// local copy and drifted from it.
export type TrialSource = 'ClinicalTrials.gov' | 'CTRI'

export interface TrialMatch {
  rank:             number
  matchStrength:    'STRONG' | 'PARTIAL' | 'LOW'
  matchScore:       number
  source:           TrialSource
  nctId:            string
  title:            string
  phase:            string
  sponsor:          string
  indiaSites:       string
  status:           string
  plainSummary:     string
  criteriaMet:      string[]
  criteriaPartial:  string[]
  criteriaFail:     string[]
  nextSteps:        string
  /**
   * Criteria that were evaluated deterministically — in code, against the
   * patient's real structured clinical data — rather than judged by the
   * model. Each entry's `result` fed directly into criteriaMet/
   * criteriaFail/criteriaPartial above (a PASS/FAIL here is never left for
   * Claude to also weigh in on; see scoreWithClaude). Empty when the
   * patient has no structured clinical data yet, or when none of this
   * trial's criteria were extractable into a structured, checkable form.
   */
  deterministicResults: Array<{ description: string; category: string; result: 'PASS' | 'FAIL' | 'UNKNOWN'; evidence: string; extractionSource: 'rule_based' | 'ai_extracted' }>
}

/**
 * Per-source fetch outcome. 'error' means the live registry could not be
 * reached, timed out, or returned unparseable data — it does NOT mean zero
 * trials exist. Collapsing that distinction is what previously let the
 * system fall back to asking the model to invent fictional trials whenever
 * a fetch merely failed. That fallback has been removed entirely (see
 * scoreWithClaude below); this type exists so the UI can now show a
 * coordinator the honest difference between "nothing live found" and
 * "we couldn't check right now."
 */
export interface SourceStatus {
  ctgov:       'ok' | 'error'
  ctri:        'ok' | 'error'
  ctgovError?: string
  ctriError?:  string
}

export interface MatchResult {
  summary:        string
  trialsSearched: number
  ctgovCount:     number
  ctriCount:      number
  matches:        TrialMatch[]
  notMatched:     { title: string; reason: string; couldQualifyIf: string }[]
  sourceStatus:   SourceStatus
}

interface RawTrial {
  source:      TrialSource
  nctId:       string
  title:       string
  summary:     string
  eligibility: string
  phase:       string
  sponsor:     string
  sites:       string
  minAge:      string
  maxAge:      string
}

interface FetchOutcome {
  trials: RawTrial[]
  status: 'ok' | 'error'
  error?: string
}

// ── Retry helper for transient network failures ───────────────
// Both live registries are external, unauthenticated, and outside our
// control — a single dropped connection or transient 5xx shouldn't be
// treated the same as "the registry is actually down," which is what
// determines whether a coordinator sees a real result or an honest
// "couldn't check right now" message (see scoreWithClaude below). One
// retry with a short fixed backoff meaningfully reduces false "error"
// classifications from brief blips without adding much latency to the
// common case where the first attempt just works.
async function fetchWithRetry(url: string, init: RequestInit, retries = 1, backoffMs = 400): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init)
      // Only retry on server errors / rate limiting — a 4xx (other than 429)
      // means the request itself is wrong and won't succeed on retry.
      if (res.ok || (res.status < 500 && res.status !== 429) || attempt === retries) return res
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastErr = err
      if (attempt === retries) throw err
    }
    await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)))
  }
  throw lastErr
}

// ── Fetch from ClinicalTrials.gov ─────────────────────────────
async function fetchCTgov(diagnosis: string): Promise<FetchOutcome> {
  try {
    const term = encodeURIComponent(diagnosis)
    const url  = `https://clinicaltrials.gov/api/v2/studies?query.cond=${term}&filter.overallStatus=RECRUITING&filter.locn=India&pageSize=12&fields=NCTId,BriefTitle,BriefSummary,EligibilityCriteria,Phase,LeadSponsorName,LocationCity,LocationFacility,LocationCountry,Sex,MinimumAge,MaximumAge`
    const res  = await fetchWithRetry(url, { next: { revalidate: 3600 } }) // cache 1hr
    if (!res.ok) return { trials: [], status: 'error', error: `ClinicalTrials.gov returned HTTP ${res.status}` }
    const data = await res.json()
    const trials: RawTrial[] = (data.studies || []).map((s: any) => {
      const p    = s.protocolSection || {}
      const id   = p.identificationModule || {}
      const desc = p.descriptionModule || {}
      const elig = p.eligibilityModule || {}
      const design = p.designModule || {}
      const sp   = p.sponsorCollaboratorsModule || {}
      const locs = p.contactsLocationsModule || {}
      const sites = (locs.locations || [])
        .filter((l: any) => l.country === 'India')
        .map((l: any) => [l.facility, l.city].filter(Boolean).join(', '))
        .join('; ') || 'India'
      return {
        source:      'ClinicalTrials.gov' as const,
        nctId:       id.nctId || '',
        title:       id.briefTitle || '',
        summary:     (desc.briefSummary || '').slice(0, 500),
        eligibility: (elig.eligibilityCriteria || '').slice(0, 900),
        phase:       (design.phases || []).join('/') || 'NR',
        sponsor:     (sp.leadSponsor || {}).name || '',
        sites,
        minAge: elig.minimumAge || '',
        maxAge: elig.maximumAge || '',
      }
    }).filter((t: RawTrial) => t.nctId) // a trial we can't cite by ID is useless downstream
    return { trials, status: 'ok' }
  } catch (err) {
    return { trials: [], status: 'error', error: `ClinicalTrials.gov fetch failed: ${(err as Error).message}` }
  }
}

// ── Fetch from CTRI (India registry) ─────────────────────────
// No official CTRI search API exists, and (see fetchCTRISearchScrape's
// own comment below) the live search page is CAPTCHA-gated — a dead end
// for automated matching, not just fragile. This orchestrates two
// genuinely different strategies rather than committing to either one
// blind, because neither has been verifiable from this environment
// (ctri.nic.in isn't reachable from this sandbox at all):
//
//   1. fetchCTRIBulkExport — a bulk data-export endpoint
//      (scripts/seed-site-twins.ts already referenced this same URL for
//      a different purpose, never verified either). Export endpoints are
//      architecturally the kind of thing that typically ISN'T
//      CAPTCHA-gated the way an interactive search form is — they exist
//      specifically for bulk/programmatic consumption. If this works,
//      it's strictly better than scraping: no proxy dependency, no
//      regex-parsing HTML, the complete trial list rather than whatever
//      a search happened to surface.
//   2. fetchCTRISearchScrape — the original approach, kept as a fallback,
//      unchanged.
//
// Strategy 1 is trusted ONLY when it reports looksValid (see
// lib/ctri-bulk-export.ts) — a real structural check, not just "the HTTP
// request succeeded." Anything else falls through to strategy 2. Neither
// working is still possible; that's reported honestly (status:'error'
// with both attempts' details), not silently swallowed. Whichever
// strategy actually works once this runs against the real internet is
// something only a real deployment can settle — this makes that
// immediately observable via server logs rather than requiring another
// guess-and-ship cycle.
async function fetchCTRI(diagnosis: string): Promise<FetchOutcome> {
  const bulkResult = await fetchCTRIBulkExport(diagnosis)
  if (bulkResult.status === 'ok') return bulkResult

  console.warn(`[matcher] CTRI bulk export unusable for "${diagnosis}" (${bulkResult.error}) — falling back to search-scrape.`)
  const scrapeResult = await fetchCTRISearchScrape(diagnosis)
  if (scrapeResult.status === 'ok') return scrapeResult

  return {
    trials: [],
    status: 'error',
    error: `Both CTRI strategies failed. Bulk export: ${bulkResult.error}. Search scrape: ${scrapeResult.error}`,
  }
}

// Strategy 1 — bulk export. Direct fetch, no CORS proxy: this runs
// server-side (inside a Next.js API route / Node.js), and CORS is a
// browser-enforced mechanism that server-to-server fetches were never
// subject to in the first place — the proxy dependency in strategy 2
// predates this function and was never actually necessary for that
// reason either, but that one is left alone rather than changed
// speculatively (see fetchCTRISearchScrape's own comment).
async function fetchCTRIBulkExport(diagnosis: string): Promise<FetchOutcome> {
  try {
    const url = 'https://ctri.nic.in/ctri/Utils/exportData.php?Id=all&stype=full'
    const res = await fetchWithRetry(url, {
      headers: { 'User-Agent': 'TrialMatchIndia/2.0 (research; contact@trialmatch.in)' },
      signal:  AbortSignal.timeout(20_000),
      next:    { revalidate: 3600 },
    })
    if (!res.ok) return { trials: [], status: 'error', error: `CTRI bulk export returned HTTP ${res.status}` }
    const csvText = await res.text()
    if (!csvText) return { trials: [], status: 'error', error: 'CTRI bulk export returned empty content' }

    const parsed = parseCTRIBulkExport(csvText)
    if (!parsed.looksValid) {
      return {
        trials: [], status: 'error',
        error: `CTRI bulk export response did not match the expected structure (unmapped fields: ${parsed.unmappedFields.join(', ') || 'none — headers matched but no row had a real CTRI ID'}; ${parsed.totalRowsSeen} rows seen)`,
      }
    }

    const matched = filterCTRIBulkTrialsByDiagnosis(parsed.trials, diagnosis).slice(0, 6)
    const trials: RawTrial[] = matched.map(t => ({
      source:      'CTRI',
      nctId:       t.ctriId,
      title:       t.title || `CTRI trial for ${diagnosis}`,
      summary:     t.condition ? `Indian clinical trial registered on CTRI for ${t.condition}.` : `Indian clinical trial registered on CTRI for ${diagnosis}.`,
      eligibility: t.eligibilityText || `Registered trial for ${diagnosis} in India. Full eligibility criteria available at ctri.nic.in.`,
      phase:       t.phase || 'See CTRI',
      sponsor:     t.sponsor || 'Indian Institution',
      sites:       [t.city, t.state].filter(Boolean).join(', ') || 'India',
      minAge:      t.minAge, maxAge: t.maxAge,
    }))
    return { trials, status: 'ok' }
  } catch (err) {
    return { trials: [], status: 'error', error: `CTRI bulk export fetch failed: ${(err as Error).message}` }
  }
}

// Strategy 2 — the original search-page scrape.
async function fetchCTRISearchScrape(diagnosis: string): Promise<FetchOutcome> {
  try {
    const q    = encodeURIComponent(diagnosis)
    const url  = `https://ctri.nic.in/Clinicaltrials.php?type=1&EncHid=&userName=${q}&title=&phase=0&status=3&searchtype=normal&Search=Search`
    const proxy = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`
    const res   = await fetchWithRetry(proxy, { signal: AbortSignal.timeout(8000), next: { revalidate: 3600 } })
    if (!res.ok) return { trials: [], status: 'error', error: `CTRI proxy returned HTTP ${res.status}` }
    const data  = await res.json()
    const html  = data.contents || ''
    if (!html) return { trials: [], status: 'error', error: 'CTRI proxy returned empty content' }

    // A GET request can never supply a CAPTCHA solution, so a challenge
    // page here is a fetch failure in substance even though the HTTP
    // request itself succeeded — this must NOT be allowed to fall through
    // to the row-parsing below, which would just find zero rows and look
    // identical to "no trials for this diagnosis."
    if (/security\s*code|captcha/i.test(html)) {
      return { trials: [], status: 'error', error: 'CTRI returned a CAPTCHA/security-code challenge instead of search results — this endpoint likely needs re-verification against the live site, see this function\'s header comment' }
    }

    const trials: RawTrial[] = []
    const rows  = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []
    let count   = 0
    for (const row of rows) {
      if (count >= 6) break
      const idMatch    = row.match(/CTRI\/\d{4}\/\d{2}\/\d+/)
      const titleMatch = row.match(/<td[^>]*>([^<]{20,200})<\/td>/)
      if (!idMatch || !titleMatch) continue
      trials.push({
        source:      'CTRI',
        nctId:       idMatch[0],
        title:       titleMatch[1].replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim(),
        summary:     `Indian clinical trial registered on CTRI for ${diagnosis}.`,
        eligibility: `Registered trial for ${diagnosis} in India. Full eligibility criteria available at ctri.nic.in.`,
        phase:       'See CTRI',
        sponsor:     'Indian Institution',
        sites:       'India',
        minAge: '', maxAge: '',
      })
      count++
    }
    // A successful HTTP fetch that parses zero rows from non-trivial HTML is
    // a real signal worth distinguishing from "no trials exist" — it's the
    // leading indicator that CTRI changed its page markup and the regex
    // parsing above silently stopped working, since this scrapes an
    // unofficial HTML page rather than a stable API. This still returns
    // status:'ok' (the fetch itself succeeded, so scoreWithClaude's honest
    // "no results found" messaging is the right user-facing behaviour) —
    // this log line is for server-side monitoring, not the coordinator.
    if (trials.length === 0 && html.length > 500) {
      console.warn(`[matcher] fetchCTRI parsed 0 trials from a ${html.length}-byte non-empty response for "${diagnosis}" — possible CTRI markup change breaking the scraper. Investigate if this repeats across different diagnoses.`)
    }
    return { trials, status: 'ok' }
  } catch (err) {
    return { trials: [], status: 'error', error: `CTRI fetch failed: ${(err as Error).message}` }
  }
}

// Two criteria are treated as the same real-world criterion if they share
// a category and the field that actually identifies what's being checked
// (test_name for a lab, medication_name for a medication, etc.),
// case-insensitively. Module-level (not nested in scoreWithClaude) because
// both Call 1's extraction-dedup and Call 2's reconciliation used to need
// it — now only Call 1 does, but kept here rather than re-nested, since a
// shared definition of "same criterion" shouldn't silently drift into two
// slightly different copies if this is ever needed elsewhere again.
function criterionKey(c: Criterion): string {
  const identifier = c.test_name ?? c.medication_name ?? c.medication_class ?? c.marker ?? c.condition ?? c.allergy_substance ?? ''
  return `${c.category}::${identifier.toLowerCase().trim()}`
}

// ── Call 1 — trial-only criteria extraction ───────────────────
// No Patient parameter anywhere in this signature — not a convention, a
// structural guarantee: it is not possible for patient data to reach this
// prompt, because there is no patient data in scope to put there. This is
// the actual fix for the privacy gap this project's own Tier 1 disclosure
// named: "the patient block and the residual trial text are still in the
// same call... splitting those into two calls... was proposed a few turns
// back and never built." Only ever called for trials that are a genuine
// cache miss with real residual text — see scoreWithClaude's call site.
async function extractResidualCriteriaViaClaude(
  trialsNeedingExtraction: RawTrial[],
  extractionByTrial: Map<string, { unparsedStatements: string[]; knownCriteria: Criterion[] }>
): Promise<Map<string, Criterion[]>> {
  const trialsBlock = trialsNeedingExtraction.map((t, i) => {
    const ctx = extractionByTrial.get(t.nctId)!
    const alreadyExtracted = ctx.knownCriteria.length
      ? ctx.knownCriteria.map(c => `  - ${c.description}`).join('\n')
      : '  (none — nothing in this trial\'s text matched a known pattern)'
    const residual = ctx.unparsedStatements.map(s => `  - ${s}`).join('\n')
    return `TRIAL ${i + 1} [${t.source}] ${t.nctId}\n${t.title}\n\nCriteria already extracted deterministically for this trial — do NOT re-extract or duplicate these, they are final:\n${alreadyExtracted}\n\nRemaining eligibility statements not yet structured (extract from ONLY these, if objectively checkable; otherwise this statement needs clinical judgment and should simply be omitted — a separate step handles judgment-based criteria per-patient, not this one):\n${residual}`
  }).join('\n\n---\n\n')

  const prompt = `You are a clinical trial eligibility-criteria extraction expert. Return ONLY valid JSON, no markdown fences.

${trialsNeedingExtraction.length} trial(s) with unstructured eligibility text to extract from:

${trialsBlock}

Return this exact JSON structure:
{
  "trials": [
    {
      "nctId": "must exactly match one of the trial IDs above, character for character",
      "structuredCriteria": [
        {
          "id": "c1",
          "description": "human-readable form of the criterion, e.g. 'HbA1c between 8.0-11.0%'",
          "category": "age"|"sex"|"lab"|"medication"|"medication_class"|"biomarker"|"comorbidity"|"allergy",
          "is_exclusion": false,
          "test_name": "for category=lab: the lab/measurement name, e.g. 'HbA1c', 'eGFR', 'BMI', 'Systolic BP'",
          "operator": "for category=lab: gte|lte|gt|lt|eq|between",
          "value": "for category=lab with a single threshold",
          "value_low": "for category=lab with operator=between",
          "value_high": "for category=lab with operator=between",
          "medication_name": "for category=medication",
          "required_status": "for category=medication: active|discontinued",
          "min_duration_days": "for category=medication: minimum days on the medication, if the criterion specifies a duration",
          "medication_class": "for category=medication_class: one of potassium_sparing_diuretic, loop_diuretic, nsaid, anticoagulant, statin, ace_inhibitor, oral_corticosteroid, immunosuppressant — do not invent others",
          "marker": "for category=biomarker",
          "required_biomarker_status": "for category=biomarker: positive|negative",
          "condition": "for category=comorbidity",
          "allergy_substance": "for category=allergy",
          "min_age": "for category=age",
          "max_age": "for category=age",
          "required_sex": "for category=sex: Male|Female|Any"
        }
      ]
    }
  ]
}

CRITICAL — YOU ONLY EXTRACT FROM "Remaining eligibility statements," NOTHING ELSE, for each trial: the
"already extracted" list is final — never invent a structuredCriteria entry for anything in it. Only extract
a remaining statement if it reduces to a real, objective comparison (an age range, a lab value against a
threshold, whether a specific medication or medication class is/isn't in use, a specific biomarker result, a
specific diagnosed condition, a specific allergy) that the deterministic pass simply didn't recognize the
phrasing for — your job is only to correctly identify what it requires, never to decide whether any patient
meets it (nothing about any patient is available to you here). If a remaining statement genuinely requires
clinical or textual judgment that cannot be reduced to a threshold/status comparison (e.g. "histologically
confirmed", "life expectancy > 6 months per investigator"), omit it entirely — do not force it into
structuredCriteria; a separate per-patient step handles judgment calls like that.

If a trial's "Remaining eligibility statements" contains nothing objectively extractable, return an empty
structuredCriteria array for it — do not omit the trial from the response entirely.`

  const response = await createChatCompletion({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 3000,
    messages:   [{ role: 'user', content: prompt }],
  })

  const raw   = response.content.map(c => (c as any).text || '').join('')
  const clean = raw.replace(/```json|```/g, '').trim()

  let result: any
  try {
    result = JSON.parse(clean)
  } catch (err) {
    // Extraction failing must not fail the whole match — a trial simply
    // falls back to whatever the rule-based pass alone found for it
    // (already in extractionByTrial's knownCriteria before this function
    // was ever called), same as if it had no residual text at all.
    console.warn(`[matcher] Extraction response could not be parsed as JSON — falling back to rule-based-only criteria for the ${trialsNeedingExtraction.length} trial(s) in this call: ${(err as Error).message}`)
    return new Map()
  }

  const out = new Map<string, Criterion[]>()
  if (!Array.isArray(result.trials)) return out

  // Claude may echo nctId back with different case/whitespace than the
  // canonical trial object has — match normalized, but key the output map
  // by the ORIGINAL canonical id, since that's what the caller looks up
  // with (extracted.get(t.nctId) in scoreWithClaude). Same normalization
  // this file already relies on elsewhere for exactly this reason.
  const canonicalByNormalizedId = new Map(trialsNeedingExtraction.map(t => [t.nctId.trim().toUpperCase(), t.nctId]))

  for (const t of result.trials) {
    const echoedId = String(t?.nctId || '').trim()
    if (!echoedId) continue
    const canonicalId = canonicalByNormalizedId.get(echoedId.toUpperCase())
    if (!canonicalId) {
      console.warn(`[matcher] Extraction response referenced nctId "${echoedId}" which doesn't match any trial this call was actually asked about — ignored.`)
      continue
    }
    const rawCriteria: any[] = Array.isArray(t.structuredCriteria) ? t.structuredCriteria : []
    const parsed: Criterion[] = []
    for (const raw of rawCriteria) {
      const p = CriterionArray.element.safeParse(raw)
      if (p.success) parsed.push(p.data)
    }
    if (parsed.length < rawCriteria.length) {
      console.warn(`[matcher] Dropped ${rawCriteria.length - parsed.length} malformed structuredCriteria entr(y/ies) for ${canonicalId} — not evaluable, treated as absent.`)
    }
    out.set(canonicalId, parsed)
  }
  return out
}

// ── Claude AI matching ────────────────────────────────────────
async function scoreWithClaude(patient: Patient, trials: RawTrial[], sourceStatus: SourceStatus, clinicalData: ClinicalData | null, cacheStore?: TrialCriteriaCacheStore): Promise<MatchResult> {
  const ctgovCount = trials.filter(t => t.source === 'ClinicalTrials.gov').length
  const ctriCount  = trials.filter(t => t.source === 'CTRI').length

  // ── No live trial data retrieved ────────────────────────────
  // Previously this branch asked Claude to "generate 4 realistic, medically
  // accurate example trials" and tag them "AI-Synthesised" whenever both
  // fetches came back empty. That tag was never checked anywhere in the UI
  // (BatchPanel, MatchExplainability render every match identically
  // regardless of source), so a coordinator could receive a fabricated
  // trial — fake NCT ID, fake sponsor, fake eligibility criteria — with a
  // "STRONG MATCH" badge and no way to tell it wasn't real. We return an
  // honest empty result instead. It's a worse demo and a better product.
  if (trials.length === 0) {
    const bothFailed = sourceStatus.ctgov === 'error' && sourceStatus.ctri === 'error'
    const bothOk      = sourceStatus.ctgov === 'ok' && sourceStatus.ctri === 'ok'
    const summary = bothFailed
      ? `We could not reach ClinicalTrials.gov or CTRI just now, so no trial data could be retrieved for this patient. This is a temporary connectivity issue, not a match result — please re-run the match in a few minutes rather than treating this as "no trials found."`
      : bothOk
      ? `No actively recruiting trials matching "${patient.diagnosis}" were found on ClinicalTrials.gov or CTRI (India) at this time. This reflects a live search that returned zero results, not a system error — try again periodically as new trials open, or broaden the diagnosis term.`
      : `${sourceStatus.ctgov === 'ok' ? 'ClinicalTrials.gov' : 'CTRI'} returned no actively recruiting trials matching "${patient.diagnosis}" at this time. ${sourceStatus.ctgov === 'error' ? 'ClinicalTrials.gov' : 'CTRI'} could not be reached during this search, so results are incomplete — please re-run the match shortly to also check that source.`

    return {
      summary,
      trialsSearched: 0,
      ctgovCount: 0,
      ctriCount: 0,
      matches: [],
      notMatched: [],
      sourceStatus,
    }
  }

  // ── Trial criteria extraction — cache-aware ───────────────────────────
  // This is the actual point of this file's design, extended: the
  // rule-based pass (regex/dictionary/negation, zero LLM — see
  // lib/rule-based-extraction.ts) still gets first crack at every trial's
  // eligibility text, exactly as before. New: before even doing that, each
  // trial is checked against the cache (source + trial ID + a content
  // hash of its exact eligibility text — see lib/trial-criteria-cache.ts).
  // A hit means this exact protocol text has already been fully extracted
  // — rule-based AND whatever Claude previously extracted from the
  // residual — and there is nothing left to (re-)extract, only this
  // patient's own evaluation and interpretation to do. A miss (never
  // seen before, or the trial's eligibility text has changed since it was
  // last cached) falls back to the rule-based pass exactly as before.
  interface TrialExtractionContext {
    /** Authoritative criteria for this trial — never re-extracted, never duplicated. Starts as the cached set (hit) or the rule-based-only set (miss); a miss gets topped up with Call 1's output below, before Call 2 ever runs. */
    knownCriteria:       Criterion[]
    cacheHit:            boolean
    eligibilityTextHash: string
    /** Only meaningful on a miss — what the rule-based pass couldn't classify, i.e. what Call 1 extracts from. */
    unparsedStatements:  string[]
  }
  const extractionByTrial = new Map<string, TrialExtractionContext>()
  await Promise.all(trials.map(async (t) => {
    const eligibilityTextHash = hashEligibilityText(t.eligibility)
    const cached = cacheStore
      ? await cacheStore.get(t.source, t.nctId, eligibilityTextHash).catch(err => {
          console.warn(`[matcher] Cache read threw for ${t.nctId} — treating as a miss: ${(err as Error).message}`)
          return null
        })
      : null
    if (cached) {
      extractionByTrial.set(t.nctId, { knownCriteria: cached.criteria, cacheHit: true, eligibilityTextHash, unparsedStatements: [] })
    } else {
      const rb = extractCriteriaRuleBased(`${t.eligibility}`)
      extractionByTrial.set(t.nctId, { knownCriteria: rb.criteria, cacheHit: false, eligibilityTextHash, unparsedStatements: rb.unparsedStatements })
    }
  }))

  // ── Call 1 — trial-only criteria extraction, patient data never present ──
  // Genuinely two separate Claude calls now, not one combined prompt. Only
  // trials that are a cache miss AND still have residual text after the
  // rule-based pass need this at all — a trial with everything already
  // known (from cache, or because the rule-based pass alone covered all of
  // it) skips this entirely. Whatever this call extracts is cached
  // immediately below, so a given trial's real-world need for this call
  // shrinks to "the first time any patient anywhere is matched against
  // it" — extract once, reuse forever, same as the cache's own rationale.
  const cacheWrites: Promise<void>[] = []
  const trialsNeedingExtraction = trials.filter(t => {
    const ctx = extractionByTrial.get(t.nctId)!
    return !ctx.cacheHit && ctx.unparsedStatements.length > 0
  })
  if (trialsNeedingExtraction.length > 0) {
    const extracted = await extractResidualCriteriaViaClaude(trialsNeedingExtraction, extractionByTrial)
    for (const t of trialsNeedingExtraction) {
      const ctx = extractionByTrial.get(t.nctId)!
      const newlyExtracted = extracted.get(t.nctId) ?? []
      // Same dedup reasoning as before, just running one step earlier now
      // that extraction is its own call instead of interleaved with
      // scoring: Call 1 should only ever add NEW criteria beyond what the
      // rule-based pass already found for THIS trial, but "should" is an
      // instruction, not a guarantee.
      const knownKeys = new Set(ctx.knownCriteria.map(criterionKey))
      const deduped = newlyExtracted.filter(c => {
        const isDuplicate = knownKeys.has(criterionKey(c))
        if (isDuplicate) console.warn(`[matcher] Dropped AI-extracted criterion for ${t.nctId} that duplicates an already rule-extracted one: ${c.description}`)
        return !isDuplicate
      })
      ctx.knownCriteria = [...ctx.knownCriteria, ...deduped]

      if (cacheStore) {
        cacheWrites.push(
          cacheStore.set(t.source, t.nctId, ctx.eligibilityTextHash, ctx.knownCriteria)
            .catch(err => console.warn(`[matcher] Cache write threw for ${t.nctId} — ignored, this match is unaffected: ${(err as Error).message}`))
        )
      }
    }
  }

  // ── Call 2 — patient scoring + interpretation, nothing left to extract ──
  // Every trial's criteria are fully known by this point — from cache, or
  // from Call 1 moments ago — so every trial gets the same framing: final,
  // do not extract, do not duplicate. There is no more "residual text,
  // please extract from this" branch here at all; that instruction now
  // lives entirely in Call 1's own prompt, which never sees a patient.
  const trialsContext = `${trials.length} live trial(s) retrieved:\n\n` +
    trials.map((t, i) => {
      const ctx = extractionByTrial.get(t.nctId)!
      const header = `TRIAL ${i + 1} [${t.source}] ${t.nctId}\n${t.title}\nPhase:${t.phase} | Sponsor:${t.sponsor} | Sites:${t.sites}\nAge:${t.minAge||'NR'}-${t.maxAge||'NR'}\nSummary:${t.summary}`
      const known = ctx.knownCriteria.length
        ? ctx.knownCriteria.map(c => `  - ${c.description}`).join('\n')
        : '  (none — this trial has no checkable criteria beyond age/sex/basic diagnosis)'
      return `${header}\n\nEvery checkable criterion for this trial is already known — FINAL, do not extract anything new, do not duplicate any of these:\n${known}\n\nFull eligibility text, for context only — use ONLY to decide whether anything here needs your own clinical/textual judgment (interpretedCriteriaMet/Partial/Fail) beyond what's already listed above; do NOT add a structuredCriteria entry for this trial, everything checkable is already covered:\n${t.eligibility}`
    }).join('\n\n---\n\n')

  const prompt = `You are a clinical trial matching expert AI for India. Return ONLY valid JSON, no markdown fences.

PATIENT:
Code:${patient.patient_code} Age:${patient.age}y Sex:${patient.sex} Location:${patient.location}
Diagnosis:${patient.diagnosis} Stage:${patient.stage||'NR'}
Medications:${patient.medications||'None'} Labs:${patient.labs||'NR'}
Comorbidities:${patient.comorbidities||'None'} Prior Tx:${patient.prior_treatments||'None'}
Biomarkers:${patient.biomarkers||'None'} Allergies:${patient.allergies||'None'}
ECOG:${patient.ecog_status||'Unknown'} Notes:${patient.notes||'None'}

${trialsContext}

Return this exact JSON structure:
{
  "summary": "2-3 sentence overview",
  "matches": [
    {
      "rank": 1,
      "matchStrength": "STRONG"|"PARTIAL"|"LOW",
      "matchScore": 0-100,
      "source": "ClinicalTrials.gov"|"CTRI",
      "nctId": "",
      "title": "",
      "phase": "",
      "sponsor": "",
      "indiaSites": "",
      "status": "Actively Recruiting",
      "plainSummary": "2 sentences referencing patient's specific values",
      "interpretedCriteriaMet": ["criteria that need clinical/textual judgment (not objectively checkable against a lab value or medication list) that this patient satisfies — e.g. 'histologically confirmed adenocarcinoma per pathology report'"],
      "interpretedCriteriaPartial": ["interpreted criteria needing verification — state what to check"],
      "interpretedCriteriaFail": ["interpreted criteria this patient does not satisfy, with reason"],
      "nextSteps": "1. Action\n2. Action\n3. Action"
    }
  ],
  "notMatched": [
    {"title": "", "reason": "", "couldQualifyIf": ""}
  ]
}

Max 4 matches. Be medically precise.

CRITICAL — DO NOT EXTRACT: every checkable criterion for every trial above is already final. Your job
here is ONLY to score this patient against them and, for anything that genuinely requires clinical or
textual judgment beyond what's already listed (e.g. "histologically confirmed", "life expectancy > 6
months per investigator", a nested conditional like "unless receiving maintenance therapy"), give your
own interpretedCriteriaMet/Partial/Fail judgment. Do not return a "structuredCriteria" field at all —
there is nothing left to extract; a separate step already did that for every trial listed above.

CRITICAL — DO NOT FABRICATE: Only return trials from the numbered list above. Every "nctId" you
return MUST exactly match one of the trial IDs listed above, character for character. Never invent,
extrapolate, or create an illustrative/example trial that is not in the list above — not even a
"typical" or "plausible" one — regardless of how few trials were retrieved or how weak the matches
are. If none of the listed trials are worth including, return a shorter "matches" array, or an empty
one. A short honest answer is correct; a fabricated trial is not, under any circumstance.

CRITICAL SCORING RULE: matchStrength must be "STRONG" ONLY if every interpreted criterion you
evaluate is in interpretedCriteriaMet (no PARTIAL or FAIL items) AND you are not aware of any
structured criterion likely to fail. The deterministic system will downgrade matchStrength to "LOW"
automatically if any structuredCriteria entry turns out to fail against the patient's real record,
regardless of what you set here — treat this field as your best estimate from the interpreted
criteria only, not a final answer.`

  const response = await createChatCompletion({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages:   [{ role: 'user', content: prompt }],
  })

  const raw   = response.content.map(c => (c as any).text || '').join('')
  const clean = raw.replace(/```json|```/g, '').trim()

  let result: any
  try {
    result = JSON.parse(clean)
  } catch (err) {
    throw new Error(
      `AI response could not be parsed as valid JSON. This usually means the response was truncated ` +
      `or malformed. Please try matching this patient again. (Parse error: ${(err as Error).message})`
    )
  }

  // Validate the shape we actually need — fail clearly rather than silently
  // passing through a result the UI can't render.
  if (!Array.isArray(result.matches)) {
    throw new Error('AI response was missing the expected "matches" array. Please try again.')
  }

  // ── Defense in depth against fabrication ────────────────────
  // The prompt instructs the model not to invent trials, but a prompt
  // instruction is a request, not a guarantee — models can still err.
  // Rather than trust it alone, structurally drop any returned match whose
  // nctId doesn't correspond to a trial we actually retrieved. This makes
  // fabrication unable to reach the UI, not just discouraged from it.
  const knownIds = new Set(trials.map(t => t.nctId.trim().toUpperCase()))
  const rawMatches: any[] = result.matches
  const survivingRawMatches = rawMatches.filter(m => {
    const id = String(m?.nctId || '').trim().toUpperCase()
    return id.length > 0 && knownIds.has(id)
  })

  const droppedCount = rawMatches.length - survivingRawMatches.length
  let summary = String(result.summary || '')
  if (droppedCount > 0) {
    // Should not normally trigger given the prompt instruction above — if it
    // does, it's logged so it's visible in server logs, and the coordinator
    // is told honestly rather than silently shown a shorter list.
    console.error(
      `[matcher] Dropped ${droppedCount} match(es) for patient ${patient.patient_code} whose ` +
      `nctId did not match any retrieved trial — possible model fabrication, filtered before reaching the UI.`
    )
    summary = `${summary} (${droppedCount} suggested match${droppedCount !== 1 ? 'es' : ''} could not be verified against retrieved trial data and ${droppedCount !== 1 ? 'were' : 'was'} excluded from this report.)`.trim()
  }

  const trialsByNormalizedId = new Map(trials.map(t => [t.nctId.trim().toUpperCase(), t]))

  // ── Deterministic reconciliation ────────────────────────────
  // This is the actual point of this whole file's redesign: for every
  // criterion this trial has (all of it known before Call 2 ever ran — see
  // above), we do not use the model's own opinion of whether the patient
  // satisfies it (it never gave one — see the prompt above) — we compute
  // PASS/FAIL/UNKNOWN ourselves, in code, against the patient's real
  // on-file clinical records, and that result is what reaches
  // criteriaMet/criteriaFail/criteriaPartial. Only genuinely non-structured
  // criteria (the model's interpretedCriteria* buckets) carry the model's
  // own judgment through. Simpler than it used to be: since Call 2 is
  // never asked to (and no longer even has schema for) returning
  // structuredCriteria, there's no merging/deduping of anything from this
  // response left to do here — knownCriteria (finalized before Call 2 ran)
  // is directly authoritative.
  const filteredMatches: TrialMatch[] = survivingRawMatches.map((m: any): TrialMatch => {
    const originalTrial = trialsByNormalizedId.get(String(m.nctId || '').trim().toUpperCase())
    const ctx = originalTrial ? extractionByTrial.get(originalTrial.nctId) : undefined
    const allCriteria: Criterion[] = ctx?.knownCriteria ?? []

    const evaluated: EvaluatedCriterion[] = clinicalData
      ? evaluateCriteria(allCriteria, { age: patient.age, sex: patient.sex }, clinicalData)
      : allCriteria.map(c => ({ criterion: c, result: 'UNKNOWN' as const, evidence: 'No structured clinical data on file for this patient yet.' }))

    const detSummary = summarizeDeterministicResults(evaluated)

    const verifiedMet     = evaluated.filter(e => e.result === 'PASS').map(e => `✓ Verified — ${e.criterion.description}: ${e.evidence}`)
    const verifiedFail    = evaluated.filter(e => e.result === 'FAIL').map(e => `✓ Verified — ${e.criterion.description}: ${e.evidence}`)
    const verifiedPartial = evaluated.filter(e => e.result === 'UNKNOWN').map(e => `${e.criterion.description} — ${e.evidence}`)

    const criteriaMet     = [...verifiedMet,     ...(Array.isArray(m.interpretedCriteriaMet)     ? m.interpretedCriteriaMet     : [])]
    const criteriaFail    = [...verifiedFail,    ...(Array.isArray(m.interpretedCriteriaFail)    ? m.interpretedCriteriaFail    : [])]
    const criteriaPartial = [...verifiedPartial, ...(Array.isArray(m.interpretedCriteriaPartial) ? m.interpretedCriteriaPartial : [])]

    // A confirmed deterministic failure downgrades matchStrength — this
    // can only ever push a rating DOWN, never up. The rule engine only
    // covers whatever subset of a trial's criteria the model successfully
    // extracted as structured; treating full deterministic PASS as proof
    // of a STRONG match would be trusting a partial view of the protocol
    // as if it were the whole thing.
    let matchStrength: TrialMatch['matchStrength'] = m.matchStrength === 'STRONG' || m.matchStrength === 'PARTIAL' || m.matchStrength === 'LOW' ? m.matchStrength : 'PARTIAL'
    if (detSummary.hasFail) matchStrength = 'LOW'

    return {
      rank:         Number(m.rank) || 0,
      matchStrength,
      matchScore:   Number(m.matchScore) || 0,
      source:       m.source === 'CTRI' ? 'CTRI' : 'ClinicalTrials.gov',
      nctId:        String(m.nctId || ''),
      title:        String(m.title || ''),
      phase:        String(m.phase || ''),
      sponsor:      String(m.sponsor || ''),
      indiaSites:   String(m.indiaSites || ''),
      status:       String(m.status || ''),
      plainSummary: String(m.plainSummary || ''),
      criteriaMet, criteriaPartial, criteriaFail,
      nextSteps:    String(m.nextSteps || ''),
      deterministicResults: evaluated.map(e => ({
        description: e.criterion.description, category: e.criterion.category, result: e.result, evidence: e.evidence,
        // "rule-" prefixed IDs are always rule-based (see
        // lib/rule-based-extraction.ts) — true whether this criterion
        // came from a fresh rule-based pass (miss) or was recovered from
        // the cache (hit); the prefix survives the JSON round trip either
        // way, so no separate bookkeeping is needed to preserve it.
        extractionSource: e.criterion.id.startsWith('rule-') ? 'rule_based' as const : 'ai_extracted' as const,
      })),
    }
  })

  // Every genuine-miss trial's final merged criteria get written back
  // here — awaited so the write reliably completes before this function
  // (and the request that called it) finishes, not fire-and-forgotten
  // into a serverless environment that might freeze the process right
  // after responding. A write failure here is already handled inside
  // lib/trial-criteria-cache.ts (logged, never thrown) — it cannot fail
  // this match, only the caching optimization for next time.
  await Promise.all(cacheWrites)

  return {
    summary,
    trialsSearched: trials.length,
    ctgovCount,
    ctriCount,
    matches: filteredMatches,
    notMatched: Array.isArray(result.notMatched) ? result.notMatched : [],
    sourceStatus,
  }
}

// ── RxNorm medication enrichment ──────────────────────────────
// First real caller of lib/rxnorm.ts — previously built, unit-tested, and
// never invoked from anywhere. Runs once per match (not per criterion,
// not per trial), concurrently with the CTgov/CTRI fetches below, so it
// adds no serial latency in the common case. Skipped entirely when there
// are no medications to enrich, so a patient with no medications on file
// never pays for a call that couldn't do anything anyway.
async function enrichClinicalData(clinicalData: ClinicalData | null): Promise<ClinicalData | null> {
  if (!clinicalData || clinicalData.medications.length === 0) return clinicalData
  const enrichedMeds = await enrichMedicationsWithRxNorm(clinicalData.medications)
  return { ...clinicalData, medications: enrichedMeds }
}

// ── Main export ───────────────────────────────────────────────
export async function matchPatient(
  patient: Patient,
  clinicalData: ClinicalData | null = null,
  cacheStore?: TrialCriteriaCacheStore
): Promise<MatchResult> {
  const [ctOutcome, ctriOutcome, enrichedClinicalData] = await Promise.all([
    fetchCTgov(patient.diagnosis),
    fetchCTRI(patient.diagnosis),
    enrichClinicalData(clinicalData),
  ])

  const sourceStatus: SourceStatus = {
    ctgov: ctOutcome.status,
    ctri:  ctriOutcome.status,
    ...(ctOutcome.error   ? { ctgovError: ctOutcome.error }   : {}),
    ...(ctriOutcome.error ? { ctriError:  ctriOutcome.error } : {}),
  }

  const allTrials = [...ctOutcome.trials, ...ctriOutcome.trials]
  const result = await scoreWithClaude(patient, allTrials, sourceStatus, enrichedClinicalData, cacheStore)

  // If exactly one source failed but the other returned usable trials, the
  // result is real but incomplete. Prepend a deterministic, code-authored
  // disclosure — not one the model is asked to remember to write — so a
  // coordinator always sees this regardless of what's in result.summary.
  if (allTrials.length > 0) {
    if (sourceStatus.ctgov === 'error' && sourceStatus.ctri === 'ok') {
      result.summary = `Note: ClinicalTrials.gov could not be reached during this search — results below are from CTRI (India) only. ${result.summary}`
    } else if (sourceStatus.ctri === 'error' && sourceStatus.ctgov === 'ok') {
      result.summary = `Note: CTRI (India registry) could not be reached during this search — results below are from ClinicalTrials.gov only. ${result.summary}`
    }
  }

  return result
}
