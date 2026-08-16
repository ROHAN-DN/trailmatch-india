import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createChatCompletion, resolveLLMConfig, type LLMProviderConfig } from '../llm-provider'

// resolveLLMConfig reads from Supabase — mock it so these are real unit
// tests of the routing/fallback logic, not integration tests needing a
// live database.
vi.mock('../supabase', () => ({
  supabaseAdmin: vi.fn(),
}))
import { supabaseAdmin } from '../supabase'

describe('resolveLLMConfig — per-org config with platform-default fallback', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('falls back to the platform default (Anthropic via ANTHROPIC_API_KEY) when orgId is null — preserves original behavior for orgs that configured nothing', async () => {
    delete process.env.LLM_PLATFORM_PROVIDER
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real-key'

    const config = await resolveLLMConfig(null)

    expect(config).toEqual({
      provider: 'anthropic',
      apiKey:   'sk-ant-real-key',
      model:    'claude-sonnet-4-20250514',
    })
  })

  it('falls back to the platform default when the org has not configured its own provider', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real-key'
    ;(supabaseAdmin as any).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { llm_provider: null, llm_api_key_encrypted: null, llm_model: null, llm_base_url: null } }),
          }),
        }),
      }),
    })

    const config = await resolveLLMConfig('org-without-config')
    expect(config.provider).toBe('anthropic')
    expect(config.apiKey).toBe('sk-ant-real-key')
  })

  it('uses the org\'s own configured provider when one is set, decrypting the stored key', async () => {
    process.env.LLM_CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64) // valid 32-byte hex key for the test
    const { encrypt, parseEncryptionKey } = await import('../encryption')
    const encryptedKey = encrypt('sk-org-own-openai-key', parseEncryptionKey('a'.repeat(64), 'test'))

    ;(supabaseAdmin as any).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                llm_provider: 'openai',
                llm_api_key_encrypted: encryptedKey,
                llm_model: 'gpt-4o-mini',
                llm_base_url: null,
              },
            }),
          }),
        }),
      }),
    })

    const config = await resolveLLMConfig('org-with-openai-configured')
    expect(config).toEqual({
      provider: 'openai',
      apiKey:   'sk-org-own-openai-key',
      model:    'gpt-4o-mini',
      baseUrl:  undefined,
    })
  })

  it('fails open to the platform default if the DB lookup throws — a config-lookup hiccup should never break matching', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real-key'
    ;(supabaseAdmin as any).mockReturnValue({
      from: () => { throw new Error('connection reset') },
    })

    const config = await resolveLLMConfig('some-org')
    expect(config.provider).toBe('anthropic')
    expect(config.apiKey).toBe('sk-ant-real-key')
  })

  it('respects a platform-wide override to a non-Anthropic default provider', async () => {
    process.env.LLM_PLATFORM_PROVIDER = 'openai_compatible'
    process.env.LLM_PLATFORM_API_KEY  = 'platform-key'
    process.env.LLM_PLATFORM_MODEL    = 'some/model:free'
    process.env.LLM_PLATFORM_BASE_URL = 'https://openrouter.ai/api/v1'

    const config = await resolveLLMConfig(null)
    expect(config).toEqual({
      provider: 'openai_compatible',
      apiKey:   'platform-key',
      model:    'some/model:free',
      baseUrl:  'https://openrouter.ai/api/v1',
    })
  })

  it('honors the earlier temporary shim env vars (LLM_TEST_PROVIDER=openrouter) if the new LLM_PLATFORM_* scheme is not set — backward compatible with the earlier setup guide', async () => {
    delete process.env.LLM_PLATFORM_PROVIDER
    process.env.LLM_TEST_PROVIDER  = 'openrouter'
    process.env.OPENROUTER_API_KEY = 'or-key'
    process.env.OPENROUTER_MODEL   = 'meta-llama/llama-3.3-70b-instruct:free'

    const config = await resolveLLMConfig(null)
    expect(config).toEqual({
      provider: 'openai_compatible',
      apiKey:   'or-key',
      model:    'meta-llama/llama-3.3-70b-instruct:free',
      baseUrl:  'https://openrouter.ai/api/v1',
    })
  })

  it('prefers the new LLM_PLATFORM_* scheme over the old shim env vars when both happen to be set', async () => {
    process.env.LLM_PLATFORM_PROVIDER = 'anthropic'
    process.env.ANTHROPIC_API_KEY     = 'sk-ant-real'
    process.env.LLM_TEST_PROVIDER     = 'openrouter'
    process.env.OPENROUTER_API_KEY    = 'or-key'
    process.env.OPENROUTER_MODEL      = 'some/model:free'

    const config = await resolveLLMConfig(null)
    expect(config.provider).toBe('anthropic')
    expect(config.apiKey).toBe('sk-ant-real')
  })
})

describe('createChatCompletion — provider dispatch', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('routes to Anthropic\'s SDK for provider "anthropic"', async () => {
    // We don't have a real key here — the point is confirming fetch (the
    // REST-based providers) is never touched on this path, not that the
    // real Anthropic call succeeds.
    const fetchSpy = vi.spyOn(global, 'fetch')
    const config: LLMProviderConfig = { provider: 'anthropic', apiKey: 'fake', model: 'claude-sonnet-4-20250514' }

    await expect(
      createChatCompletion({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, config)
    ).rejects.toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('routes to api.openai.com for provider "openai", with the org\'s configured model', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'result text' } }] }),
    } as Response)

    const config: LLMProviderConfig = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' }
    const result = await createChatCompletion({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, config)

    expect(fetchSpy).toHaveBeenCalledWith('https://api.openai.com/v1/chat/completions', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.model).toBe('gpt-4o-mini')
    expect(result).toEqual({ content: [{ text: 'result text' }] })
  })

  it('routes to the configured baseUrl for provider "openai_compatible" (e.g. Groq, OpenRouter, self-hosted)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'free model result' } }] }),
    } as Response)

    const config: LLMProviderConfig = {
      provider: 'openai_compatible',
      apiKey:   'test-key',
      model:    'meta-llama/llama-3.3-70b-instruct:free',
      baseUrl:  'https://openrouter.ai/api/v1',
    }
    const result = await createChatCompletion({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, config)

    expect(fetchSpy).toHaveBeenCalledWith('https://openrouter.ai/api/v1/chat/completions', expect.anything())
    expect(result).toEqual({ content: [{ text: 'free model result' }] })
  })

  it('throws a clear error for "openai_compatible" with no baseUrl configured', async () => {
    const config: LLMProviderConfig = { provider: 'openai_compatible', apiKey: 'x', model: 'x' }
    await expect(
      createChatCompletion({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, config)
    ).rejects.toThrow(/baseUrl/)
  })

  it('routes to Google\'s generateContent endpoint for provider "google", using x-goog-api-key and the documented request shape', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'gemini result' }] } }] }),
    } as Response)

    const config: LLMProviderConfig = { provider: 'google', apiKey: 'test-key', model: 'gemini-2.0-flash' }
    const result = await createChatCompletion({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, config)

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'),
      expect.objectContaining({ headers: expect.objectContaining({ 'x-goog-api-key': 'test-key' }) })
    )
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.contents[0].parts[0].text).toBe('hi')
    expect(body.generationConfig.maxOutputTokens).toBe(10)
    expect(result).toEqual({ content: [{ text: 'gemini result' }] })
  })

  it('surfaces a clear error on a non-OK REST response, for any REST-based provider', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'rate limited',
    } as Response)

    const config: LLMProviderConfig = { provider: 'openai', apiKey: 'x', model: 'gpt-4o' }
    await expect(
      createChatCompletion({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, config)
    ).rejects.toThrow(/429/)
  })
})
