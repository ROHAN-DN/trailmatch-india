/**
 * lib/eligibility-rules.ts
 *
 * The deterministic rule engine this whole restructuring was building
 * toward. Pure, synchronous, zero I/O — every function here takes data
 * already in memory and returns an answer. No LLM call, no network call,
 * no database call happens anywhere in this file.
 *
 * Why this exists: lib/matcher.ts previously asked Claude to judge every
 * criterion — including purely arithmetic ones like "age >= 18" or
 * "eGFR >= 45 mL/min" — using the same holistic language-model judgment as
 * genuinely ambiguous criteria like "histologically confirmed
 * adenocarcinoma." That's the same structural gap that, in an earlier
 * version of this file, let a live-data fetch failure get silently
 * answered with a fabricated trial: there was no deterministic floor
 * anywhere in the pipeline. This module is that floor for the subset of
 * criteria that reduce to a real comparison against real structured data.
 *
 * Design philosophy — asymmetric confidence:
 *   - A criterion only evaluates to PASS or FAIL when there's actual
 *     matching patient data to compare against. No matching record ->
 *     UNKNOWN, never a guess in either direction.
 *   - For "must have X" (inclusion) criteria: a missing record is
 *     UNKNOWN, not FAIL — absence of a record is not evidence the patient
 *     doesn't have the condition, only that it hasn't been recorded yet.
 *   - For "must NOT have X" (exclusion) criteria: a missing record is
 *     treated as PASS (no evidence of the excluding factor), but the
 *     evidence string always says exactly that ("no record found") so a
 *     coordinator can see it's an absence-of-evidence conclusion, not a
 *     confirmed negative test.
 *   - lib/matcher.ts (the caller) is deliberately conservative about how
 *     it uses this: a deterministic FAIL can downgrade a match, but a
 *     deterministic PASS never auto-upgrades one — this engine only ever
 *     covers a subset of a trial's real criteria, and over-trusting it on
 *     the criteria it does cover would be its own kind of overconfidence.
 */

import { z } from 'zod'

// ── Criterion shape ──────────────────────────────────────────────
// Deliberately flat rather than a tagged union with nested per-category
// objects — flat is what an LLM extracting this from free text can
// reliably produce and what Zod can validate leniently (unused fields for
// a given category are just ignored, rather than a discriminated union
// rejecting the whole object over one misplaced field).

export const CriterionCategory = z.enum([
  'age', 'sex', 'lab', 'medication', 'medication_class', 'biomarker', 'comorbidity', 'allergy',
])
export type CriterionCategory = z.infer<typeof CriterionCategory>

export const ComparisonOperator = z.enum(['gte', 'lte', 'gt', 'lt', 'eq', 'between'])
export type ComparisonOperator = z.infer<typeof ComparisonOperator>

// Small, deliberately disciplined drug-class reference table. Real
// trials sometimes exclude a whole class ("no potassium-sparing
// diuretics", "no oral corticosteroids") not a single named drug, and a
// name-substring match against one drug name can't catch that.
//
// Each class below is a standard, stable pharmacology classification
// (not a guessed or speculative grouping) chosen specifically because
// it's a genuinely common exclusion-criterion pattern across real trial
// protocols — anticoagulants and NSAIDs for bleeding-risk exclusions,
// corticosteroids and immunosuppressants for confounding a treatment
// effect or an infection/vaccine trial's endpoint, statins and ACE
// inhibitors for cardiac/renal/metabolic trials where background
// medication needs to be known, loop diuretics as the direct complement
// to potassium-sparing (opposite mechanism, same "which diuretic is this
// patient on" question a protocol is actually asking). Each drug list is
// the standard generic-name roster for that class — not exhaustive of
// every marketed formulation, but the drugs that class is actually
// defined by. Extending further is a one-line addition per class.
export const MEDICATION_CLASSES: Record<string, string[]> = {
  potassium_sparing_diuretic: ['spironolactone', 'amiloride', 'triamterene', 'eplerenone'],
  loop_diuretic:              ['furosemide', 'torsemide', 'bumetanide', 'ethacrynic acid'],
  nsaid:                      ['ibuprofen', 'naproxen', 'diclofenac', 'indomethacin', 'ketorolac', 'celecoxib', 'meloxicam', 'piroxicam', 'etodolac'],
  anticoagulant:              ['warfarin', 'heparin', 'enoxaparin', 'dabigatran', 'rivaroxaban', 'apixaban', 'edoxaban', 'fondaparinux'],
  statin:                     ['atorvastatin', 'rosuvastatin', 'simvastatin', 'pravastatin', 'lovastatin', 'fluvastatin', 'pitavastatin'],
  ace_inhibitor:              ['lisinopril', 'enalapril', 'ramipril', 'captopril', 'benazepril', 'perindopril', 'fosinopril', 'quinapril'],
  oral_corticosteroid:        ['prednisone', 'prednisolone', 'dexamethasone', 'methylprednisolone', 'hydrocortisone', 'betamethasone'],
  immunosuppressant:          ['cyclosporine', 'tacrolimus', 'azathioprine', 'mycophenolate', 'sirolimus', 'methotrexate'],
}

export const Criterion = z.object({
  id:          z.string(),
  description: z.string(),              // human-readable, shown to the coordinator regardless of outcome
  category:    CriterionCategory,
  is_exclusion: z.boolean().default(false), // true = "must NOT have/be this", false = "must have/be this"

  // category: 'lab' (also used for BMI, blood pressure, etc. — anything
  // numeric that would live in patient_labs)
  test_name: z.string().optional(),
  operator:  ComparisonOperator.optional(),
  value:     z.number().optional(),      // for gte/lte/gt/lt/eq
  value_low: z.number().optional(),      // for between
  value_high: z.number().optional(),     // for between

  // category: 'medication'
  medication_name: z.string().optional(),        // substring-matched, case-insensitive, against patient_medications.name
  required_status:  z.enum(['active', 'discontinued']).optional(),
  min_duration_days: z.number().optional(),       // "stable dose for >= N days" — checked against start_date

  // category: 'medication_class'
  medication_class: z.string().optional(),        // key into MEDICATION_CLASSES

  // category: 'biomarker'
  marker: z.string().optional(),
  required_biomarker_status: z.enum(['positive', 'negative']).optional(),

  // category: 'comorbidity'
  condition: z.string().optional(),

  // category: 'allergy'
  allergy_substance: z.string().optional(),

  // category: 'age'
  min_age: z.number().optional(),
  max_age: z.number().optional(),

  // category: 'sex'
  required_sex: z.enum(['Male', 'Female', 'Any']).optional(),
})
export type Criterion = z.infer<typeof Criterion>

export const CriterionArray = z.array(Criterion).max(30)

// ── Inputs the evaluator needs ───────────────────────────────────

export interface EvaluablePatient {
  age: number
  sex: string
}

export interface EvaluableClinicalData {
  labs:          Array<{ test_name: string; value_numeric?: number | null; value_text?: string | null; unit?: string | null; collected_date?: string | null }>
  medications:   Array<{
    name: string; status: string; start_date?: string | null; end_date?: string | null
    // Optional, populated by lib/rxnorm.ts's enrichMedicationsWithRxNorm
    // before this data ever reaches evaluateCriteria (see lib/matcher.ts).
    // This file never fetches these itself — it only reads them if
    // present. Absent (undefined) is a normal, fully-supported state: a
    // patient entered before this feature existed, or one whose
    // medication RxNorm couldn't resolve, evaluates exactly as it did
    // before these fields existed.
    rxnorm_normalized_names?: string[]
    rxnorm_classes?:          string[]
  }>
  biomarkers:    Array<{ marker: string; status: string; value?: string | null }>
  comorbidities: Array<{ condition: string; status: string }>
  allergies:     Array<{ substance: string }>
}

export type CriterionOutcome = 'PASS' | 'FAIL' | 'UNKNOWN'

export interface EvaluatedCriterion {
  criterion: Criterion
  result:    CriterionOutcome
  evidence:  string
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

function findLab(labs: EvaluableClinicalData['labs'], testName: string) {
  const target = norm(testName)
  // Most recent match wins if a patient has multiple readings for the same test.
  const matches = labs
    .filter(l => norm(l.test_name) === target)
    .sort((a, b) => (b.collected_date || '').localeCompare(a.collected_date || ''))
  return matches[0]
}

function evaluateLab(c: Criterion, data: EvaluableClinicalData): EvaluatedCriterion {
  if (!c.test_name || !c.operator) {
    return { criterion: c, result: 'UNKNOWN', evidence: 'Criterion is missing a test name or comparison operator — cannot evaluate.' }
  }
  const lab = findLab(data.labs, c.test_name)
  if (!lab) {
    return { criterion: c, result: 'UNKNOWN', evidence: `No recorded ${c.test_name} value for this patient.` }
  }
  if (lab.value_numeric === null || lab.value_numeric === undefined) {
    return { criterion: c, result: 'UNKNOWN', evidence: `${c.test_name} is recorded as "${lab.value_text}", not a number — cannot compare against a threshold.` }
  }
  const v = lab.value_numeric
  const dateStr = lab.collected_date ? ` (recorded ${lab.collected_date})` : ''
  const unitStr = lab.unit ? (lab.unit === '%' ? lab.unit : ' ' + lab.unit) : ''
  const evidenceBase = `${c.test_name} = ${v}${unitStr}${dateStr}`

  let pass: boolean
  switch (c.operator) {
    case 'gte':     pass = c.value !== undefined && v >= c.value; break
    case 'lte':     pass = c.value !== undefined && v <= c.value; break
    case 'gt':      pass = c.value !== undefined && v > c.value; break
    case 'lt':      pass = c.value !== undefined && v < c.value; break
    case 'eq':      pass = c.value !== undefined && v === c.value; break
    case 'between': pass = c.value_low !== undefined && c.value_high !== undefined && v >= c.value_low && v <= c.value_high; break
    default:        return { criterion: c, result: 'UNKNOWN', evidence: `Unrecognised operator "${c.operator}".` }
  }
  return { criterion: c, result: pass ? 'PASS' : 'FAIL', evidence: evidenceBase }
}

// A medication record "matches" a target name if the raw recorded name
// contains it (original behaviour, always checked first) OR — new — any
// RxNorm-resolved normalized name for that record contains it. The second
// check is what lets a patient record entered as a brand name ("Glucophage
// 500mg") satisfy a criterion written with the generic/INN name
// ("metformin"), which real trial protocols overwhelmingly use and which
// plain substring matching on the raw name cannot catch on its own.
// Trial-side name normalization (resolving the CRITERION's medication
// name, not just the patient's) is not implemented — out of scope for
// this pass, see lib/rxnorm.ts.
function medicationNameMatches(m: EvaluableClinicalData['medications'][number], target: string): boolean {
  if (norm(m.name).includes(target)) return true
  return (m.rxnorm_normalized_names ?? []).some(n => norm(n).includes(target))
}

function evaluateMedication(c: Criterion, data: EvaluableClinicalData): EvaluatedCriterion {
  if (!c.medication_name) {
    return { criterion: c, result: 'UNKNOWN', evidence: 'Criterion is missing a medication name — cannot evaluate.' }
  }
  const target = norm(c.medication_name)
  const matches = data.medications.filter(m => medicationNameMatches(m, target))

  if (c.is_exclusion) {
    // "No prior GLP-1 agonist use" — any record at all (active or
    // discontinued) is evidence of use, which fails the criterion.
    if (matches.length === 0) {
      return { criterion: c, result: 'PASS', evidence: `No record of ${c.medication_name} in this patient's medication history.` }
    }
    const names = matches.map(m => `${m.name} (${m.status})`).join(', ')
    return { criterion: c, result: 'FAIL', evidence: `Found in medication history: ${names}.` }
  }

  // Inclusion — "must be on X"
  const active = matches.filter(m => m.status === 'active')
  if (active.length === 0) {
    if (matches.length > 0) {
      return { criterion: c, result: 'FAIL', evidence: `${c.medication_name} found in history but not currently active (status: ${matches.map(m => m.status).join(', ')}).` }
    }
    return { criterion: c, result: 'UNKNOWN', evidence: `No record of ${c.medication_name} for this patient.` }
  }

  if (c.min_duration_days !== undefined) {
    const withStartDate = active.find(m => m.start_date)
    if (!withStartDate?.start_date) {
      return { criterion: c, result: 'UNKNOWN', evidence: `${c.medication_name} is active but no start date is recorded — cannot confirm ${c.min_duration_days}-day duration requirement.` }
    }
    const daysSince = Math.floor((Date.now() - new Date(withStartDate.start_date).getTime()) / 86_400_000)
    if (daysSince < c.min_duration_days) {
      return { criterion: c, result: 'FAIL', evidence: `${c.medication_name} started ${withStartDate.start_date} — only ${daysSince} days ago, needs ${c.min_duration_days}.` }
    }
    return { criterion: c, result: 'PASS', evidence: `${c.medication_name} active since ${withStartDate.start_date} (${daysSince} days).` }
  }

  return { criterion: c, result: 'PASS', evidence: `${c.medication_name} is an active medication for this patient.` }
}

// Free-text hints for matching a live RxClass className string (e.g.
// "Potassium Sparing Diuretics") against our own internal class keys
// (e.g. "potassium_sparing_diuretic"). Deliberately loose (word-presence,
// not exact string equality) because RxClass sources its class names from
// several different taxonomies (ATC, MOA, EPC, ...) with real wording
// variation between them, and this sandbox has no live RxClass access to
// pin down the exact string a real call would return (see lib/rxnorm.ts's
// header — same disclosed limitation as the rest of that file). This is
// intentionally used ONLY to ADD a class match on top of the static
// MEDICATION_CLASSES table below, never to replace or override it — a
// false negative here just leaves the static table as the sole source of
// truth, exactly as before this existed; the risk this pass is guarding
// against is a false positive, not under-matching.
const RXCLASS_NAME_HINTS: Record<string, string[]> = {
  potassium_sparing_diuretic: ['potassium', 'diuretic'],
  loop_diuretic:              ['loop', 'diuretic'],
  nsaid:                      ['nonsteroid'],      // stem — matches "nonsteroidal" regardless of exact suffix RxClass uses
  anticoagulant:               ['anticoagul'],      // stem — matches "anticoagulant"/"anticoagulation"
  statin:                      ['statin'],          // widely used as a direct synonym in RxClass data, not just the formal "HMG-CoA reductase inhibitor" term
  ace_inhibitor:                ['ace inhibitor'],  // substring also matches the plural "ACE inhibitors"
  oral_corticosteroid:          ['corticosteroid'],
  immunosuppressant:            ['immunosuppress'], // stem — matches "immunosuppressant"/"immunosuppressive"
}

function matchesRxClassHint(classKey: string, rxnormClasses: string[]): string | null {
  const hints = RXCLASS_NAME_HINTS[classKey]
  if (!hints?.length) return null
  return rxnormClasses.find(cls => {
    const c = norm(cls)
    return hints.every(hint => c.includes(hint))
  }) ?? null
}

function evaluateMedicationClass(c: Criterion, data: EvaluableClinicalData): EvaluatedCriterion {
  if (!c.medication_class || !(c.medication_class in MEDICATION_CLASSES)) {
    return { criterion: c, result: 'UNKNOWN', evidence: `Unrecognised or unsupported medication class "${c.medication_class}" — cannot evaluate.` }
  }
  const classDrugs = MEDICATION_CLASSES[c.medication_class]
  const matches = data.medications.filter(m => {
    if (m.status !== 'active') return false
    if (classDrugs.some(drug => norm(m.name).includes(drug))) return true
    // Additive RxNorm signal — see RXCLASS_NAME_HINTS above.
    return matchesRxClassHint(c.medication_class!, m.rxnorm_classes ?? []) !== null
  })
  // Medication-class criteria in real protocols are exclusions ("no
  // potassium-sparing diuretics") — that's the only case this project has
  // evidence for, so that's the only direction implemented.
  if (matches.length === 0) {
    return { criterion: c, result: 'PASS', evidence: `No active medication matching the "${c.medication_class.replace(/_/g, ' ')}" class.` }
  }
  return { criterion: c, result: 'FAIL', evidence: `Active medication in excluded class: ${matches.map(m => m.name).join(', ')}.` }
}

function evaluateBiomarker(c: Criterion, data: EvaluableClinicalData): EvaluatedCriterion {
  if (!c.marker) return { criterion: c, result: 'UNKNOWN', evidence: 'Criterion is missing a biomarker name.' }
  const target = norm(c.marker)
  const match = data.biomarkers.find(b => norm(b.marker) === target)
  if (!match) return { criterion: c, result: 'UNKNOWN', evidence: `No recorded ${c.marker} result for this patient.` }
  if (match.status === 'unknown' || match.status === 'not_tested') {
    return { criterion: c, result: 'UNKNOWN', evidence: `${c.marker} was tested but result is recorded as ${match.status}.` }
  }
  const evidence = `${c.marker}: ${match.status}${match.value ? ` (${match.value})` : ''}`
  if (!c.required_biomarker_status) return { criterion: c, result: 'UNKNOWN', evidence: 'Criterion does not specify a required biomarker status.' }
  return { criterion: c, result: match.status === c.required_biomarker_status ? 'PASS' : 'FAIL', evidence }
}

function evaluateComorbidity(c: Criterion, data: EvaluableClinicalData): EvaluatedCriterion {
  if (!c.condition) return { criterion: c, result: 'UNKNOWN', evidence: 'Criterion is missing a condition name.' }
  const target = norm(c.condition)
  const match = data.comorbidities.find(cm => norm(cm.condition).includes(target))

  if (c.is_exclusion) {
    if (!match) return { criterion: c, result: 'PASS', evidence: `No record of ${c.condition} for this patient.` }
    return { criterion: c, result: 'FAIL', evidence: `${c.condition} recorded (status: ${match.status}).` }
  }

  if (!match) return { criterion: c, result: 'UNKNOWN', evidence: `No record of ${c.condition} for this patient.` }
  if (match.status === 'resolved') return { criterion: c, result: 'FAIL', evidence: `${c.condition} recorded but resolved, not currently active.` }
  return { criterion: c, result: 'PASS', evidence: `${c.condition} recorded as active.` }
}

function evaluateAllergy(c: Criterion, data: EvaluableClinicalData): EvaluatedCriterion {
  if (!c.allergy_substance) return { criterion: c, result: 'UNKNOWN', evidence: 'Criterion is missing an allergy substance.' }
  const target = norm(c.allergy_substance)
  const match = data.allergies.find(a => norm(a.substance).includes(target))
  if (!match) return { criterion: c, result: 'PASS', evidence: `No recorded allergy to ${c.allergy_substance}.` }
  return { criterion: c, result: 'FAIL', evidence: `Recorded allergy to ${match.substance}.` }
}

function evaluateAge(c: Criterion, patient: EvaluablePatient): EvaluatedCriterion {
  const evidence = `Patient age: ${patient.age}`
  if (c.min_age !== undefined && patient.age < c.min_age) return { criterion: c, result: 'FAIL', evidence }
  if (c.max_age !== undefined && patient.age > c.max_age) return { criterion: c, result: 'FAIL', evidence }
  if (c.min_age === undefined && c.max_age === undefined) return { criterion: c, result: 'UNKNOWN', evidence: 'Criterion has no age bounds to check.' }
  return { criterion: c, result: 'PASS', evidence }
}

function evaluateSex(c: Criterion, patient: EvaluablePatient): EvaluatedCriterion {
  if (!c.required_sex || c.required_sex === 'Any') return { criterion: c, result: 'UNKNOWN', evidence: 'Criterion does not restrict by sex.' }
  const evidence = `Patient sex: ${patient.sex}`
  return { criterion: c, result: patient.sex === c.required_sex ? 'PASS' : 'FAIL', evidence }
}

/** Evaluate one criterion against one patient's real structured clinical data. Pure — no I/O. */
export function evaluateCriterion(c: Criterion, patient: EvaluablePatient, data: EvaluableClinicalData): EvaluatedCriterion {
  switch (c.category) {
    case 'age':               return evaluateAge(c, patient)
    case 'sex':                return evaluateSex(c, patient)
    case 'lab':                return evaluateLab(c, data)
    case 'medication':         return evaluateMedication(c, data)
    case 'medication_class':   return evaluateMedicationClass(c, data)
    case 'biomarker':          return evaluateBiomarker(c, data)
    case 'comorbidity':        return evaluateComorbidity(c, data)
    case 'allergy':            return evaluateAllergy(c, data)
    default:                   return { criterion: c, result: 'UNKNOWN', evidence: `Unrecognised category "${(c as any).category}".` }
  }
}

/** Evaluate a full set of criteria. Order is preserved; each is independent. */
export function evaluateCriteria(criteria: Criterion[], patient: EvaluablePatient, data: EvaluableClinicalData): EvaluatedCriterion[] {
  return criteria.map(c => evaluateCriterion(c, patient, data))
}

export interface DeterministicSummary {
  passCount:    number
  failCount:    number
  unknownCount: number
  hasFail:      boolean   // true if any criterion deterministically failed — see lib/matcher.ts for how this is used to downgrade (never upgrade) a match
}

export function summarizeDeterministicResults(evaluated: EvaluatedCriterion[]): DeterministicSummary {
  return {
    passCount:    evaluated.filter(e => e.result === 'PASS').length,
    failCount:    evaluated.filter(e => e.result === 'FAIL').length,
    unknownCount: evaluated.filter(e => e.result === 'UNKNOWN').length,
    hasFail:      evaluated.some(e => e.result === 'FAIL'),
  }
}
