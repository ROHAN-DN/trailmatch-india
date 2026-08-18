/**
 * pages/api/sponsor/parse-pdf.ts
 * Protocol Parser Agent — PDF support
 *
 * Extracts text from the uploaded PDF (lib/pdf-text-extract.ts), then
 * hands that text to the same lib/protocol-parser.ts pipeline used for
 * pasted-text protocols.
 *
 * This used to send the PDF directly to Claude as a native "document"
 * content block — Anthropic-specific, and the one part of this app's AI
 * usage the earlier multi-provider work couldn't cleanly generalize
 * (OpenAI and Google each have their own, different file-handling
 * conventions, none of them verifiable live from this environment).
 * Extracting text first sidesteps that entirely: whatever provider an
 * org has configured, this now works identically, because by the time
 * any LLM sees it, it's just text — the same guarantee every other part
 * of this multi-provider architecture makes. Real trade-off, stated
 * plainly: Claude's native PDF reading could use visual/layout
 * understanding (tables, multi-column text) that plain text extraction
 * loses. For a typical protocol — mostly prose eligibility criteria —
 * this is unlikely to matter; for one that's primarily a complex table,
 * extraction quality may be worse than Claude reading the PDF directly.
 *
 * POST { pdf_base64: string, media_type: 'application/pdf' }
 * Returns the same ParsedProtocol shape as lib/protocol-parser.ts
 *
 * Size limit: 10MB
 */

import { z } from 'zod'
import { withApiHandler } from '../../../lib/api-handler'
import { extractTextFromPDF, PDFExtractionError } from '../../../lib/pdf-text-extract'
import { parseProtocol } from '../../../lib/protocol-parser'
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

  let extractedText: string
  try {
    extractedText = await extractTextFromPDF(Buffer.from(pdf_base64, 'base64'))
  } catch (e: any) {
    if (e instanceof PDFExtractionError) {
      throw new ValidationError(e.message, { pdf_base64: e.message })
    }
    throw e
  }

  const result = await parseProtocol(extractedText, org.id)

  if (result.inclusion_criteria.length + result.exclusion_criteria.length === 0) {
    throw new AIServiceError('No eligibility criteria could be extracted from this PDF. The document may not contain a standard protocol format, or the AI parse failed — try pasting the protocol text directly instead.')
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
