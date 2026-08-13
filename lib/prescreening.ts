/**
 * lib/prescreening.ts — Production rewrite
 *
 * Generates a personalised pre-screening checklist via Claude.
 * Changes from prototype:
 *   - Confidence scoring per item (0–1)
 *   - Structured JSON output with strict schema validation
 *   - Retry on malformed AI response (up to 2 attempts)
 *   - Fallback checklist never throws
 *   - Indian clinical context baked into prompt (Aadhaar, ABHA, travel within city)
 */

import Anthropic from '@anthropic-ai/sdk'
import type { ChecklistItem, ChecklistCategory } from './types/domain'

export type { ChecklistItem, ChecklistCategory }

export interface PreScreeningInput {
  patient: {
    age:            number
    sex:            string
    diagnosis:      string
    medications?:   string
    labs?:          string
    comorbidities?: string
    ecog_status?:   string
    location?:      string
    language?:      string
  }
  trial: {
    nct_id:           string
    title:            string
    phase:            string
    sponsor?:         string
    criteria_summary: string
    india_sites?:     string
  }
}

export const CATEGORY_LABELS: Record<ChecklistCategory, string> = {
  labs:        'Lab tests & investigations to bring',
  documents:   'Documents to carry',
  medications: 'Medication information needed',
  preparation: 'Day-of preparation',
  questions:   'Questions to ask the PI / site coordinator',
}

const SYSTEM_PROMPT = `You are a clinical research coordinator assistant for TrialMatch India.
You generate pre-screening visit preparation checklists for Indian patients preparing to attend their first clinical trial screening visit.

Return ONLY a valid JSON array. No preamble, no markdown fences, no explanation.
Each element must exactly match this TypeScript type:
{
  "category": "labs" | "documents" | "medications" | "preparation" | "questions",
  "item": string,        // concise action item under 15 words
  "required": boolean,   // true = must have; false = helpful to have
  "notes": string | null, // optional timing/context note, null if none
  "confidence": number   // 0.0 to 1.0 — how confident you are this item applies to this patient
}

IMPORTANT RULES:
- Tailor lab items directly to the trial's eligibility criteria (e.g. if HbA1c threshold mentioned, ask for HbA1c report)
- Always include Aadhaar card and ABHA health ID in documents
- Always include "Complete list of current medications with doses" in medications
- Include 2–4 items per category; max 5 per category
- For questions category: write smart, specific questions about the trial (not generic)
- Use Indian context: mention "city hospital", "nearest CTRI-registered site", ABHA app
- Confidence should reflect how specific the item is to this patient's profile vs generic advice`

export async function generateChecklist(input: PreScreeningInput): Promise<ChecklistItem[]> {
  const client = new Anthropic()

  const userPrompt = `Generate a pre-screening checklist for this patient and trial.

PATIENT:
- Age: ${input.patient.age}y ${input.patient.sex}
- Diagnosis: ${input.patient.diagnosis}
- Medications: ${input.patient.medications || 'Not recorded'}
- Recent labs: ${input.patient.labs || 'Not recorded'}
- Comorbidities: ${input.patient.comorbidities || 'None recorded'}
- ECOG status: ${input.patient.ecog_status || 'Not recorded'}
- Location: ${input.patient.location || 'India'}
- Language preference: ${input.patient.language || 'English'}

TRIAL:
- Title: ${input.trial.title}
- ID: ${input.trial.nct_id}
- Phase: ${input.trial.phase}
- Sponsor: ${input.trial.sponsor || 'Not specified'}
- India sites: ${input.trial.india_sites || 'Not specified'}
- Key eligibility criteria: ${input.trial.criteria_summary}`

  // Up to 2 attempts for malformed responses
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 1500,
        system:     SYSTEM_PROMPT,
        messages:   [{ role:'user', content: userPrompt }],
      })

      const raw = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as any).text)
        .join('')
        .replace(/```json|```/g, '')
        .trim()

      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('Not an array')

      // Validate and sanitise each item
      const items: ChecklistItem[] = []
      for (const item of parsed) {
        if (!item.item || !item.category || typeof item.required !== 'boolean') continue
        const valid: ChecklistItem = {
          category:   validateCategory(item.category),
          item:       String(item.item).slice(0, 120),
          required:   Boolean(item.required),
          notes:      item.notes ? String(item.notes).slice(0, 200) : undefined,
          confidence: typeof item.confidence === 'number'
            ? Math.min(1, Math.max(0, item.confidence))
            : 0.7,
        }
        items.push(valid)
      }

      if (items.length >= 5) return items  // success

    } catch (e) {
      if (attempt === 1) {
        console.error('[prescreening] AI failed after 2 attempts:', e)
      }
    }
  }

  return getDefaultChecklist(input.patient.diagnosis)
}

function validateCategory(raw: any): ChecklistCategory {
  const valid: ChecklistCategory[] = ['labs','documents','medications','preparation','questions']
  return valid.includes(raw) ? raw : 'preparation'
}

function getDefaultChecklist(diagnosis: string): ChecklistItem[] {
  return [
    { category:'labs',        required:true,  item:'Latest complete blood count (CBC) report', confidence:0.9, notes:'Must be within last 3 months' },
    { category:'labs',        required:true,  item:'Recent kidney function test (creatinine, BUN, eGFR)', confidence:0.85 },
    { category:'labs',        required:true,  item:'Liver function test results', confidence:0.85 },
    { category:'labs',        required:false, item:'Any other recent investigations related to your condition', confidence:0.7 },
    { category:'documents',   required:true,  item:'Aadhaar card — original and one photocopy', confidence:1.0 },
    { category:'documents',   required:true,  item:'ABHA health ID card or ABHA app on your phone', confidence:0.95, notes:'Download from Ayushman Bharat app if not already done' },
    { category:'documents',   required:true,  item:'All previous prescription slips and discharge summaries', confidence:1.0 },
    { category:'documents',   required:false, item:'Health insurance card or Ayushman Bharat card', confidence:0.7 },
    { category:'medications', required:true,  item:'Complete list of all current medications with exact doses and brand names', confidence:1.0, notes:'Include vitamins, supplements, and ayurvedic medicines' },
    { category:'medications', required:true,  item:'Do not stop any current medication without PI approval', confidence:1.0 },
    { category:'preparation', required:true,  item:'Arrive at least 30 minutes before your appointment time', confidence:1.0 },
    { category:'preparation', required:false, item:'Bring a family member or carer if possible', confidence:0.7 },
    { category:'questions',   required:false, item:'What are the specific eligibility criteria for this trial?', confidence:1.0 },
    { category:'questions',   required:false, item:'How many visits are required and what is the total duration?', confidence:1.0 },
    { category:'questions',   required:false, item:'Is there any compensation or travel reimbursement?', confidence:0.9 },
  ]
}
