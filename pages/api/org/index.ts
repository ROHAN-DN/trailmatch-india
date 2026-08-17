import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '../auth/[...nextauth]'
import { supabaseAdmin } from '../../../lib/supabase'
import { encrypt, decrypt, parseEncryptionKey } from '../../../lib/encryption'
import { LLM_PROVIDER_NAMES, type LLMProviderName } from '../../../lib/llm-provider'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const user = session.user as any
  const db   = supabaseAdmin()

  // ── GET — fetch org settings ──────────────────────────────────
  if (req.method === 'GET') {
    const { data: org } = await db.from('organizations')
      .select('*')
      .eq('id', user.org_id)
      .single()

    const { count: patientCount } = await db.from('patients')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', user.org_id)
      .eq('is_archived', false)

    const { count: userCount } = await db.from('users')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', user.org_id)
      .eq('is_active', true)

    const { count: jobCount } = await db.from('match_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', user.org_id)

    // The encrypted key itself is never sent to the browser — not even
    // to the org that owns it. Only whether one is configured, and
    // which provider/model, so the UI can show "configured" without
    // ever having the ciphertext (or worse, a decrypted key) pass
    // through a response body.
    const orgSafe = org ? { ...org, llm_api_key_encrypted: undefined, llm_api_key_configured: !!org.llm_api_key_encrypted } : org

    return res.json({
      org: orgSafe,
      usage: { patients: patientCount, users: userCount, jobs: jobCount },
    })
  }

  // ── PATCH — update org settings (admin/owner only) ─────────────
  if (req.method === 'PATCH') {
    if (!['owner', 'admin'].includes(user.role)) {
      return res.status(403).json({ error: 'Admin access required' })
    }

    const allowed = ['name', 'type', 'city', 'state', 'logo_url', 'brand_color', 'data_retention_months']
    const updates: Record<string, any> = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }

    // AI provider configuration — separate validated path, since it
    // involves encryption and its own constraints (openai_compatible
    // needs a base URL; every other provider doesn't).
    if (req.body.llm_provider !== undefined) {
      const provider = req.body.llm_provider

      if (provider === null) {
        // Explicit reset back to "use the platform default" — clears
        // everything rather than leaving a stale key with no provider.
        updates.llm_provider = null
        updates.llm_api_key_encrypted = null
        updates.llm_model = null
        updates.llm_base_url = null
        updates.llm_configured_at = null
        updates.llm_configured_by = null
      } else {
        if (!LLM_PROVIDER_NAMES.includes(provider)) {
          return res.status(400).json({ error: `llm_provider must be one of ${LLM_PROVIDER_NAMES.join(', ')} or null` })
        }
        if (provider === 'openai_compatible' && !req.body.llm_base_url) {
          return res.status(400).json({ error: 'llm_base_url is required when llm_provider is "openai_compatible"' })
        }

        // REAL BUG FOUND AND FIXED HERE (caught in review, not by a user
        // report): "leave the key blank to keep the current one" is only
        // ever safe when the provider ISN'T changing. Without this check,
        // switching from OpenAI to Google with the key field left blank
        // (which the UI's own placeholder text invites) would silently
        // store the update as llm_provider='google' while leaving the
        // OpenAI-format key in llm_api_key_encrypted untouched — the
        // settings page would then show "Currently using Google" while
        // every real match attempt fails against a key that was never
        // valid for Google's API. This can't be caught by the browser's
        // `required` attribute alone (that's client-side only, and was
        // exactly the gap here), so it's enforced server-side.
        const { data: existingOrg } = await db.from('organizations')
          .select('llm_provider')
          .eq('id', user.org_id)
          .single()
        const isProviderChanging = existingOrg?.llm_provider !== provider

        if (isProviderChanging && !req.body.llm_api_key) {
          return res.status(400).json({ error: `Switching from ${existingOrg?.llm_provider || 'the platform default'} to ${provider} requires a new API key for ${provider} — the previous key can't be reused across providers.` })
        }

        if (req.body.llm_api_key) {
          const keyEnv = process.env.LLM_CREDENTIAL_ENCRYPTION_KEY
          if (!keyEnv) {
            return res.status(500).json({ error: 'Server is not configured to store AI provider credentials (LLM_CREDENTIAL_ENCRYPTION_KEY is not set). Contact your administrator.' })
          }
          updates.llm_api_key_encrypted = encrypt(req.body.llm_api_key, parseEncryptionKey(keyEnv, 'LLM_CREDENTIAL_ENCRYPTION_KEY'))
        }
        updates.llm_provider = provider
        if (req.body.llm_model !== undefined)    updates.llm_model    = req.body.llm_model || null
        if (req.body.llm_base_url !== undefined) updates.llm_base_url = req.body.llm_base_url || null
        updates.llm_configured_at = new Date().toISOString()
        updates.llm_configured_by = user.id
      }
    }

    const { data, error } = await db.from('organizations')
      .update(updates)
      .eq('id', user.org_id)
      .select().single()

    if (error) return res.status(500).json({ error: error.message })

    await db.from('audit_log').insert({
      org_id:   user.org_id,
      user_id:  user.id,
      action:   'update_org_settings',
      // Never log the actual key, encrypted or not, into the audit
      // trail — only that a provider change happened and to what.
      metadata: { ...updates, llm_api_key_encrypted: updates.llm_api_key_encrypted ? '[redacted]' : undefined },
    })

    const dataSafe = data ? { ...data, llm_api_key_encrypted: undefined, llm_api_key_configured: !!data.llm_api_key_encrypted } : data

    return res.json({ org: dataSafe })
  }

  res.setHeader('Allow', ['GET', 'PATCH'])
  res.status(405).end()
}
