/**
 * pages/api/org/test-llm-provider.ts
 *
 * Lets an admin verify an AI provider configuration actually works
 * BEFORE saving it — closing a real gap the earlier error-visibility fix
 * (components/BatchPanel.tsx) only partially addressed. That fix made a
 * broken provider visible after a real match failed; this makes it
 * possible to catch the same mistake at configuration time instead,
 * which matters a lot more now that any org admin can misconfigure
 * their own provider, not just the platform operator misconfiguring one
 * shared key.
 *
 * POST { provider, apiKey?, model?, baseUrl? }
 * admin/owner only. apiKey is optional — if omitted, reuses the org's
 * already-stored key, but ONLY if `provider` matches what's already
 * configured (see lib/llm-provider.ts's resolveEffectiveApiKey — the
 * exact same "a key from one provider can't be reused for a different
 * one" rule pages/api/org/index.ts's PATCH handler enforces, shared
 * from one place so the two can't drift apart).
 *
 * Makes one real, minimal call to the actual configured provider — this
 * is the genuine test; there's no way to verify a key works without
 * actually using it. max_tokens is kept small specifically to keep this
 * cheap regardless of provider.
 */

import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { llmTestRateLimit } from '../../../lib/ratelimit'
import { createChatCompletion, resolveEffectiveApiKey, defaultModelFor, LLM_PROVIDER_NAMES, type LLMProviderName, type LLMProviderConfig } from '../../../lib/llm-provider'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).end()
  }

  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user = session.user as any
  if (!['owner', 'admin'].includes(user.role)) {
    return res.status(403).json({ error: 'Admin access required' })
  }

  const limit = await llmTestRateLimit(user.org_id)
  if (!limit.ok) return res.status(429).json({ error: limit.message })

  const { provider, model, baseUrl } = req.body as { provider?: string; apiKey?: string; model?: string; baseUrl?: string }
  const apiKey = req.body.apiKey as string | undefined

  if (!provider || !LLM_PROVIDER_NAMES.includes(provider as LLMProviderName)) {
    return res.status(400).json({ error: `provider must be one of ${LLM_PROVIDER_NAMES.join(', ')}` })
  }
  if (provider === 'openai_compatible' && !baseUrl) {
    return res.status(400).json({ error: 'baseUrl is required to test an "openai_compatible" provider' })
  }

  const keyResult = await resolveEffectiveApiKey(user.org_id, provider as LLMProviderName, apiKey)
  if ('error' in keyResult) {
    return res.status(400).json({ error: keyResult.error })
  }

  const config: LLMProviderConfig = {
    provider: provider as LLMProviderName,
    apiKey:   keyResult.apiKey,
    model:    model || defaultModelFor(provider as LLMProviderName),
    baseUrl:  baseUrl || undefined,
  }

  try {
    const response = await createChatCompletion({
      max_tokens: 10,
      messages:   [{ role: 'user', content: 'Reply with exactly one word: OK' }],
    }, config)

    const text = response.content.map(c => c.text || '').join('').trim()
    return res.json({ success: true, model: config.model, response: text })
  } catch (err: any) {
    return res.status(200).json({ success: false, error: err?.message || 'Unknown error testing this provider.' })
  }
}
