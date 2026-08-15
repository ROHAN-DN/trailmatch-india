/**
 * lib/llm-provider.ts
 *
 * ⚠️ TEMPORARY TESTING SHIM — not meant to stay in this codebase long-term.
 *
 * Why this exists: to test the rest of this app (UI, database writes, PDF
 * generation, the whole pipeline) without an Anthropic API key yet, this
 * lets ONE env var swap the two Claude calls in lib/matcher.ts for a free
 * OpenRouter model instead — without touching matcher.ts's actual request
 * construction or response parsing at all.
 *
 * Default behavior (LLM_TEST_PROVIDER unset): identical to before this
 * file existed — calls real Anthropic, same model, same everything.
 * matcher.ts's own prompts and extraction logic are tuned for Claude
 * specifically; a free open-weight model will very likely extract and
 * score less accurately. This is for exercising the pipeline end-to-end,
 * not for judging real match quality. Switch back to real Anthropic
 * (just unset LLM_TEST_PROVIDER) before trusting any output for real.
 *
 * To use:
 *   1. Get a free OpenRouter API key: https://openrouter.ai/keys
 *      (email/GitHub signup, no card needed)
 *   2. Pick a model CURRENTLY marked free at
 *      https://openrouter.ai/models?order=pricing-low-to-high — the free
 *      lineup rotates, sometimes weekly, so don't reuse an ID from an old
 *      blog post or from this comment. Confirm it shows $0 input/output
 *      on OpenRouter's own site right before you use it.
 *   3. Set these three env vars:
 *        LLM_TEST_PROVIDER=openrouter
 *        OPENROUTER_API_KEY=<your key>
 *        OPENROUTER_MODEL=<the exact id you picked, e.g. "meta-llama/llama-3.3-70b-instruct:free">
 *
 * Real limits to expect (OpenRouter's free tier, not something this app
 * controls): roughly 20 requests/minute, 50/day before any credit
 * purchase. Each match run makes 2 calls, so that's enough for maybe
 * 20-25 test matches a day.
 *
 * NOT tested live against OpenRouter's actual API from the sandbox this
 * was written in — that domain isn't reachable from there (confirmed:
 * a direct request came back `403, x-deny-reason: host_not_allowed`).
 * This is written carefully and type-checks cleanly, but the first real
 * call is a genuine, unverified first for this specific code path.
 */

import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface ChatCompletionRequest {
  model:      string
  max_tokens: number
  messages:   { role: 'user'; content: string }[]
}

interface ChatCompletionResponse {
  content: { text: string }[]
}

export async function createChatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  if (process.env.LLM_TEST_PROVIDER === 'openrouter') {
    return callOpenRouterFree(req)
  }

  // Default path — real Anthropic, unchanged from before this file existed.
  const response = await anthropic.messages.create(req)
  return { content: response.content.map(c => ({ text: (c as any).text || '' })) }
}

async function callOpenRouterFree(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  const model = process.env.OPENROUTER_MODEL
  if (!model) {
    throw new Error(
      'LLM_TEST_PROVIDER=openrouter is set but OPENROUTER_MODEL is not. Pick a model currently ' +
      'marked $0/token at https://openrouter.ai/models?order=pricing-low-to-high (id usually ends ' +
      'in ":free") and set OPENROUTER_MODEL to that exact id. The free lineup rotates — verify it ' +
      'live rather than reusing an old id.'
    )
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new Error('LLM_TEST_PROVIDER=openrouter is set but OPENROUTER_API_KEY is not. Get a free key at https://openrouter.ai/keys.')
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: req.max_tokens,
      messages:   req.messages,
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(
      `OpenRouter request failed: ${res.status} ${res.statusText} — ${errText.slice(0, 500)}. ` +
      `If this is a 404/400 on the model, it likely rotated out of the free tier — check ` +
      `https://openrouter.ai/models?order=pricing-low-to-high for a current one. If it's 429, ` +
      `you've hit the free-tier rate limit (roughly 20/min, 50/day) — wait or add $10 credit ` +
      `(never expires, raises the daily cap to 1000).`
    )
  }

  const data = await res.json()
  const text = data?.choices?.[0]?.message?.content ?? ''
  return { content: [{ text }] }
}
