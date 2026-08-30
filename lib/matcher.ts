import { createChatCompletion, resolveLLMConfig, type LLMProviderConfig } from './llm-provider'
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

/**
 * Extracts and parses a JSON object from raw LLM output. Handles the
 * common case where a reasoning model (e.g. NVIDIA Nemotron) prepends
 * its chain-of-thought reasoning as plain prose before the actual JSON
 * answer, rather than confining it to a separate reasoning channel or
 * respecting the ```json fence the prompt requests. Tries a direct
 * parse first (the fast, common case for non-reasoning models), and
 * only attempts the more careful brace-matching extraction below if
 * that fails.
 */
function extractJSON(raw: string): any {
  const stripped = raw.replace(/```json|```/g, '').trim()

  try {
    return JSON.parse(stripped)
  } catch { /* fall through to the more forgiving extraction below */ }

  const start = stripped.indexOf('{')
  if (start === -1) throw new Error('No JSON object found in response')

  let depth = 0, inString = false, escapeNext = false
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i]
    if (escapeNext)      { escapeNext = false; continue }
    if (ch === '\\')     { escapeNext = true; continue }
    if (ch === '"')      { inString = !inString; continue }
    if (inString)        continue
    if (ch === '{')      depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return JSON.parse(stripped.slice(start, i + 1))
    }
  }
  throw new Error('Unbalanced JSON object in response — no matching closing brace found')
}

export interface Patient {
  id?:              string
  org_id?:          string
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

export type ClinicalData = EvaluableClinicalData

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
  deterministicResults: Array<{ description: string; category: string; result: 'PASS' | 'FAIL' | 'UNKNOWN'; evidence: string; extractionSource: 'rule_based' | 'ai_extracted' }>
}

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

async function fetchWithRetry(url: string, init: RequestInit, retries = 1, backoffMs = 400): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init)
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

async function fetchCTgov(diagnosis: string): Promise<FetchOutcome> {
  try {
    const term = encodeURIComponent(diagnosis)
    const url  = `https://clinicaltrials.gov/api/v2/studies?query.cond=${term}&filter.overallStatus=RECRUITING&query.locn=India&pageSize=12&fields=NCTId,BriefTitle,BriefSummary,EligibilityCriteria,Phase,LeadSponsorName,LocationCity,LocationFacility,LocationCountry,Sex,MinimumAge,MaximumAge`
    const res  = await fetchWithRetry(url, { next: { revalidate: 3600 } })
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
    }).filter((t: RawTrial) => t.nctId)
    return { trials, status: 'ok' }
  } catch (err) {
    return { trials: [], status: 'error', error: `ClinicalTrials.gov fetch failed: ${(err as Error).message}` }
  }
}

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
    if (trials.length === 0 && html.length > 500) {
      console.warn(`[matcher] fetchCTRI parsed 0 trials from a ${html.length}-byte non-empty response for "${diagnosis}" — possible CTRI markup change breaking the scraper. Investigate if this repeats across different diagnoses.`)
    }
    return { trials, status: 'ok' }
  } catch (err) {
    return { trials: [], status: 'error', error: `CTRI fetch failed: ${(err as Error).message}` }
  }
}

function criterionKey(c: Criterion): string {
  const identifier = c.test_name ?? c.medication_name ?? c.medication_class ?? c.marker ?? c.condition ?? c.allergy_substance ?? ''
  return `${c.category}::${identifier.toLowerCase().trim()}`
}

async function extractResidualCriteriaViaClaude(
  trialsNeedingExtraction: RawTrial[],
  extractionByTrial: Map<string, { unparsedStatements: string[]; knownCriteria: Criterion[] }>,
  llmConfig: LLMProviderConfig
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
    max_tokens: 8000,
    messages:   [{ role: 'user', content: prompt }],
  }, llmConfig)

  const raw   = response.content.map(c => (c as any).text || '').join('')

  let result: any
  try {
    result = extractJSON(raw)
  } catch (err) {
    console.warn(`[matcher] Extraction response could not be parsed as JSON — falling back to rule-based-only criteria for the ${trialsNeedingExtraction.length} trial(s) in this call: ${(err as Error).message}`)
    return new Map()
  }

  const out = new Map<string, Criterion[]>()
  if (!Array.isArray(result.trials)) return out

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

async function scoreWithClaude(patient: Patient, trials: RawTrial[], sourceStatus: SourceStatus, clinicalData: ClinicalData | null, cacheStore?: TrialCriteriaCacheStore, providedLlmConfig?: LLMProviderConfig): Promise<MatchResult> {
  const llmConfig = providedLlmConfig ?? await resolveLLMConfig(patient.org_id)

  const ctgovCount = trials.filter(t => t.source === 'ClinicalTrials.gov').length
  const ctriCount  = trials.filter(t => t.source === 'CTRI').length

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

  interface TrialExtractionContext {
    knownCriteria:       Criterion[]
    cacheHit:            boolean
    eligibilityTextHash: string
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

  const cacheWrites: Promise<void>[] = []
  const trialsNeedingExtraction = trials.filter(t => {
    const ctx = extractionByTrial.get(t.nctId)!
    return !ctx.cacheHit && ctx.unparsedStatements.length > 0
  })
  if (trialsNeedingExtraction.length > 0) {
    const extracted = await extractResidualCriteriaViaClaude(trialsNeedingExtraction, extractionByTrial, llmConfig)
    for (const t of trialsNeedingExtraction) {
      const ctx = extractionByTrial.get(t.nctId)!
      const newlyExtracted = extracted.get(t.nctId) ?? []
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
    max_tokens: 16000,
    messages:   [{ role: 'user', content: prompt }],
  }, llmConfig)

  const raw   = response.content.map(c => (c as any).text || '').join('')

  let result: any
  try {
    result = extractJSON(raw)
  } catch (err) {
    throw new Error(
      `AI response could not be parsed as valid JSON. This usually means the response was truncated ` +
      `or malformed. Please try matching this patient again. (Parse error: ${(err as Error).message})`
    )
  }

  if (!Array.isArray(result.matches)) {
    throw new Error('AI response was missing the expected "matches" array. Please try again.')
  }

  const knownIds = new Set(trials.map(t => t.nctId.trim().toUpperCase()))
  const rawMatches: any[] = result.matches
  const survivingRawMatches = rawMatches.filter(m => {
    const id = String(m?.nctId || '').trim().toUpperCase()
    return id.length > 0 && knownIds.has(id)
  })

  const droppedCount = rawMatches.length - survivingRawMatches.length
  let summary = String(result.summary || '')
  if (droppedCount > 0) {
    console.error(
      `[matcher] Dropped ${droppedCount} match(es) for patient ${patient.patient_code} whose ` +
      `nctId did not match any retrieved trial — possible model fabrication, filtered before reaching the UI.`
    )
    summary = `${summary} (${droppedCount} suggested match${droppedCount !== 1 ? 'es' : ''} could not be verified against retrieved trial data and ${droppedCount !== 1 ? 'were' : 'was'} excluded from this report.)`.trim()
  }

  const trialsByNormalizedId = new Map(trials.map(t => [t.nctId.trim().toUpperCase(), t]))

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
        extractionSource: e.criterion.id.startsWith('rule-') ? 'rule_based' as const : 'ai_extracted' as const,
      })),
    }
  })

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

async function enrichClinicalData(clinicalData: ClinicalData | null): Promise<ClinicalData | null> {
  if (!clinicalData || clinicalData.medications.length === 0) return clinicalData
  const enrichedMeds = await enrichMedicationsWithRxNorm(clinicalData.medications)
  return { ...clinicalData, medications: enrichedMeds }
}

export async function matchPatient(
  patient: Patient,
  clinicalData: ClinicalData | null = null,
  cacheStore?: TrialCriteriaCacheStore,
  llmConfig?: LLMProviderConfig
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
  const result = await scoreWithClaude(patient, allTrials, sourceStatus, enrichedClinicalData, cacheStore, llmConfig)

  if (allTrials.length > 0) {
    if (sourceStatus.ctgov === 'error' && sourceStatus.ctri === 'ok') {
      result.summary = `Note: ClinicalTrials.gov could not be reached during this search — results below are from CTRI (India) only. ${result.summary}`
    } else if (sourceStatus.ctri === 'error' && sourceStatus.ctgov === 'ok') {
      result.summary = `Note: CTRI (India registry) could not be reached during this search — results below are from ClinicalTrials.gov only. ${result.summary}`
    }
  }

  return result
}