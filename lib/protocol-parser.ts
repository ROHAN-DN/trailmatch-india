/**
 * lib/protocol-parser.ts — Production rewrite
 *
 * Key changes:
 *  - Strict JSON schema validation on output
 *  - ICD-10/LOINC/SNOMED code validation (pattern check, not hallucination)
 *  - Retry on malformed output
 *  - Confidence score on parsed criteria
 *  - Handles both text paste and pre-extracted PDF text
 */

import { createChatCompletion, resolveLLMConfig } from './llm-provider'
import type { FeasibilityCriterion, MappedCodes, ProtocolPhase } from './types/domain'

export interface ParsedProtocol {
  title?:              string
  phase?:              ProtocolPhase
  therapeutic_area?:   string
  inclusion_criteria:  FeasibilityCriterion[]
  exclusion_criteria:  FeasibilityCriterion[]
  mapped_codes:        MappedCodes
  raw_criteria_summary: string
  parse_confidence:    number   // 0–1: how confident the AI was about the parse
}

const VALID_FIELDS    = ['diagnosis','age','labs','medications','comorbidities','biomarkers','ecog_status','sex']
const VALID_OPERATORS = ['contains','not_contains','gte','lte','between','equals']

const SYSTEM_PROMPT = `You are a clinical data extraction expert specialising in clinical trial protocols.
Parse the provided protocol text and return ONLY a valid JSON object. No markdown, no explanation.

Output schema:
{
  "title": "trial title or null",
  "phase": "Phase I" | "Phase II" | "Phase III" | "Phase IV" | "Phase I/II" | "Phase II/III" | null,
  "therapeutic_area": "concise area name e.g. Type 2 Diabetes Mellitus, Oncology",
  "inclusion_criteria": [
    {
      "field": "diagnosis"|"age"|"labs"|"medications"|"comorbidities"|"biomarkers"|"ecog_status"|"sex",
      "operator": "contains"|"not_contains"|"gte"|"lte"|"between"|"equals",
      "value": "string or number or [min,max] for between",
      "label": "concise human-readable criterion under 12 words"
    }
  ],
  "exclusion_criteria": [ /* same schema */ ],
  "mapped_codes": {
    "icd10": ["E11.9"],
    "snomed": ["44054006"],
    "loinc": ["4548-4"]
  },
  "raw_criteria_summary": "2-3 sentence plain-English summary of who qualifies for this trial",
  "parse_confidence": 0.0-1.0
}

RULES:
- For age criteria, use "between" with value=[min,max] or "gte"/"lte" with numeric value
- For exclusion medications/comorbidities, always use "not_contains"
- Only include LOINC codes for labs explicitly mentioned by name in the protocol
- ICD-10 codes must follow X##.# format (e.g. E11.9, C34.1, I10)
- SNOMED codes must be pure numbers (e.g. 44054006)
- Maximum 8 inclusion criteria, 6 exclusion criteria — prioritise the most discriminating ones
- parse_confidence: 0.9+ = full protocol text; 0.6-0.9 = partial/summary; below 0.6 = very sparse input`

export async function parseProtocol(rawText: string, orgId?: string): Promise<ParsedProtocol> {
  if (!rawText?.trim() || rawText.trim().length < 50) {
    return emptyProtocol('Input text too short to parse.')
  }

  const llmConfig = await resolveLLMConfig(orgId)
  const trimmed = rawText.slice(0, 12_000)   // ~3k tokens — enough for any protocol section

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await createChatCompletion({
        max_tokens: 2000,
        system:     SYSTEM_PROMPT,
        messages:   [{ role:'user', content: `Parse this clinical trial protocol:\n\n${trimmed}` }],
      }, llmConfig)

      const raw = response.content
        .map(b => b.text || '')
        .join('')
        .replace(/```json|```/g, '')
        .trim()

      const parsed = JSON.parse(raw)

      // Validate and sanitise
      const result: ParsedProtocol = {
        title:              parsed.title   || undefined,
        phase:              validatePhase(parsed.phase),
        therapeutic_area:  parsed.therapeutic_area || undefined,
        inclusion_criteria: sanitiseCriteria(parsed.inclusion_criteria),
        exclusion_criteria: sanitiseCriteria(parsed.exclusion_criteria),
        mapped_codes:       sanitiseCodes(parsed.mapped_codes),
        raw_criteria_summary: (parsed.raw_criteria_summary || '').slice(0, 500),
        parse_confidence:   clamp(parsed.parse_confidence ?? 0.7, 0, 1),
      }

      // Must have at least something useful
      if (result.inclusion_criteria.length + result.exclusion_criteria.length === 0) {
        if (attempt === 0) continue   // retry
        return emptyProtocol('No criteria could be extracted. Please add criteria manually.')
      }

      return result
    } catch (e) {
      if (attempt === 1) {
        console.error('[protocol-parser] Failed after 2 attempts:', e)
      }
    }
  }

  return emptyProtocol('AI parsing failed. You can add criteria manually.')
}

export function summariseProtocol(p: ParsedProtocol): string {
  const parts = [
    p.therapeutic_area || 'Unknown indication',
    p.phase || 'Phase unknown',
    `${p.inclusion_criteria.length} inclusion + ${p.exclusion_criteria.length} exclusion criteria`,
    p.parse_confidence >= 0.9 ? 'Full parse' : p.parse_confidence >= 0.6 ? 'Partial parse' : 'Sparse input',
  ]
  return parts.join(' · ')
}

// ── Validators (exported so parse-pdf.ts can reuse without duplication) ────
export function sanitiseCriteria(raw: any): FeasibilityCriterion[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(c => c && VALID_FIELDS.includes(c.field) && VALID_OPERATORS.includes(c.operator) && c.value !== undefined && c.label)
    .map(c => ({
      field:    c.field,
      operator: c.operator,
      value:    c.value,
      label:    String(c.label).slice(0, 120),
    }))
    .slice(0, 10)
}

export function sanitiseCodes(raw: any): MappedCodes {
  if (!raw || typeof raw !== 'object') return { icd10:[], snomed:[], loinc:[] }
  return {
    icd10:  (raw.icd10  || []).filter((c: string) => /^[A-Z]\d{2}(\.\d{1,4})?$/.test(String(c))).slice(0, 10),
    snomed: (raw.snomed || []).filter((c: string) => /^\d{6,18}$/.test(String(c))).slice(0, 10),
    loinc:  (raw.loinc  || []).filter((c: string) => /^\d{1,5}-\d$/.test(String(c))).slice(0, 10),
  }
}

const VALID_PHASES: ProtocolPhase[] = ['Phase I','Phase II','Phase III','Phase IV','Phase I/II','Phase II/III']
export function validatePhase(raw: any): ProtocolPhase | undefined {
  return VALID_PHASES.includes(raw) ? raw : undefined
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function emptyProtocol(summary: string): ParsedProtocol {
  return {
    inclusion_criteria:  [],
    exclusion_criteria:  [],
    mapped_codes:        { icd10:[], snomed:[], loinc:[] },
    raw_criteria_summary: summary,
    parse_confidence:    0,
  }
}
