/**
 * lib/trial-criteria-cache.ts
 *
 * Every match run re-extracts criteria from scratch for every retrieved
 * trial — the free rule-based pass (lib/rule-based-extraction.ts) AND the
 * Claude call that extracts structured criteria from whatever residual
 * text the rule-based pass couldn't parse (lib/matcher.ts's
 * scoreWithClaude). A trial's eligibility criteria don't depend on which
 * patient is being matched against it — a trial matched against 50
 * patients this week pays for the same extraction 50 times over,
 * including 50 separate Claude API calls for the residual-extraction
 * portion. This is the fix: extract once per trial, reuse for every
 * subsequent match, until the trial's own eligibility text changes.
 *
 * Store abstraction, not a single implementation, for the same reason
 * lib/ratelimit.ts and lib/clinical-data.ts each take their storage as a
 * parameter rather than reaching for a global client: it makes the cache
 * trivially testable (an in-memory Map, no real network/DB needed) and
 * keeps lib/matcher.ts itself free of any direct Supabase import — that
 * boundary already existed before this feature and there's no reason to
 * break it now. See migration 018_trial_criteria_cache.sql for the schema
 * and the full design rationale (content-hash invalidation, why this
 * table is deliberately not org-scoped).
 */

import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CriterionArray, type Criterion } from './eligibility-rules'

export type CacheableTrialSource = 'ClinicalTrials.gov' | 'CTRI'

export interface CachedTrialCriteria {
  criteria:    Criterion[]
  extractedAt: string // ISO timestamp — observability only, never used for invalidation (the content hash is)
}

export interface TrialCriteriaCacheStore {
  /**
   * Returns the cached criteria for this exact trial + exact eligibility
   * text, or null on a miss — a trial never seen before, one whose
   * eligibility text has changed since it was cached (different hash), or
   * any read failure. A store implementation must never throw: every
   * failure mode degrades to null (a cache miss), because a cache being
   * unavailable should make matching slower, never break it.
   */
  get(source: CacheableTrialSource, trialId: string, eligibilityTextHash: string): Promise<CachedTrialCriteria | null>

  /**
   * Writes (or overwrites, if the trial's text changed) the final
   * criteria for this trial. Must never throw — a failed cache WRITE
   * should never take down a match that already succeeded; it just means
   * the next match against this trial re-extracts instead of hitting.
   */
  set(source: CacheableTrialSource, trialId: string, eligibilityTextHash: string, criteria: Criterion[]): Promise<void>
}

/** sha256 hex digest of the exact eligibility text criteria were extracted from — see this file's header and the migration for why this, not just the trial ID, is the cache key. */
export function hashEligibilityText(eligibilityText: string): string {
  return createHash('sha256').update(eligibilityText, 'utf8').digest('hex')
}

// Rule-based IDs are always "rule-<n>" (lib/rule-based-extraction.ts) —
// the one place this convention needs to survive a round trip through
// storage, since it's how a cached criterion's original extractionSource
// (rule_based vs ai_extracted) is recovered after a cache hit, exactly
// the same way lib/matcher.ts already recovers it for a fresh extraction.
function countBySource(criteria: Criterion[]): { ruleBasedCount: number; aiExtractedCount: number } {
  const ruleBasedCount = criteria.filter(c => c.id.startsWith('rule-')).length
  return { ruleBasedCount, aiExtractedCount: criteria.length - ruleBasedCount }
}

/**
 * In-memory implementation — tests only. A plain Map keyed by
 * "source::trialId"; eligibility_text_hash is checked on read (a stored
 * entry whose hash doesn't match the query is treated as absent, exactly
 * like the real store), not folded into the map key, so a test can assert
 * "the second call with different trial text was a genuine miss" without
 * needing to know the internal key shape.
 */
export function createInMemoryTrialCriteriaCacheStore(): TrialCriteriaCacheStore {
  const store = new Map<string, { eligibilityTextHash: string; criteria: Criterion[]; extractedAt: string }>()
  return {
    async get(source, trialId, eligibilityTextHash) {
      const row = store.get(`${source}::${trialId}`)
      if (!row || row.eligibilityTextHash !== eligibilityTextHash) return null
      return { criteria: row.criteria, extractedAt: row.extractedAt }
    },
    async set(source, trialId, eligibilityTextHash, criteria) {
      store.set(`${source}::${trialId}`, { eligibilityTextHash, criteria, extractedAt: new Date().toISOString() })
    },
  }
}

/**
 * Supabase-backed implementation — see migration
 * 018_trial_criteria_cache.sql. Global (no org_id), matching that
 * migration's own reasoning: a trial's eligibility criteria are a fact
 * about the trial, not about any org matching against it.
 */
export function createSupabaseTrialCriteriaCacheStore(db: SupabaseClient): TrialCriteriaCacheStore {
  return {
    async get(source, trialId, eligibilityTextHash) {
      try {
        const { data, error } = await db
          .from('trial_criteria_cache')
          .select('criteria, extracted_at')
          .eq('source', source)
          .eq('trial_id', trialId)
          .eq('eligibility_text_hash', eligibilityTextHash)
          .maybeSingle()

        if (error) {
          console.warn(`[trial-criteria-cache] Read failed for ${source}/${trialId} — treating as a miss: ${error.message}`)
          return null
        }
        if (!data) return null

        // Defense in depth against a row whose criteria column doesn't
        // actually parse as Criterion[] anymore (a manual DB edit, a
        // schema drift between this deploy and whichever one wrote the
        // row, etc.) — same trust boundary this project validates at
        // everywhere else (see lib/matcher.ts's own CriterionArray
        // parsing of Claude's output). A cache row this project can't
        // trust is a miss, not a crash.
        const parsed = CriterionArray.safeParse(data.criteria)
        if (!parsed.success) {
          console.warn(`[trial-criteria-cache] Cached criteria for ${source}/${trialId} failed validation — treating as a miss: ${parsed.error.message}`)
          return null
        }

        return { criteria: parsed.data, extractedAt: data.extracted_at }
      } catch (err) {
        console.warn(`[trial-criteria-cache] Read threw for ${source}/${trialId} — treating as a miss: ${(err as Error).message}`)
        return null
      }
    },

    async set(source, trialId, eligibilityTextHash, criteria) {
      try {
        const { ruleBasedCount, aiExtractedCount } = countBySource(criteria)
        const { error } = await db
          .from('trial_criteria_cache')
          .upsert(
            {
              source, trial_id: trialId,
              eligibility_text_hash: eligibilityTextHash,
              criteria, rule_based_count: ruleBasedCount, ai_extracted_count: aiExtractedCount,
              extracted_at: new Date().toISOString(),
            },
            { onConflict: 'source,trial_id' }
          )
        if (error) {
          console.warn(`[trial-criteria-cache] Write failed for ${source}/${trialId} — this match's result is unaffected, only the cache for next time: ${error.message}`)
        }
      } catch (err) {
        console.warn(`[trial-criteria-cache] Write threw for ${source}/${trialId} — this match's result is unaffected, only the cache for next time: ${(err as Error).message}`)
      }
    },
  }
}
