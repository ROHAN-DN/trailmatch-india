/**
 * components/__tests__/BatchPanel.test.ts
 *
 * Same convention as components/__tests__/MatchExplainability.test.ts —
 * this project has no React component-testing setup, so pure logic
 * pulled out of a component is tested directly here, node environment,
 * no JSX involved.
 *
 * Why this specific function has a dedicated test: found during review
 * that a failed match_results row (status='error') gave the coordinator
 * zero visibility into why it failed — error_msg was already sent by
 * the API but never rendered anywhere. That matters more now that a
 * misconfigured org-level AI provider key (something any admin can
 * cause, not just the platform operator) is a real, self-inflicted
 * failure mode. friendlyErrorHint turns a raw provider error into an
 * actionable hint for a non-engineer audience — worth confirming it
 * actually recognizes the real error message shapes lib/llm-provider.ts
 * produces, not just plausible-looking test strings.
 */

import { describe, it, expect } from 'vitest'
import { friendlyErrorHint } from '../BatchPanel'

describe('friendlyErrorHint', () => {
  it('recognizes the exact error shape lib/llm-provider.ts produces for a 401 from OpenAI', () => {
    const real = 'openai request failed: 401 Unauthorized — {"error":{"message":"Incorrect API key provided"}}'
    expect(friendlyErrorHint(real)).toMatch(/authentication problem/i)
  })

  it('recognizes the exact error shape for a 429 rate limit', () => {
    const real = 'openai_compatible request failed: 429 Too Many Requests — rate limited'
    expect(friendlyErrorHint(real)).toMatch(/rate-limited/i)
  })

  it('recognizes the exact error thrown for a missing openai_compatible baseUrl', () => {
    const real = 'provider "openai_compatible" requires baseUrl to be set (the custom endpoint\'s base URL, e.g. "https://api.groq.com/openai/v1").'
    expect(friendlyErrorHint(real)).toMatch(/base url/i)
  })

  it('recognizes a Google-shaped 401', () => {
    const real = 'google request failed: 401 Unauthorized — API key not valid'
    expect(friendlyErrorHint(real)).toMatch(/authentication problem/i)
  })

  it('returns null for a genuinely unrecognized error — never fabricates a misleading hint', () => {
    expect(friendlyErrorHint('ECONNRESET: socket hang up')).toBeNull()
    expect(friendlyErrorHint('Unexpected token < in JSON at position 0')).toBeNull()
  })

  it('handles an empty or missing error message without throwing', () => {
    expect(friendlyErrorHint('')).toBeNull()
  })
})
