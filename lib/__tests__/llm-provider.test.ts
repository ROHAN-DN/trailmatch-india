import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createChatCompletion } from '../llm-provider'

describe('createChatCompletion — routing (temporary OpenRouter testing shim)', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('defaults to the real Anthropic path when LLM_TEST_PROVIDER is unset — production behavior untouched', async () => {
    delete process.env.LLM_TEST_PROVIDER
    const fetchSpy = vi.spyOn(global, 'fetch')
    // We don't have a real ANTHROPIC_API_KEY here, so the real call will
    // fail — the point of this test is confirming fetch (the OpenRouter
    // path) is never even attempted, not that the Anthropic call succeeds.
    await expect(
      createChatCompletion({ model: 'claude-sonnet-4-20250514', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('routes to OpenRouter via fetch when LLM_TEST_PROVIDER=openrouter is set', async () => {
    process.env.LLM_TEST_PROVIDER = 'openrouter'
    process.env.OPENROUTER_API_KEY = 'test-key'
    process.env.OPENROUTER_MODEL  = 'some/free-model:free'

    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"trials":[]}' } }] }),
    } as Response)

    const result = await createChatCompletion({
      model: 'claude-sonnet-4-20250514', // intentionally ignored on this path
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    )
    // Confirms the actual model used is the env var, not the hardcoded Claude model string passed in
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse((options as RequestInit).body as string)
    expect(body.model).toBe('some/free-model:free')

    // Confirms the response is normalized into the same shape matcher.ts already expects
    expect(result).toEqual({ content: [{ text: '{"trials":[]}' }] })
  })

  it('gives a clear, actionable error if OPENROUTER_MODEL is missing', async () => {
    process.env.LLM_TEST_PROVIDER = 'openrouter'
    process.env.OPENROUTER_API_KEY = 'test-key'
    delete process.env.OPENROUTER_MODEL

    await expect(
      createChatCompletion({ model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(/OPENROUTER_MODEL is not/)
  })

  it('gives a clear, actionable error if OPENROUTER_API_KEY is missing', async () => {
    process.env.LLM_TEST_PROVIDER = 'openrouter'
    process.env.OPENROUTER_MODEL  = 'some/free-model:free'
    delete process.env.OPENROUTER_API_KEY

    await expect(
      createChatCompletion({ model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(/OPENROUTER_API_KEY is not/)
  })

  it('surfaces a clear error on a non-OK response, with a hint about rotated free models or rate limits', async () => {
    process.env.LLM_TEST_PROVIDER = 'openrouter'
    process.env.OPENROUTER_API_KEY = 'test-key'
    process.env.OPENROUTER_MODEL  = 'some/free-model:free'

    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => 'rate limited',
    } as Response)

    await expect(
      createChatCompletion({ model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(/429/)
  })
})
