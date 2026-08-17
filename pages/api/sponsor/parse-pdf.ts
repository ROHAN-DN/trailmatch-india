/**
 * pages/api/sponsor/parse-pdf.ts
 * Protocol Parser Agent v1 — PDF support (Week 13-14)
 *
 * Spec: "Claude reads protocol PDF → structured JSON criteria"
 *
 * Sends the PDF directly to Claude as a document block.
 * Claude natively reads the PDF and extracts structured criteria.
 * No text extraction step needed — Claude handles it end-to-end.
 *
 * POST { pdf_base64: string, media_type: 'application/pdf' }
 * Returns the same ParsedProtocol shape as lib/protocol-parser.ts
 *
 * Size limit: 10MB (Anthropic PDF limit)
 */

import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import { withApiHandler } from '../../../lib/api-handler'
import { resolveLLMConfig } from '../../../lib/llm-provider'
import { sanitiseCodes, sanitiseCriteria, validatePhase } from '../../../lib/protocol-parser'
import { ForbiddenError, ValidationError, AIServiceError } from '../../../lib/errors'
import { writeAudit } from '../../../lib/audit'

const SPONSOR_TYPES = ['pharma', 'biotech', 'cro']
const MAX_PDF_BYTES = 10 * 1024 * 1024   // 10 MB

const BodySchema = z.object({
  pdf_base64: z.string()
    .min(100, 'PDF data too short')
    .refine(s => {
      const byteLen = Math.ceil(s.length * 3 / 4)
      return byteLen <= MAX_PDF_BYTES
    }, `PDF must be under 10 MB`),
  media_type: z.literal('application/pdf'),
})

const SYSTEM_PROMPT = `You are a clinical data extraction expert.
Read the provided clinical trial protocol PDF and extract all eligibility criteria.
Return ONLY a JSON object — no markdown, no preamble.

Output schema:
{
  "title": "trial title or null",
  "phase": "Phase I"|"Phase II"|"Phase III"|"Phase IV"|"Phase I/II"|"Phase II/III"|null,
  "therapeutic_area": "concise area e.g. Type 2 Diabetes, Oncology",
  "inclusion_criteria": [{ "field": "diagnosis"|"age"|"labs"|"medications"|"comorbidities"|"biomarkers"|"ecog_status"|"sex", "operator": "contains"|"not_contains"|"gte"|"lte"|"between"|"equals", "value": string|number|[min,max], "label": "under 12 words" }],
  "exclusion_criteria": [same schema],
  "mapped_codes": { "icd10": ["E11.9"], "snomed": ["44054006"], "loinc": ["4548-4"] },
  "raw_criteria_summary": "2-3 sentence plain-English summary",
  "parse_confidence": 0.0-1.0
}

RULES:
- For age "between" use [min,max]; for gte/lte use a number
- Exclusion medications/comorbidities must use "not_contains"
- ICD-10 format: X##.# (e.g. E11.9). SNOMED: pure numbers. LOINC: ####-# 
- Max 8 inclusion + 6 exclusion criteria — take the most discriminating ones
- parse_confidence: 0.9+ for complete protocol; 0.6-0.9 for partial`

export default withApiHandler(async (req, res, ctx) => {
  const { org, user } = ctx

  if (!SPONSOR_TYPES.includes(org.org_type)) {
    throw new ForbiddenError('Protocol PDF parsing is only available to sponsor organisations.')
  }

  const body = BodySchema.safeParse(req.body)
  if (!body.success) {
    const fe: Record<string, string> = {}
    for (const issue of body.error.issues) fe[issue.path.join('.')] = issue.message
    throw new ValidationError(body.error.issues[0].message, fe)
  }

  const { pdf_base64 } = body.data

  // This route sends the PDF directly to Claude as a native "document"
  // content block — Anthropic-specific, and not something that maps
  // cleanly onto other providers (OpenAI and Google each have their own,
  // different file-handling conventions that would need real, separately
  // -verified implementations, not a rushed guess). Rather than silently
  // ignore an org's configured non-Anthropic provider and use Claude
  // anyway — which would defeat the entire point of letting orgs choose
  // — this respects the org's choice honestly: use their own Anthropic
  // key if that's what they've configured, fall back to the platform
  // default (also Anthropic, unless overridden) if they haven't
  // configured anything, and give a clear, honest error for any other
  // provider rather than a confusing failure or a silent wrong-vendor call.
  const llmConfig = await resolveLLMConfig(org.id)
  if (llmConfig.provider !== 'anthropic') {
    throw new AIServiceError(
      `Direct PDF protocol parsing currently requires Anthropic (this org is configured to use ${llmConfig.provider}). ` +
      `Paste the protocol text instead — that path supports any configured provider — or switch this org back to Anthropic in Settings for PDF upload specifically.`
    )
  }
  const client = new Anthropic({ apiKey: llmConfig.apiKey })

  let parsed: any
  try {
    const response = await client.messages.create({
      model:      llmConfig.model,
      max_tokens: 2000,
      system:     SYSTEM_PROMPT,
      messages:   [{
        role:    'user',
        content: [
          {
            type:   'document',
            source: {
              type:       'base64',
              media_type: 'application/pdf',
              data:       pdf_base64,
            },
          } as any,
          {
            type: 'text',
            text: 'Extract all eligibility criteria from this clinical trial protocol and return the structured JSON.',
          },
        ],
      }],
    })

    const raw = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as any).text)
      .join('')
      .replace(/```json|```/g, '')
      .trim()

    parsed = JSON.parse(raw)
  } catch (e: any) {
    if (e instanceof SyntaxError) {
      throw new AIServiceError('Claude returned unparseable output. Please try again or paste the criteria as text.')
    }
    throw new AIServiceError(e.message)
  }

  // Validate and sanitise output — same functions used by lib/protocol-parser.ts
  const result = {
    title:               parsed.title            || undefined,
    phase:               validatePhase(parsed.phase),
    therapeutic_area:    parsed.therapeutic_area || undefined,
    inclusion_criteria:  sanitiseCriteria(parsed.inclusion_criteria),
    exclusion_criteria:  sanitiseCriteria(parsed.exclusion_criteria),
    mapped_codes:        sanitiseCodes(parsed.mapped_codes),
    raw_criteria_summary:(parsed.raw_criteria_summary || '').slice(0, 500),
    parse_confidence:    Math.min(1, Math.max(0, parsed.parse_confidence ?? 0.8)),
  }

  if (result.inclusion_criteria.length + result.exclusion_criteria.length === 0) {
    throw new AIServiceError('No eligibility criteria could be extracted from this PDF. The document may not contain a standard protocol format.')
  }

  writeAudit({
    action:      'protocol:ai_parsed',
    org_id:      org.id,
    user_id:     user.id,
    entity_type: 'protocols',
    metadata:    {
      source:       'pdf',
      confidence:   result.parse_confidence,
      inc_count:    result.inclusion_criteria.length,
      exc_count:    result.exclusion_criteria.length,
      codes_found:  Object.values(result.mapped_codes).flat().length,
    },
    ip_address: ctx.ipAddress,
  })

  return res.json({ parsed: result })
}, { methods: ['POST'] })
