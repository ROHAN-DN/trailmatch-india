/**
 * lib/rule-based-extraction.ts
 *
 * Deterministic, non-generative extraction of structured eligibility
 * criteria from raw trial text. No LLM call happens anywhere in this file
 * — every function here is pure regex, dictionary lookup, and a compact
 * NegEx-style negation check. Given the same input text, this always
 * produces the same output; there is no sampling, no model weights, and
 * nothing here can fabricate a criterion that wasn't in the source text.
 *
 * This is the PRIMARY extraction path in lib/matcher.ts — not a fallback.
 * Whatever statement this can't confidently classify into the Criterion
 * schema is returned separately as `unparsedStatements`, and only THOSE
 * residual statements are ever handed to Claude for extraction (see
 * lib/matcher.ts). Claude extracting criteria was already a narrower task
 * than Claude judging pass/fail (that decision has been made by
 * lib/eligibility-rules.ts alone since the previous session) — this
 * narrows Claude's involvement further, to only the subset of criteria
 * this deterministic pass genuinely cannot classify, rather than every
 * criterion in the trial.
 *
 * Honest scope, stated plainly rather than discovered later: this handles
 * the common, well-templated criterion phrasings — age ranges, named lab
 * thresholds, medication status/duration, comorbidity/allergy presence —
 * which is the large majority of what real trials contain, but not all of
 * it. Criteria2Query, the NIH/Columbia system this design is modelled on,
 * published the same finding after years of production use: rule-based
 * extraction's accuracy drops specifically on complex nested logical
 * criteria ("no chemo within 4 weeks unless receiving maintenance
 * therapy"-shaped constructs). That's expected here too, not a defect —
 * it's exactly why unparsed statements are surfaced, not dropped.
 */

import type { Criterion } from './eligibility-rules'

let idCounter = 0
function nextId(): string {
  idCounter += 1
  return `rule-${idCounter}`
}

function criterion(partial: Omit<Criterion, 'id'>): Criterion {
  return { id: nextId(), ...partial } as Criterion
}

// ── Section + statement splitting ───────────────────────────────

const INCLUSION_HEADER = /(?:^|\n)[ \t]*(?:key\s+)?inclusion\s+criteria:?[ \t]*\n/i
const EXCLUSION_HEADER = /(?:^|\n)[ \t]*(?:key\s+)?exclusion\s+criteria:?[ \t]*\n/i

/**
 * Splits raw eligibility text into inclusion/exclusion sections by header.
 * Real trial text doesn't always have both headers, or any — falls back to
 * treating the whole text as a single "unlabelled" section when neither
 * header is found, rather than guessing which part is which.
 *
 * Uses each header regex's own match (start index + full matched length,
 * via exec()) to find exactly where the header line ends, rather than a
 * separate indexOf() search for the next newline — that second search is
 * fragile precisely when the header match itself starts with or consumes
 * a newline (e.g. a leading blank line before "Inclusion Criteria:"),
 * because indexOf(', incMatch)' then immediately re-finds that same
 * newline instead of the one after the header text, silently including
 * the header line itself in the extracted section content.
 */
export function splitEligibilitySections(text: string): { inclusion: string; exclusion: string; unlabelled: string } {
  const incExec = INCLUSION_HEADER.exec(text)
  const excExec = EXCLUSION_HEADER.exec(text)

  if (!incExec && !excExec) {
    return { inclusion: '', exclusion: '', unlabelled: text }
  }

  const incEnd = incExec ? incExec.index + incExec[0].length : -1
  const excEnd = excExec ? excExec.index + excExec[0].length : -1

  if (incExec && excExec) {
    if (incExec.index < excExec.index) {
      return { inclusion: text.slice(incEnd, excExec.index).trim(), exclusion: text.slice(excEnd).trim(), unlabelled: '' }
    }
    return { inclusion: text.slice(incEnd).trim(), exclusion: text.slice(excEnd, incExec.index).trim(), unlabelled: '' }
  }

  if (incExec) return { inclusion: text.slice(incEnd).trim(), exclusion: '', unlabelled: '' }
  return { inclusion: '', exclusion: text.slice(excEnd).trim(), unlabelled: '' }
}

/** Splits a section's text into individual criterion statements — bullets, numbered items, or lines. */
export function splitIntoStatements(sectionText: string): string[] {
  if (!sectionText.trim()) return []
  return sectionText
    .split(/\n+/)
    .map(line => line.replace(/^\s*(?:[-•*]|\d+[.)]|\([a-z]\))\s*/i, '').trim())
    .filter(line => line.length > 3)
}

// ── Negation detection (NegEx-style) ────────────────────────────
// A compact version of the published NegEx algorithm: trigger-phrase
// lists (pre- and post-negation) plus a pseudo-negation guard list that
// overrides them. NegEx's own published evaluation: 84.5% precision,
// 82.4% recall on the original clinical-sentence benchmark — genuinely
// good, deterministic, and openly not perfect. Applied here at the
// statement level (each criterion is already a single short bullet, not a
// full narrative sentence), which is a reasonable simplification of the
// original word-window-around-a-concept design.

const PSEUDO_NEGATION_GUARDS = [
  'not certain', 'not ruled out', 'not excluded', 'not confirmed to be absent',
  'no reason to believe', 'no significant change',
]
const PRE_NEGATION_TRIGGERS = [
  'no history of', 'no evidence of', 'no prior', 'no known', 'without',
  'absence of', 'free of', 'never had', 'must not have', 'must not be',
  'excluded if', 'ruled out for', 'not permitted', 'no current',
]

export function isNegated(statement: string): boolean {
  const s = statement.toLowerCase()
  if (PSEUDO_NEGATION_GUARDS.some(g => s.includes(g))) return false
  return PRE_NEGATION_TRIGGERS.some(t => s.includes(t))
}

// ── Duration parsing ─────────────────────────────────────────────

function toDays(n: number, unit: string): number {
  const u = unit.toLowerCase()
  if (u.startsWith('week')) return n * 7
  if (u.startsWith('month')) return n * 30
  if (u.startsWith('year')) return n * 365
  return n // days
}

// ── Category matchers ────────────────────────────────────────────

function tryMatchAge(statement: string): Criterion | null {
  const s = statement.trim()

  let m = s.match(/age[d]?\s*:?\s*(?:of\s*)?(\d{1,3})\s*(?:-|to|–|—)\s*(\d{1,3})\s*years?/i)
  if (m) return criterion({ description: s, category: 'age', is_exclusion: false, min_age: +m[1], max_age: +m[2] })

  m = s.match(/(?:age\s*(?:of)?\s*(?:>=|≥)\s*(\d{1,3})|(\d{1,3})\s*years?\s*(?:of age\s*)?or older|at least\s*(\d{1,3})\s*years?\s*(?:of age)?|minimum age\s*(?:of)?\s*(\d{1,3})\s*years?)/i)
  if (m) {
    const age = +(m[1] || m[2] || m[3] || m[4])
    return criterion({ description: s, category: 'age', is_exclusion: false, min_age: age })
  }

  m = s.match(/(?:age\s*(?:of)?\s*(?:<=|≤)\s*(\d{1,3})|(\d{1,3})\s*years?\s*(?:of age\s*)?or younger|maximum age\s*(?:of)?\s*(\d{1,3})\s*years?|no older than\s*(\d{1,3})\s*years?)/i)
  if (m) {
    const age = +(m[1] || m[2] || m[3] || m[4])
    return criterion({ description: s, category: 'age', is_exclusion: false, max_age: age })
  }

  return null
}

function tryMatchSex(statement: string): Criterion | null {
  const s = statement.trim()
  if (/\b(male|female)\s+(?:and|or)\s+(?:female|male)\b/i.test(s) || /\ball\s+(?:sexes|genders)\b/i.test(s)) return null // no restriction — nothing to extract
  if (/\bmale\s+(?:patients?|participants?|subjects?)?\s*only\b/i.test(s) || /^\s*male\s*$/i.test(s)) {
    return criterion({ description: s, category: 'sex', is_exclusion: false, required_sex: 'Male' })
  }
  if (/\bfemale\s+(?:patients?|participants?|subjects?)?\s*only\b/i.test(s) || /^\s*female\s*$/i.test(s)) {
    return criterion({ description: s, category: 'sex', is_exclusion: false, required_sex: 'Female' })
  }
  return null
}

// Deliberately a modest, named list rather than attempting open-vocabulary
// lab recognition — see this file's header comment on honest scope. Easy
// to extend; each addition is a one-line, reviewable, testable change,
// unlike expanding an LLM's implicit "knowledge" of lab names.
const KNOWN_LAB_TERMS = [
  'HbA1c', 'eGFR', 'Creatinine', 'BMI', 'Body mass index',
  'Systolic blood pressure', 'Systolic BP', 'Diastolic blood pressure', 'Diastolic BP',
  'Hemoglobin', 'Platelet count', 'Neutrophil count', 'ANC',
  'Bilirubin', 'ALT', 'AST', 'LDL cholesterol', 'LDL', 'Triglycerides',
]

function tryMatchLab(statement: string): Criterion | null {
  const s = statement.trim()
  for (const term of KNOWN_LAB_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`\\b${escaped}\\b`, 'i').test(s)) continue

    let m = s.match(new RegExp(`${escaped}\\b[^\\d%]{0,20}?(\\d+(?:\\.\\d+)?)\\s*%?\\s*(?:-|to|and|–|—)\\s*(\\d+(?:\\.\\d+)?)\\s*%?`, 'i'))
    if (m) return criterion({ description: s, category: 'lab', is_exclusion: false, test_name: term, operator: 'between', value_low: +m[1], value_high: +m[2] })

    m = s.match(new RegExp(`${escaped}\\b[^\\d]{0,25}?(?:>=|≥|at least|no less than)\\s*(\\d+(?:\\.\\d+)?)`, 'i'))
    if (m) return criterion({ description: s, category: 'lab', is_exclusion: false, test_name: term, operator: 'gte', value: +m[1] })

    m = s.match(new RegExp(`${escaped}\\b[^\\d]{0,25}?(?:<=|≤|at most|no more than|no greater than)\\s*(\\d+(?:\\.\\d+)?)`, 'i'))
    if (m) return criterion({ description: s, category: 'lab', is_exclusion: false, test_name: term, operator: 'lte', value: +m[1] })

    m = s.match(new RegExp(`${escaped}\\b[^\\d]{0,25}?(?:>|greater than|above|exceeds)\\s*(\\d+(?:\\.\\d+)?)`, 'i'))
    if (m) return criterion({ description: s, category: 'lab', is_exclusion: false, test_name: term, operator: 'gt', value: +m[1] })

    m = s.match(new RegExp(`${escaped}\\b[^\\d]{0,25}?(?:<|less than|below|under)\\s*(\\d+(?:\\.\\d+)?)`, 'i'))
    if (m) return criterion({ description: s, category: 'lab', is_exclusion: false, test_name: term, operator: 'lt', value: +m[1] })
  }
  return null
}

function tryMatchMedication(statement: string): Criterion | null {
  const s = statement.trim()
  const negated = isNegated(s)

  // "on stable dose of X ... for at least N (days|weeks|months)"
  let m = s.match(/(?:on\s+(?:a\s+)?stable\s+(?:dose\s+of\s+)?|receiving\s+|treated\s+with\s+)([A-Za-z][A-Za-z0-9\- ]{1,40}?)(?:\s+\S+)*?\s+for\s+(?:at least\s+)?(\d+)\s*(day|week|month|year)s?/i)
  if (m) {
    return criterion({
      description: s, category: 'medication', is_exclusion: false,
      medication_name: m[1].trim(), required_status: 'active', min_duration_days: toDays(+m[2], m[3]),
    })
  }

  // "prior use of X" / "use of X within N days" / "no prior X" — exclusion-shaped
  m = s.match(/(?:prior\s+(?:use|treatment|therapy)\s+(?:of|with)\s+|use\s+of\s+|treatment\s+with\s+|received\s+|therapy\s+with\s+)([A-Za-z][A-Za-z0-9\- ]{1,40}?)(?:\s+within\s+(\d+)\s*(day|week|month)s?)?(?:\s+of\s+(?:screening|enrou?llment|randomi[sz]ation))?[.,]?\s*$/i)
  if (m && (negated || /\bprior\b|\bwithin\b/i.test(s))) {
    return criterion({ description: s, category: 'medication', is_exclusion: true, medication_name: m[1].trim() })
  }

  return null
}

function tryMatchComorbidity(statement: string): Criterion | null {
  const s = statement.trim()
  const negated = isNegated(s)

  // Negative lookahead on the "known" trigger specifically: "known
  // hypersensitivity/allergy to X" is an allergy statement, not a
  // comorbidity — without this, "known" (a legitimate comorbidity trigger
  // on its own, e.g. "known autoimmune disease") also matches allergy
  // phrasing, and since matcher order otherwise doesn't disambiguate,
  // whichever runs first wins the wrong category. Caught by this file's
  // own test suite asserting on category, not just "something matched."
  const m = s.match(/(?:history\s+of\s+|diagnosis\s+of\s+|known\s+(?!(?:hypersensitivity|allergy|allergic))|co-?morbid\s+|documented\s+)([A-Za-z][A-Za-z0-9\-\/ ]{2,50}?)(?:\s+within\s+(?:the\s+)?(?:past|last)\s+(\d+)\s*(day|week|month|year)s?)?[.,]?\s*$/i)
  if (!m) return null

  return criterion({
    description: s, category: 'comorbidity', is_exclusion: negated,
    condition: m[1].trim(),
  })
}

function tryMatchAllergy(statement: string): Criterion | null {
  const s = statement.trim()
  const m = s.match(/(?:known\s+)?(?:hypersensitivity|allergy|allergic\s+reaction)\s+to\s+([A-Za-z][A-Za-z0-9\-\/, ]{2,60}?)[.,]?\s*$/i)
  if (!m) return null
  return criterion({ description: s, category: 'allergy', is_exclusion: true, allergy_substance: m[1].trim() })
}

const MATCHERS: Array<(s: string) => Criterion | null> = [
  // Allergy checked before comorbidity — see the negative lookahead note
  // above; keeping the more specific matcher first is defense in depth
  // against the same class of trigger-word overlap happening again
  // elsewhere as more matchers are added.
  tryMatchAge, tryMatchSex, tryMatchLab, tryMatchMedication, tryMatchAllergy, tryMatchComorbidity,
]

export interface RuleBasedExtractionResult {
  criteria: Criterion[]
  /** Statements no matcher could confidently classify — the only text that ever reaches Claude, see lib/matcher.ts. */
  unparsedStatements: string[]
}

/** Extract every criterion this deterministic pass can confidently classify from raw trial eligibility text. */
export function extractCriteriaRuleBased(eligibilityText: string): RuleBasedExtractionResult {
  const { inclusion, exclusion, unlabelled } = splitEligibilitySections(eligibilityText)
  const statements = [
    ...splitIntoStatements(inclusion),
    ...splitIntoStatements(exclusion),
    ...splitIntoStatements(unlabelled),
  ]

  const criteria: Criterion[] = []
  const unparsedStatements: string[] = []

  for (const statement of statements) {
    let matched: Criterion | null = null
    for (const matcher of MATCHERS) {
      matched = matcher(statement)
      if (matched) break
    }
    if (matched) criteria.push(matched)
    else unparsedStatements.push(statement)
  }

  return { criteria, unparsedStatements }
}
