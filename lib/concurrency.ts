/**
 * lib/concurrency.ts
 *
 * Bounded concurrency for a list of async tasks — process at most N at a
 * time, not all sequentially and not all at once.
 *
 * Why this exists: pages/api/match/index.ts processes up to 20 patients
 * per batch job. Sequential (one at a time) is what it did originally —
 * safe, but a real risk of approaching Vercel's function duration ceiling
 * under realistic per-patient latency (concurrent CTgov/CTRI/RxNorm
 * fetches plus one Claude API call, each patient). Full parallelism (all
 * 20 at once) isn't the right alternative either — that's a real risk of
 * looking like abuse to CTgov/CTRI/RxNorm's public APIs and of hitting
 * Anthropic's own per-account concurrency limits. Fixed-size batches,
 * each fully awaited before the next starts, is the middle ground.
 *
 * `worker` must never reject. This utility deliberately adds no safety
 * net for that — a caller-specific "what does failure look like" result
 * shape (e.g. { strong, partial, failed } for a patient match) can't be
 * synthesized generically here. Every real caller is expected to catch
 * its own errors internally and always resolve with a result object; see
 * pages/api/match/index.ts's processOnePatient for what that looks like
 * in practice. A worker that rejects anyway will reject the whole
 * Promise.all for its chunk, which orphans its chunk-mates' in-flight
 * work from this function's perspective — exactly what "worker must
 * never reject" exists to prevent.
 */
export async function processInChunks<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
  onChunkComplete?: (chunkResults: R[], processedSoFar: number, total: number) => Promise<void> | void
): Promise<R[]> {
  if (concurrency < 1) throw new Error(`processInChunks: concurrency must be >= 1, got ${concurrency}`)

  const allResults: R[] = []
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency)
    const chunkResults = await Promise.all(chunk.map(worker))
    allResults.push(...chunkResults)
    if (onChunkComplete) await onChunkComplete(chunkResults, allResults.length, items.length)
  }
  return allResults
}
