/**
 * lib/rxnorm.ts
 *
 * Client for the U.S. National Library of Medicine's RxNorm REST API —
 * a free, public, no-signup medication name normalization service
 * (rxnav.nlm.nih.gov). Used to resolve spelling/brand-vs-generic variants
 * ("Glucophage" / "metformin" / "metformin HCl 500mg") to a canonical
 * RxCUI identifier, rather than relying on substring matching alone.
 *
 * IMPORTANT — HONEST DISCLOSURE, read before relying on this in production:
 * This sandbox has no network access to rxnav.nlm.nih.gov (confirmed
 * directly — requests return a proxy-level `x-deny-reason: host_not_allowed`
 * denial, the same check used throughout this project for Supabase, CTRI,
 * and ClinicalTrials.gov). Everything below is written against RxNorm's
 * publicly documented REST API shape, NOT verified against a live
 * response from this environment. Parsing is written defensively
 * specifically because of this — every field access tolerates a missing
 * or differently-shaped response rather than throwing, and a failure here
 * always degrades to "normalization unavailable, use the raw matched
 * name" rather than breaking extraction. Before this is relied on for
 * real matching decisions, make one real call against
 * https://rxnav.nlm.nih.gov/REST/rxcui.json?name=metformin and confirm
 * the response shape matches what parseRxcuiResponse expects below.
 *
 * This is used only to enrich rule-based extraction (lib/rule-based-extraction.ts)
 * and evaluation (lib/eligibility-rules.ts) — nothing here makes an
 * eligibility decision itself, and nothing here is an LLM call.
 */

const RXNORM_BASE = 'https://rxnav.nlm.nih.gov/REST'

export interface RxNormMatch {
  rxcui: string
  name: string
}

/**
 * Resolve a free-text medication name to its canonical RxCUI + normalized
 * name. Returns null on any failure (network error, no match, unexpected
 * response shape) — callers should treat null as "fall back to the raw
 * name," never as an error to surface to the user.
 */
export async function normalizeMedicationName(rawName: string): Promise<RxNormMatch | null> {
  const trimmed = rawName.trim()
  if (!trimmed) return null

  try {
    // Exact match first — RxNorm's /rxcui.json endpoint.
    const exactRes = await fetch(`${RXNORM_BASE}/rxcui.json?name=${encodeURIComponent(trimmed)}`, {
      signal: AbortSignal.timeout(5000),
    })
    if (exactRes.ok) {
      const exact = await exactRes.json().catch(() => null)
      const rxcui = exact?.idGroup?.rxnormId?.[0]
      if (typeof rxcui === 'string' && rxcui) {
        return { rxcui, name: exact?.idGroup?.name || trimmed }
      }
    }

    // Fall back to the approximate-match endpoint for typos/partial names
    // ("Metformin 500mg" rather than the bare ingredient name) — a
    // separate RxNorm endpoint designed exactly for this case.
    const approxRes = await fetch(`${RXNORM_BASE}/approximateTerm.json?term=${encodeURIComponent(trimmed)}&maxEntries=1`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!approxRes.ok) return null
    const approx = await approxRes.json().catch(() => null)
    const candidate = approx?.approximateGroup?.candidate?.[0]
    if (!candidate?.rxcui) return null

    return { rxcui: String(candidate.rxcui), name: candidate.name || trimmed }
  } catch {
    // Network error, timeout, or anything else — normalization is an
    // enhancement, not a dependency. Extraction proceeds with the raw name.
    return null
  }
}

export interface RxClassMembership {
  className: string
  classId: string
}

// ── Live wiring into patient matching ────────────────────────────
//
// Everything above this point was built and unit-tested but never
// actually called from anywhere else in the codebase — confirmed by grep
// across lib/rule-based-extraction.ts and lib/eligibility-rules.ts, which
// never imported this file. That's what enrichMedicationsWithPatient
// below fixes.
//
// Where this plugs in, and why here specifically: lib/eligibility-rules.ts
// is deliberately "pure, synchronous, zero I/O" (see that file's header)
// — it's the deterministic floor the whole matcher redesign depends on,
// and a live network call has no business inside it. lib/matcher.ts is
// already the async, I/O-performing layer (it fetches CTgov/CTRI and
// calls Claude), so that's where this gets invoked — never inside
// eligibility-rules.ts itself.
//
// The approach: for each of a patient's medications, best-effort resolve
// its RxCUI once per match, then attach (a) the canonical/normalized name
// RxNorm resolved it to and (b) its known drug-class memberships as two
// new OPTIONAL fields on the medication record. eligibility-rules.ts's
// evaluateMedication/evaluateMedicationClass check these fields in
// addition to the raw substring match, but every existing check still
// runs unchanged first — this can only ever ADD a match RxNorm found,
// never remove a match the plain substring comparison already found.
// A patient entered with no medications, or every RxNorm call failing,
// behaves identically to before this function existed.
//
// This existed nowhere in the codebase before — first real caller.

export interface EnrichableMedication {
  name: string
  [key: string]: unknown
}

export interface RxNormEnrichedMedication {
  /** Canonical/generic names RxNorm resolved this medication to (e.g. "Glucophage" -> ["metformin"]). Empty if normalization failed or found nothing. */
  rxnorm_normalized_names: string[]
  /** Drug-class names (as returned by RxClass) this medication's RxCUI belongs to. Empty if lookup failed, found nothing, or normalization itself failed (no RxCUI to look up classes for). */
  rxnorm_classes: string[]
}

/**
 * Best-effort RxNorm enrichment for one medication name. Never throws —
 * every failure mode (network, timeout, unrecognised name, malformed
 * response) degrades to `{ rxnorm_normalized_names: [], rxnorm_classes: [] }`,
 * which is a no-op for every caller: evaluateMedication/evaluateMedicationClass
 * simply fall back to their original substring-only behaviour.
 */
async function enrichOneMedication(name: string): Promise<RxNormEnrichedMedication> {
  const match = await normalizeMedicationName(name)
  if (!match) return { rxnorm_normalized_names: [], rxnorm_classes: [] }

  const classes = await getDrugClasses(match.rxcui)
  return {
    rxnorm_normalized_names: [match.name],
    rxnorm_classes: classes.map(c => c.className),
  }
}

/**
 * Enrich a patient's full medication list with RxNorm data, one best-effort
 * lookup per medication, run concurrently. Intended to be called once per
 * match in lib/matcher.ts — not per-criterion, not repeatedly — matching
 * the "fetch once, reuse forever" ethic used elsewhere in this codebase
 * (see this file's earlier header comment about the intended production
 * rollout, and the trial-criteria cache in lib/matcher.ts).
 *
 * Returns a NEW array; does not mutate the input. Every original field on
 * each medication is preserved untouched — this only ever adds the two
 * new optional fields above.
 */
export async function enrichMedicationsWithRxNorm<T extends EnrichableMedication>(
  medications: T[]
): Promise<Array<T & RxNormEnrichedMedication>> {
  return Promise.all(
    medications.map(async (m) => {
      try {
        const enrichment = await enrichOneMedication(m.name)
        return { ...m, ...enrichment }
      } catch {
        // Belt-and-braces — enrichOneMedication itself shouldn't throw
        // (both underlying calls already catch internally), but a
        // caller-visible crash here would take down an entire match over
        // an optional enhancement, which is strictly worse than skipping it.
        return { ...m, rxnorm_normalized_names: [], rxnorm_classes: [] }
      }
    })
  )
}

/**
 * Look up therapeutic class memberships for an RxCUI via RxClass
 * (rxnav.nlm.nih.gov's companion drug-classification API). Used to
 * upgrade the small hand-curated MEDICATION_CLASSES table in
 * lib/eligibility-rules.ts into something backed by a real, comprehensive,
 * NLM-maintained source rather than a handful of manually-typed drug names.
 *
 * Not yet wired into the live evaluation path — see this file's header.
 * A production rollout should pre-fetch and cache class memberships for
 * the drug classes this project actually needs (the same "fetch once,
 * reuse forever" pattern used for trial criteria elsewhere in this
 * codebase), not call this live during patient matching.
 */
export async function getDrugClasses(rxcui: string): Promise<RxClassMembership[]> {
  try {
    const res = await fetch(`${RXNORM_BASE}/rxclass/class/byRxcui.json?rxcui=${encodeURIComponent(rxcui)}`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return []
    const data = await res.json().catch(() => null)
    const items = data?.rxclassDrugInfoList?.rxclassDrugInfo
    if (!Array.isArray(items)) return []
    return items
      .map((item: any) => ({
        className: item?.rxclassMinConceptItem?.className,
        classId: item?.rxclassMinConceptItem?.classId,
      }))
      .filter((c: RxClassMembership) => c.className && c.classId)
  } catch {
    return []
  }
}
