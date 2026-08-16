/**
 * lib/llm-provider.ts
 *
 * Multi-provider LLM abstraction. This app's matching engine was
 * originally hardcoded to `@anthropic-ai/sdk`'s specific request/response
 * format — meaning choosing this product meant choosing Claude
 * specifically, with no way for an org to use a different provider
 * without editing code. That's a real adoption barrier for a B2B SaaS,
 * and it was also architecturally inconsistent with everything else
 * here: billing, branding, WhatsApp numbers, notification preferences
 * are all per-organization settings already. AI provider being the one
 * hardcoded, platform-wide exception didn't fit.
 *
 * Design: each organization can configure its own provider + API key
 * (encrypted at rest — see lib/encryption.ts) via Settings. An org that
 * hasn't configured anything falls back to the platform-wide default,
 * controlled by env vars, so nothing breaks for existing deployments
 * that only ever set ANTHROPIC_API_KEY.
 *
 * Supported natively: Anthropic, OpenAI, Google Gemini. For everything
 * else — Groq, OpenRouter, Together, Azure OpenAI, self-hosted
 * vLLM/Ollama with an OpenAI-compatible shim, and most other providers —
 * 'openai_compatible' covers it with one implementation, since the
 * OpenAI Chat Completions request/response shape has become a de facto
 * standard most providers implement for compatibility.
 *
 * Every provider function normalizes its response into the same
 * {content: [{text: string}]} shape, so nothing in lib/matcher.ts needs
 * to know or care which provider actually served a given call.
 *
 * Honest limitation: only the Anthropic path has been exercised against
 * a real API in this project's own testing (it's what every match run
 * has used so far). The OpenAI, Google, and openai_compatible request
 * shapes below are built from each provider's current, real documented
 * API format — verified against actual current docs, not assumed from
 * memory — but none of the three has been called against a live
 * endpoint from this environment (the relevant API domains aren't
 * reachable from here — the same network wall documented in this
 * project's git history for OpenRouter, Docker Hub, and Vercel earlier).
 * The first real call to any of the three is a genuine first.
 */

import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from './supabase'
import { decrypt, parseEncryptionKey } from './encryption'

export type LLMProviderName = 'anthropic' | 'openai' | 'google' | 'openai_compatible'

export const LLM_PROVIDER_NAMES: LLMProviderName[] = ['anthropic', 'openai', 'google', 'openai_compatible']

export interface LLMProviderConfig {
  provider: LLMProviderName
  apiKey:   string
  model:    string
  baseUrl?: string  // required for openai_compatible; ignored otherwise
}

interface ChatCompletionRequest {
  max_tokens: number
  messages:   { role: 'user'; content: string }[]
}

interface ChatCompletionResponse {
  content: { text: string }[]
}

function defaultModelFor(provider: LLMProviderName): string {
  switch (provider) {
    case 'anthropic': return 'claude-sonnet-4-20250514'
    // Sensible starting defaults only — always overridable via the org's
    // configured model or LLM_PLATFORM_MODEL. Check each provider's
    // current model lineup yourself before relying on either of these;
    // they will go stale.
    case 'openai':    return 'gpt-4o'
    case 'google':    return 'gemini-2.0-flash'
    default:           return ''
  }
}

/**
 * Resolves which provider/credentials to use for a given org. Priority:
 * the org's own configured provider (DB, encrypted) > the platform-wide
 * default (env vars). Fails open to the platform default on any lookup
 * error — a DB hiccup on config lookup should never be why a match run
 * fails outright, any more than the rate limiter failing open is.
 */
export async function resolveLLMConfig(orgId: string | null | undefined): Promise<LLMProviderConfig> {
  if (orgId) {
    try {
      const { data } = await supabaseAdmin()
        .from('organizations')
        .select('llm_provider, llm_api_key_encrypted, llm_model, llm_base_url')
        .eq('id', orgId)
        .single()

      if (data?.llm_provider && data?.llm_api_key_encrypted) {
        const keyEnv = process.env.LLM_CREDENTIAL_ENCRYPTION_KEY
        if (!keyEnv) {
          console.error('[llm-provider] Org has a configured provider but LLM_CREDENTIAL_ENCRYPTION_KEY is not set — cannot decrypt. Falling back to platform default.')
        } else {
          const apiKey = decrypt(data.llm_api_key_encrypted, parseEncryptionKey(keyEnv, 'LLM_CREDENTIAL_ENCRYPTION_KEY'))
          return {
            provider: data.llm_provider as LLMProviderName,
            apiKey,
            model:    data.llm_model || defaultModelFor(data.llm_provider as LLMProviderName),
            baseUrl:  data.llm_base_url || undefined,
          }
        }
      }
    } catch (err) {
      console.error(`[llm-provider] Failed to resolve org-specific LLM config for org ${orgId}, falling back to platform default:`, err)
    }
  }
  return getPlatformDefaultConfig()
}

function getPlatformDefaultConfig(): LLMProviderConfig {
  // Backward compatibility: the earlier, OpenRouter-only testing shim
  // used LLM_TEST_PROVIDER=openrouter + OPENROUTER_API_KEY + OPENROUTER_MODEL.
  // If those are set and the new, general LLM_PLATFORM_* scheme isn't,
  // honor them rather than silently falling back to Anthropic — someone
  // may already have this configured live from that earlier setup guide.
  if (!process.env.LLM_PLATFORM_PROVIDER && process.env.LLM_TEST_PROVIDER === 'openrouter') {
    return {
      provider: 'openai_compatible',
      apiKey:   process.env.OPENROUTER_API_KEY || '',
      model:    process.env.OPENROUTER_MODEL || '',
      baseUrl:  'https://openrouter.ai/api/v1',
    }
  }

  const provider = (process.env.LLM_PLATFORM_PROVIDER as LLMProviderName) || 'anthropic'

  if (provider === 'anthropic') {
    return {
      provider: 'anthropic',
      apiKey:   process.env.LLM_PLATFORM_API_KEY || process.env.ANTHROPIC_API_KEY || '',
      model:    process.env.LLM_PLATFORM_MODEL || defaultModelFor('anthropic'),
    }
  }

  return {
    provider,
    apiKey:   process.env.LLM_PLATFORM_API_KEY || '',
    model:    process.env.LLM_PLATFORM_MODEL || defaultModelFor(provider),
    baseUrl:  process.env.LLM_PLATFORM_BASE_URL || undefined,
  }
}

export async function createChatCompletion(
  req: ChatCompletionRequest,
  config: LLMProviderConfig
): Promise<ChatCompletionResponse> {
  switch (config.provider) {
    case 'anthropic':         return callAnthropic(req, config)
    case 'openai':            return callOpenAIShape(req, config, 'https://api.openai.com/v1')
    case 'openai_compatible': return callOpenAIShape(req, config, requireBaseUrl(config))
    case 'google':            return callGoogle(req, config)
    default: {
      const _exhaustive: never = config.provider
      throw new Error(`Unknown LLM provider: ${_exhaustive}`)
    }
  }
}

function requireBaseUrl(config: LLMProviderConfig): string {
  if (!config.baseUrl) {
    throw new Error('provider "openai_compatible" requires baseUrl to be set (the custom endpoint\'s base URL, e.g. "https://api.groq.com/openai/v1").')
  }
  return config.baseUrl
}

async function callAnthropic(req: ChatCompletionRequest, config: LLMProviderConfig): Promise<ChatCompletionResponse> {
  const anthropic = new Anthropic({ apiKey: config.apiKey })
  const response = await anthropic.messages.create({
    model:      config.model,
    max_tokens: req.max_tokens,
    messages:   req.messages,
  })
  return { content: response.content.map(c => ({ text: (c as any).text || '' })) }
}

/** Shared by both 'openai' and 'openai_compatible' — same request/response shape, only the base URL differs. */
async function callOpenAIShape(req: ChatCompletionRequest, config: LLMProviderConfig, baseUrl: string): Promise<ChatCompletionResponse> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model:      config.model,
      max_tokens: req.max_tokens,
      messages:   req.messages,
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`${config.provider} request failed: ${res.status} ${res.statusText} — ${errText.slice(0, 500)}`)
  }

  const data = await res.json()
  const text = data?.choices?.[0]?.message?.content ?? ''
  return { content: [{ text }] }
}

async function callGoogle(req: ChatCompletionRequest, config: LLMProviderConfig): Promise<ChatCompletionResponse> {
  // Current documented shape (verified against ai.google.dev, not assumed):
  // POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
  // header x-goog-api-key, body { contents: [{ role, parts: [{ text }] }], generationConfig: { maxOutputTokens } }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'x-goog-api-key': config.apiKey,
    },
    body: JSON.stringify({
      contents: req.messages.map(m => ({
        role:  m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: req.max_tokens },
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`google request failed: ${res.status} ${res.statusText} — ${errText.slice(0, 500)}`)
  }

  const data = await res.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  return { content: [{ text }] }
}
