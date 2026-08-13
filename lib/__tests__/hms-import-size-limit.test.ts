/**
 * lib/__tests__/hms-import-size-limit.test.ts
 *
 * Regression test for a previously-fixed bug: Next.js's default JSON body
 * parser limit is 1MB, which silently 413s any real hospital CSV export
 * over that size. The fix raised the limit to 5MB on this route only, and
 * matched the client-side pre-upload check to the same 5MB so a user sees
 * a clear error before uploading rather than a bare 413 from the server.
 *
 * This test doesn't re-implement that logic — it asserts the actual
 * shipped values stay in sync, so a future edit to one side without the
 * other fails CI instead of silently reintroducing the mismatch.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('HMS import size limit — server/client must stay in sync', () => {
  it('server route sets bodyParser.sizeLimit to 5mb', async () => {
    const route = await import('../../pages/api/import/hms')
    expect((route as any).config).toEqual({ api: { bodyParser: { sizeLimit: '5mb' } } })
  })

  it('client-side pre-upload check enforces 5MB, matching the server limit (not the old 3MB/4MB guesses)', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'components', 'HMSImportModal.tsx'),
      'utf-8'
    )
    // Check the actual enforced comparison, not just any mention of "5MB"
    // anywhere in the file (the file's own comments legitimately reference
    // the old, wrong values as documentation of what was fixed).
    const sizeCheck = source.match(/file\.size\s*>\s*(\d+)\s*\*\s*1024\s*\*\s*1024/)
    expect(sizeCheck).not.toBeNull()
    expect(Number(sizeCheck![1])).toBe(5)
  })

  it('zod schema max length is consistent with a ~5MB text payload', async () => {
    const routeSource = readFileSync(
      join(__dirname, '..', '..', 'pages', 'api', 'import', 'hms.ts'),
      'utf-8'
    )
    const match = routeSource.match(/csv_text:\s*z\.string\(\)\.min\(\d+.*?\.max\(([\d_]+)/s)
    expect(match).not.toBeNull()
    const maxBytes = Number(match![1].replace(/_/g, ''))
    // Should be close to but not exceed 5MB (5,242,880 bytes) — comfortably
    // under the server bodyParser limit so the zod validation error fires
    // before Next.js's own body-size rejection would.
    expect(maxBytes).toBeGreaterThan(1_000_000)
    expect(maxBytes).toBeLessThanOrEqual(5 * 1024 * 1024)
  })
})
