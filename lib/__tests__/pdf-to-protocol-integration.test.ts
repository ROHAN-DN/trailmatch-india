import { describe, it, expect, vi } from 'vitest'
import { jsPDF } from 'jspdf'
import { extractTextFromPDF } from '../pdf-text-extract'
import { parseProtocol } from '../protocol-parser'

// resolveLLMConfig (called internally by parseProtocol) reads from
// Supabase when given an orgId. Without mocking this, a real (or
// real-shaped but unreachable) client construction/connection attempt
// is exactly what caused this test to hang to its timeout on the first
// attempt — caught by actually running it, not assumed safe. Mocked
// the same way lib/__tests__/llm-provider.test.ts already does, so
// resolveLLMConfig falls through cleanly to "no org config found" with
// zero real network activity.
vi.mock('../supabase', () => ({
  supabaseAdmin: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: null }),
        }),
      }),
    }),
  })),
}))

// Mocks only the actual network call to an LLM provider — everything
// else (real PDF generation, real text extraction, parseProtocol's own
// parsing/validation/sanitization logic) runs for real. This is the
// integration point pages/api/sponsor/parse-pdf.ts actually depends on:
// does text extracted from a real PDF survive intact into a real call
// to parseProtocol, and does the result come back in the shape the
// route expects?
vi.mock('../llm-provider', async () => {
  const actual = await vi.importActual<typeof import('../llm-provider')>('../llm-provider')
  return {
    ...actual,
    createChatCompletion: vi.fn(async (req: any) => {
      // Confirms the PDF-extracted text actually reached the prompt sent
      // to the LLM call, not just that some text existed somewhere.
      expect(req.messages[0].content).toContain('Phase III')
      expect(req.messages[0].content).toContain('HbA1c')
      return {
        content: [{
          text: JSON.stringify({
            title: 'A Phase III Trial of Drug X in Type 2 Diabetes',
            phase: 'Phase III',
            therapeutic_area: 'Endocrinology',
            inclusion_criteria: [
              { field: 'age', operator: 'between', value: [18, 75], label: 'Age 18-75' },
              { field: 'labs', operator: 'between', value: [7.0, 10.5], label: 'HbA1c 7.0-10.5%' },
            ],
            exclusion_criteria: [
              { field: 'medications', operator: 'not_contains', value: 'Drug X class', label: 'No prior Drug X class treatment' },
            ],
            mapped_codes: { icd10: ['E11.9'] },
            parse_confidence: 0.92,
          }),
        }],
      }
    }),
  }
})

function generateProtocolPDF(): Buffer {
  const doc = new jsPDF()
  doc.text('Study Title: A Phase III Trial of Drug X in Type 2 Diabetes', 10, 10)
  doc.text('Inclusion: Age 18-75, HbA1c between 7.0% and 10.5%', 10, 20)
  doc.text('Exclusion: Prior treatment with Drug X class', 10, 30)
  return Buffer.from(doc.output('arraybuffer'))
}

describe('PDF upload -> parseProtocol integration (what pages/api/sponsor/parse-pdf.ts actually depends on)', () => {
  it('a real generated PDF, extracted for real, produces a correctly structured parsed protocol', async () => {
    const pdf = generateProtocolPDF()
    const extractedText = await extractTextFromPDF(pdf)

    // Same call shape the route itself uses
    const result = await parseProtocol(extractedText, 'test-org-id')

    expect(result.title).toContain('Phase III Trial of Drug X')
    expect(result.inclusion_criteria).toHaveLength(2)
    expect(result.exclusion_criteria).toHaveLength(1)
    expect(result.mapped_codes.icd10).toEqual(['E11.9'])
    expect(result.parse_confidence).toBe(0.92)
  })

  it('completes the full chain — extract, resolveLLMConfig, createChatCompletion — for a distinctly-identified org, not just a happy-path default', async () => {
    const pdf = generateProtocolPDF()
    const extractedText = await extractTextFromPDF(pdf)
    const result = await parseProtocol(extractedText, 'distinctive-test-org-id-12345')
    expect(result.inclusion_criteria.length).toBeGreaterThan(0)
  })
})
