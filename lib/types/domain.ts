/**
 * lib/types/domain.ts
 * Single source of truth for all TypeScript domain types.
 * Every component, API route, and lib module imports from here.
 *
 * Follows clinical informatics naming conventions where applicable.
 */

// ── Organisations & Users ────────────────────────────────────────────────

export type OrgType =
  | 'hospital'
  | 'academic'
  | 'cro'
  | 'pharma'
  | 'biotech'
  | 'research_center'

export type PlanId = 'trial' | 'starter' | 'pro' | 'enterprise'

export type UserRole = 'owner' | 'admin' | 'coordinator' | 'viewer'

export interface Organization {
  id:            string
  name:          string
  plan:          PlanId
  org_type:      OrgType
  is_sponsor:    boolean
  brand_color?:  string
  city?:         string
  state?:        string
  whatsapp_number?: string
  created_at:    string
  updated_at:    string
}

export interface User {
  id:            string
  org_id:        string
  email:         string
  name?:         string
  role:          UserRole
  phone?:        string
  is_active:     boolean
  created_at:    string
}

// ── Patients ─────────────────────────────────────────────────────────────

export type Sex = 'Male' | 'Female' | 'Other'
export type EcogStatus = 'ECOG 0' | 'ECOG 1' | 'ECOG 2' | 'ECOG 3' | 'ECOG 4' | 'ECOG 5'

export interface Patient {
  id:                string
  org_id:            string
  patient_code:      string
  age:               number
  sex:               Sex
  location:          string
  diagnosis:         string
  stage?:            string
  medications?:      string
  labs?:             string
  comorbidities?:    string
  prior_treatments?: string
  biomarkers?:       string
  allergies?:        string
  ecog_status?:      EcogStatus | string
  notes?:            string
  language_preference?: string
  consent_given:     boolean
  consent_date?:     string
  abha_id?:          string
  is_archived:       boolean
  data_retention_date?: string
  created_at:        string
  updated_at:        string
}

export type PatientCreate = Omit<Patient,
  'id' | 'org_id' | 'is_archived' | 'created_at' | 'updated_at'
>

export type PatientUpdate = Partial<PatientCreate>

// ── Trials & Matching ────────────────────────────────────────────────────

export type MatchStrength = 'STRONG' | 'PARTIAL' | 'LOW'

export type EnrollmentStatus =
  | 'pending'
  | 'pi_contacted'
  | 'screened'
  | 'enrolled'
  | 'screen_failed'
  | 'withdrawn'
  | 'completed'

export interface TrialMatch {
  rank:               number
  matchStrength:      MatchStrength
  matchScore:         number
  source:             'ClinicalTrials.gov' | 'CTRI'
  nctId:              string
  ctriId?:            string
  title:              string
  phase:              string
  sponsor:            string
  indiaSites:         string
  status:             string
  plainSummary:       string
  criteriaMet:        string[]
  criteriaPartial:    string[]
  criteriaFail:       string[]
  nextSteps:          string
  /** Detailed eligibility breakdown for pre-screening checklist generation */
  eligibilityDetails?: {
    criterion:  string
    status:     'met' | 'partial' | 'unmet' | 'unknown'
    detail?:    string
  }[]
  /**
   * Per-criterion deterministic evaluation results — computed in code
   * (lib/eligibility-rules.ts) against the patient's real structured
   * clinical data, never judged by the model. `extractionSource` says
   * whether the criterion itself came from the zero-LLM regex/dictionary
   * pass (lib/rule-based-extraction.ts) or from Claude's residual
   * extraction of text the rule-based pass couldn't parse — either way,
   * the PASS/FAIL/UNKNOWN result is always computed deterministically,
   * never asked of the model.
   *
   * Optional because this field did not exist on rows written before this
   * type was extended to include it — match_results.matches is stored as
   * JSONB and already contained this data from lib/matcher.ts's own local
   * TrialMatch type (the two had drifted apart; this brings the shared
   * type back in sync with what the matcher actually produces and always
   * has, rather than changing what's stored).
   */
  deterministicResults?: Array<{
    description:      string
    category:         string
    result:           'PASS' | 'FAIL' | 'UNKNOWN'
    evidence:         string
    extractionSource: 'rule_based' | 'ai_extracted'
  }>
}

/**
 * Per-source live-fetch outcome for a match run. 'error' means the
 * registry could not be reached — distinct from a genuine zero-result
 * search. See lib/matcher.ts for why this distinction is load-bearing:
 * it's what replaced the old "AI-Synthesised" fabricated-trial fallback.
 */
export interface SourceStatus {
  ctgov:       'ok' | 'error'
  ctri:        'ok' | 'error'
  ctgovError?: string
  ctriError?:  string
}

export interface MatchJobResult {
  id:                string
  org_id:            string
  job_id:            string
  patient_id:        string
  status:            'pending' | 'running' | 'done' | 'failed'
  matches:           TrialMatch[]
  summary:           string
  trials_searched:   number
  enrollment_status: EnrollmentStatus
  source_status?:    SourceStatus
  created_at:        string
  updated_at:        string
  patients?:         Patient
}

// ── PI Contacts ──────────────────────────────────────────────────────────

export interface PIContact {
  id:                    string
  nct_id:                string
  pi_name:               string
  pi_email?:             string
  pi_phone?:             string
  pi_institution:        string
  specialty?:            string
  city?:                 string
  state?:                string
  response_rate?:        number  // 0-1
  avg_response_hours?:   number
  verified:              boolean
  last_verified_at?:     string
}

// ── India Site Profiles (Site Twin Network) ──────────────────────────────

export type SiteType = 'hospital' | 'academic' | 'cro' | 'research_center' | 'government'

export interface IndiaSiteProfile {
  id:                    string
  org_id?:               string
  institution_name:      string
  city?:                 string
  state?:                string
  site_type:             SiteType
  specialties:           string[]
  active_trials:         number
  pi_count:              number
  total_patients:        number
  avg_enrollment_rate?:  number
  avg_dropout_rate?:     number
  avg_startup_days?:     number
  is_partner:            boolean
  is_verified:           boolean
  ctgov_nct_ids:         string[]
  created_at:            string
  updated_at:            string
}

// ── Pre-screening Checklists ─────────────────────────────────────────────

export type ChecklistCategory =
  | 'labs'
  | 'documents'
  | 'medications'
  | 'preparation'
  | 'questions'

export type ChecklistStatus = 'generated' | 'reviewed' | 'completed'

export interface ChecklistItem {
  category:   ChecklistCategory
  item:       string
  required:   boolean
  notes?:     string
  /** AI confidence that this item applies to this patient (0-1) */
  confidence?: number
}

export interface PrescreeningChecklist {
  id:               string
  org_id:           string
  match_result_id:  string
  patient_id:       string
  nct_id:           string
  trial_title?:     string
  checklist:        ChecklistItem[]
  status:           ChecklistStatus
  generated_at:     string
  reviewed_at?:     string
  reviewed_by?:     string
}

// ── Protocols (Sponsor Portal) ───────────────────────────────────────────

export type ProtocolPhase =
  | 'Phase I'
  | 'Phase II'
  | 'Phase III'
  | 'Phase IV'
  | 'Phase I/II'
  | 'Phase II/III'

export type ProtocolStatus = 'draft' | 'active' | 'archived'

export type FeasibilityCriterionField =
  | 'diagnosis'
  | 'age'
  | 'labs'
  | 'medications'
  | 'comorbidities'
  | 'biomarkers'
  | 'ecog_status'
  | 'sex'

export type FeasibilityCriterionOperator =
  | 'contains'
  | 'not_contains'
  | 'gte'
  | 'lte'
  | 'between'
  | 'equals'

export interface FeasibilityCriterion {
  field:     FeasibilityCriterionField
  operator:  FeasibilityCriterionOperator
  value:     string | number | [number, number]
  label:     string
}

export interface MappedCodes {
  icd10:   string[]   // e.g. ["E11.9"] — ICD-10-CM
  snomed:  string[]   // e.g. ["44054006"] — SNOMED CT
  loinc:   string[]   // e.g. ["4548-4"] — LOINC lab codes
}

export interface Protocol {
  id:                  string
  org_id:              string
  created_by:          string
  title:               string
  phase?:              ProtocolPhase
  therapeutic_area?:   string
  inclusion_criteria:  FeasibilityCriterion[]
  exclusion_criteria:  FeasibilityCriterion[]
  raw_text?:           string
  parsed_by_ai:        boolean
  mapped_codes:        MappedCodes
  status:              ProtocolStatus
  created_at:          string
  updated_at:          string
}

export interface ProtocolCreate {
  title:               string
  raw_text?:           string
  phase?:              ProtocolPhase
  therapeutic_area?:   string
  inclusion_criteria?: FeasibilityCriterion[]
  exclusion_criteria?: FeasibilityCriterion[]
  parse_with_ai?:      boolean
}

// ── Site Engagement Requests ─────────────────────────────────────────────

export type EngagementStatus =
  | 'requested'
  | 'coordinator_notified'
  | 'interested'
  | 'declined'
  | 'meeting_booked'
  | 'closed'

export interface SiteEngagementRequest {
  id:                    string
  protocol_id:           string
  sponsor_org_id:        string
  site_org_id?:          string
  site_profile_id?:      string
  status:                EngagementStatus
  sponsor_message?:      string
  coordinator_response?: string
  notified_via:          'whatsapp' | 'email' | 'both'
  notified_at?:          string
  responded_at?:         string
  created_at:            string
  updated_at:            string
  // Joined fields
  protocols?:            Pick<Protocol, 'title' | 'phase' | 'therapeutic_area'>
  india_site_profiles?:  Pick<IndiaSiteProfile, 'institution_name' | 'city' | 'state'>
}

// ── Feasibility ──────────────────────────────────────────────────────────

export type FeasibilityConfidence = 'high' | 'medium' | 'low'

export interface FeasibilityBreakdownStep {
  criterion:       string
  count:           number
  pct_of_previous: number
}

export interface FeasibilityResult {
  org_id:                  string
  org_name:                string
  city?:                   string
  total_patients_at_site:  number
  qualifying_count:        number
  confidence:              FeasibilityConfidence
  breakdown:               FeasibilityBreakdownStep[]
  disclaimer:              string
}

// ── Enrollment Monitor ───────────────────────────────────────────────────

export type MonitorAlertType =
  | 'no_contact'
  | 'competing_trial_opened'
  | 'pace_warning'
  | 'screen_failure_spike'

export interface EnrollmentMonitorTask {
  id:                         string
  org_id:                     string
  match_result_id:            string
  patient_id:                 string
  nct_id:                     string
  enrollment_status:          EnrollmentStatus
  last_status_change:         string
  days_in_status:             number
  alert_if_no_contact_hours:  number
  alert_on_competing_trial:   boolean
  last_alert_type?:           MonitorAlertType
  last_alerted_at?:           string
  alert_count:                number
  is_active:                  boolean
  created_at:                 string
}

// ── Audit ────────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id:            string
  org_id?:       string
  user_id?:      string
  action:        string
  entity_type?:  string
  entity_id?:    string
  before_state?: Record<string, any>
  after_state?:  Record<string, any>
  ip_address?:   string
  outcome:       'success' | 'failure' | 'partial'
  error_code?:   string
  metadata?:     Record<string, any>
  created_at:    string
}

// ── API response shapes ──────────────────────────────────────────────────

export interface ApiError {
  code:     string
  message:  string
  details?: Record<string, any>
}

export interface PaginatedResponse<T> {
  data:         T[]
  total:        number
  page:         number
  page_size:    number
  total_pages:  number
}

// ── Notifications ────────────────────────────────────────────────────────

export interface SendWhatsAppInput {
  to:       string   // E.164 format: +91XXXXXXXXXX
  message:  string
}

export interface SendEmailInput {
  to:       string
  subject:  string
  html:     string
  text?:    string
}

// ── Structured clinical entities (migration 017) ───────────────────────────
// Additive alongside Patient's existing free-text fields (labs, medications,
// biomarkers, comorbidities, allergies) above — those are not removed or
// deprecated by this. A patient may have data in the free-text fields, the
// structured tables below, or both, until the intake form and matcher are
// updated to prefer structured data (separate, later work — see migration
// 017's own header comment for why this is deliberately staged).
//
// Each interface mirrors its table 1:1. `source` tracks provenance —
// distinguishing what a coordinator typed manually from what arrived via
// FHIR/ABDM/HMS import matters for trust and for knowing what's safe to
// silently overwrite on a re-import vs. what a human entered deliberately.

export type ClinicalDataSource = 'manual' | 'fhir' | 'abdm' | 'hms_import'

export interface PatientLab {
  id:              string
  org_id:          string
  patient_id:      string
  test_name:       string
  test_code?:      string   // LOINC code, once mapped — see lib/fhir.ts's LOINC_MAP
  value_numeric?:  number
  value_text?:     string
  unit?:           string
  reference_range?: string
  collected_date?: string
  source:          ClinicalDataSource
  created_by?:     string
  created_at:      string
}

export interface PatientMedication {
  id:          string
  org_id:      string
  patient_id:  string
  name:        string
  dose?:       string
  frequency?:  string
  status:      'active' | 'discontinued' | 'unknown'
  start_date?: string
  end_date?:   string
  source:      ClinicalDataSource
  created_by?: string
  created_at:  string
}

export interface PatientBiomarker {
  id:           string
  org_id:       string
  patient_id:   string
  marker:       string
  status:       'positive' | 'negative' | 'unknown' | 'not_tested'
  value?:       string
  tested_date?: string
  source:       ClinicalDataSource
  created_by?:  string
  created_at:   string
}

export interface PatientComorbidity {
  id:             string
  org_id:         string
  patient_id:     string
  condition:      string
  icd10_code?:    string
  status:         'active' | 'resolved' | 'unknown'
  diagnosed_date?: string
  source:         ClinicalDataSource
  created_by?:    string
  created_at:     string
}

export interface PatientAllergy {
  id:          string
  org_id:      string
  patient_id:  string
  substance:   string
  reaction?:   string
  severity:    'mild' | 'moderate' | 'severe' | 'unknown'
  source:      ClinicalDataSource
  created_by?: string
  created_at:  string
}

/** A patient with all structured clinical entities loaded — the shape a
 *  future deterministic rule evaluator (and eventually the matcher) will
 *  consume. Not yet produced anywhere; this is the target shape. */
export interface PatientWithClinicalData extends Patient {
  structured_labs:          PatientLab[]
  structured_medications:   PatientMedication[]
  structured_biomarkers:    PatientBiomarker[]
  structured_comorbidities: PatientComorbidity[]
  structured_allergies:     PatientAllergy[]
}
