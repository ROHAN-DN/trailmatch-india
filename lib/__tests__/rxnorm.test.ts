/**
 * lib/__tests__/rxnorm.test.ts
 *
 * These tests verify this file's OWN logic — defensive parsing, fallback
 * from exact to approximate match, graceful failure — against mocked
 * responses shaped like RxNorm's publicly documented API. They do NOT
 * verify that RxNorm's real API actually returns these shapes; this
 * sandbox has no network access to confirm that (see lib/rxnorm.ts's
 * header comment). That verification is still outstanding.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { normalizeMedicationName, getDrugClasses, enrichMedicationsWithRxNorm } from '../rxnorm'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

describe('normalizeMedicationName', () => {
  it('returns the RxCUI and normalized name on an exact match', async () => {
    ;(fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ idGroup: { name: 'metformin', rxnormId: ['6809'] } }),
    })

    const result = await normalizeMedicationName('metformin')
    expect(result).toEqual({ rxcui: '6809', name: 'metformin' })
  })

  it('falls back to approximate match when the exact endpoint has no rxnormId', async () => {
    ;(fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ idGroup: { name: 'Glucophage 500mg', rxnormId: [] } }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ approximateGroup: { candidate: [{ rxcui: '6809', name: 'metformin' }] } }),
      })

    const result = await normalizeMedicationName('Glucophage 500mg')
    expect(result).toEqual({ rxcui: '6809', name: 'metformin' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('returns null (not a throw) when both endpoints find nothing', async () => {
    ;(fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ idGroup: { name: 'xyzzy', rxnormId: [] } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ approximateGroup: { candidate: [] } }) })

    expect(await normalizeMedicationName('xyzzy')).toBeNull()
  })

  it('returns null instead of throwing on a network error', async () => {
    ;(fetch as any).mockRejectedValueOnce(new Error('network unreachable'))
    expect(await normalizeMedicationName('metformin')).toBeNull()
  })

  it('returns null instead of throwing on a malformed/unexpected response shape', async () => {
    ;(fetch as any).mockResolvedValueOnce({ ok: true, json: async () => ({ somethingUnexpected: true }) })
      .mockResolvedValueOnce({ ok: false })
    expect(await normalizeMedicationName('metformin')).toBeNull()
  })

  it('returns null instead of throwing when the response body is not valid JSON', async () => {
    ;(fetch as any).mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('invalid json') } })
      .mockResolvedValueOnce({ ok: false })
    expect(await normalizeMedicationName('metformin')).toBeNull()
  })

  it('returns null for an empty or whitespace-only name without making a network call', async () => {
    expect(await normalizeMedicationName('   ')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('getDrugClasses', () => {
  it('parses class memberships from a well-formed response', async () => {
    ;(fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rxclassDrugInfoList: {
          rxclassDrugInfo: [
            { rxclassMinConceptItem: { className: 'Glucagon-like Peptide-1 Receptor Agonists', classId: 'GLP1' } },
          ],
        },
      }),
    })
    const result = await getDrugClasses('123456')
    expect(result).toEqual([{ className: 'Glucagon-like Peptide-1 Receptor Agonists', classId: 'GLP1' }])
  })

  it('returns an empty array, not a throw, when the response has no class list', async () => {
    ;(fetch as any).mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    expect(await getDrugClasses('123456')).toEqual([])
  })

  it('returns an empty array on a network failure', async () => {
    ;(fetch as any).mockRejectedValueOnce(new Error('timeout'))
    expect(await getDrugClasses('123456')).toEqual([])
  })
})

describe('enrichMedicationsWithRxNorm — the actual wiring into live matching', () => {
  it('attaches a normalized name and drug classes for a medication RxNorm resolves', async () => {
    ;(fetch as any)
      // normalizeMedicationName('Glucophage 500mg') — exact match misses, approximate match hits
      .mockResolvedValueOnce({ ok: true, json: async () => ({ idGroup: { rxnormId: [] } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ approximateGroup: { candidate: [{ rxcui: '6809', name: 'metformin' }] } }) })
      // getDrugClasses('6809')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rxclassDrugInfoList: { rxclassDrugInfo: [
        { rxclassMinConceptItem: { className: 'Biguanides', classId: 'BIG' } },
      ] } }) })

    const result = await enrichMedicationsWithRxNorm([
      { name: 'Glucophage 500mg', status: 'active' },
    ])

    expect(result).toEqual([
      { name: 'Glucophage 500mg', status: 'active', rxnorm_normalized_names: ['metformin'], rxnorm_classes: ['Biguanides'] },
    ])
  })

  it('leaves both new fields as empty arrays — not undefined, not a throw — when RxNorm has no match', async () => {
    ;(fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ idGroup: { rxnormId: [] } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ approximateGroup: { candidate: [] } }) })

    const result = await enrichMedicationsWithRxNorm([{ name: 'a completely made-up drug name', status: 'active' }])
    expect(result[0].rxnorm_normalized_names).toEqual([])
    expect(result[0].rxnorm_classes).toEqual([])
  })

  it('degrades to empty arrays (not a throw that would take down the whole match) on a network failure', async () => {
    ;(fetch as any).mockRejectedValue(new Error('network unreachable'))
    const result = await enrichMedicationsWithRxNorm([{ name: 'metformin', status: 'active' }])
    expect(result).toEqual([{ name: 'metformin', status: 'active', rxnorm_normalized_names: [], rxnorm_classes: [] }])
  })

  it('preserves every original field on each medication record untouched', async () => {
    ;(fetch as any).mockRejectedValue(new Error('network unreachable'))
    const result = await enrichMedicationsWithRxNorm([
      { name: 'metformin', status: 'active', start_date: '2024-01-01', dose: '500mg' } as any,
    ])
    expect(result[0]).toMatchObject({ name: 'metformin', status: 'active', start_date: '2024-01-01', dose: '500mg' })
  })

  it('does not mutate the input array', async () => {
    ;(fetch as any).mockRejectedValue(new Error('network unreachable'))
    const input = [{ name: 'metformin', status: 'active' }]
    await enrichMedicationsWithRxNorm(input)
    expect(input[0]).not.toHaveProperty('rxnorm_normalized_names')
  })

  it('resolves an empty list without making any network calls', async () => {
    const result = await enrichMedicationsWithRxNorm([])
    expect(result).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('enriches multiple medications independently — one failing does not affect another succeeding', async () => {
    ;(fetch as any)
      // med 1: "metformin" — exact match hits
      .mockResolvedValueOnce({ ok: true, json: async () => ({ idGroup: { name: 'metformin', rxnormId: ['6809'] } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rxclassDrugInfoList: { rxclassDrugInfo: [] } }) })
      // med 2: network failure
      .mockRejectedValueOnce(new Error('timeout'))

    const result = await enrichMedicationsWithRxNorm([
      { name: 'metformin', status: 'active' },
      { name: 'unresolvable-drug', status: 'active' },
    ])
    expect(result[0].rxnorm_normalized_names).toEqual(['metformin'])
    expect(result[1].rxnorm_normalized_names).toEqual([])
  })
})
