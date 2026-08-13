import { describe, it, expect, vi } from 'vitest'
import { processInChunks } from '../concurrency'

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('processInChunks — correctness', () => {
  it('processes every item and returns results in the original order', async () => {
    const results = await processInChunks([1, 2, 3, 4, 5], 2, async (n) => n * 10)
    expect(results).toEqual([10, 20, 30, 40, 50])
  })

  it('preserves order even when later items resolve faster than earlier ones in the same chunk', async () => {
    const results = await processInChunks([1, 2, 3, 4], 4, async (n) => {
      await delay(n === 1 ? 30 : 5) // item 1 is slowest, but still first in the output
      return n
    })
    expect(results).toEqual([1, 2, 3, 4])
  })

  it('works correctly when concurrency exceeds the number of items (single chunk)', async () => {
    const results = await processInChunks([1, 2], 10, async (n) => n)
    expect(results).toEqual([1, 2])
  })

  it('works correctly for a single item', async () => {
    expect(await processInChunks([42], 4, async (n) => n + 1)).toEqual([43])
  })

  it('returns an empty array for empty input without calling the worker', async () => {
    const worker = vi.fn(async (n: number) => n)
    const results = await processInChunks([], 4, worker)
    expect(results).toEqual([])
    expect(worker).not.toHaveBeenCalled()
  })

  it('rejects an invalid (< 1) concurrency value rather than silently misbehaving', async () => {
    await expect(processInChunks([1], 0, async (n) => n)).rejects.toThrow('concurrency must be >= 1')
  })
})

describe('processInChunks — the actual concurrency bound is honored, not just assumed', () => {
  it('never runs more workers simultaneously than the concurrency limit, across items that finish at different times', async () => {
    let inFlight = 0
    let maxObservedInFlight = 0
    const items = [50, 10, 30, 10, 40, 10, 20, 10, 10, 10] // varied delays, deliberately out of order

    await processInChunks(items, 3, async (ms) => {
      inFlight++
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight)
      await delay(ms)
      inFlight--
      return ms
    })

    expect(maxObservedInFlight).toBeLessThanOrEqual(3)
    expect(maxObservedInFlight).toBeGreaterThan(1) // sanity check: this test would trivially pass if nothing ever ran concurrently at all
  })

  it('a slow item in one chunk does not let the next chunk start early (chunks are fully sequential relative to each other)', async () => {
    const order: string[] = []
    await processInChunks([1, 2, 3, 4], 2, async (n) => {
      if (n === 1) await delay(30) // slow item in chunk 1
      order.push(`start-${n}`)
      return n
    })
    // Items 3 and 4 (chunk 2) must not start before item 1 (the slow item
    // in chunk 1) finishes — that's what makes this "chunked", not just
    // "a global concurrency-3 pool."
    const item1Index = order.indexOf('start-1')
    const item3Index = order.indexOf('start-3')
    expect(item1Index).toBeLessThan(item3Index)
  })
})

describe('processInChunks — onChunkComplete callback', () => {
  it('is called once per chunk with the right running totals', async () => {
    const calls: Array<{ chunkSize: number; processedSoFar: number; total: number }> = []
    await processInChunks([1, 2, 3, 4, 5], 2, async (n) => n, (chunkResults, processedSoFar, total) => {
      calls.push({ chunkSize: chunkResults.length, processedSoFar, total })
    })

    expect(calls).toEqual([
      { chunkSize: 2, processedSoFar: 2, total: 5 },
      { chunkSize: 2, processedSoFar: 4, total: 5 },
      { chunkSize: 1, processedSoFar: 5, total: 5 }, // final, partial chunk
    ])
  })

  it('is awaited before the next chunk starts, when it returns a promise', async () => {
    const order: string[] = []
    await processInChunks([1, 2], 1, async (n) => {
      order.push(`worker-${n}`)
      return n
    }, async () => {
      order.push('chunk-complete')
      await delay(10)
    })
    expect(order).toEqual(['worker-1', 'chunk-complete', 'worker-2', 'chunk-complete'])
  })

  it('is optional — omitting it does not throw', async () => {
    await expect(processInChunks([1, 2], 2, async (n) => n)).resolves.toEqual([1, 2])
  })
})
