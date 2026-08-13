/**
 * lib/hms-export.ts
 * Insta HMS Integration — Phase 2 (Weeks 12-13)
 *
 * Exports TrialMatch patient match data in the CSV format expected by
 * Insta HMS (Hospital Management System used widely in South India).
 *
 * The export is one-way (TrialMatch → Insta HMS).
 * Each row = one patient with their top match result.
 * No PII beyond what the coordinator explicitly exports.
 */

export interface HMSExportRow {
  patient_code:      string
  diagnosis:         string
  age:               number
  sex:               string
  location:          string
  top_trial_id:      string
  top_trial_title:   string
  match_strength:    string
  enrollment_status: string
  pi_name?:          string
  pi_institution?:   string
  pi_phone?:         string
  match_date:        string
}

/**
 * Converts TrialMatch match result data into Insta HMS-compatible CSV rows.
 * The column headers match Insta HMS's clinical_trial_referrals import template.
 */
export function buildHMSExportRows(
  matchResults: any[],
  piContacts: Record<string, any>   // keyed by nct_id
): HMSExportRow[] {
  return matchResults
    .filter(r => r.status === 'done' && r.matches?.length)
    .map(r => {
      const topMatch = r.matches[0]
      const pi       = topMatch?.nctId ? piContacts[topMatch.nctId] : null
      return {
        patient_code:      r.patients?.patient_code || '',
        diagnosis:         r.patients?.diagnosis    || '',
        age:               r.patients?.age          || 0,
        sex:               r.patients?.sex          || '',
        location:          r.patients?.location     || '',
        top_trial_id:      topMatch?.nctId          || '',
        top_trial_title:   topMatch?.title          || '',
        match_strength:    topMatch?.matchStrength  || '',
        enrollment_status: r.enrollment_status      || 'pending',
        pi_name:           pi?.pi_name,
        pi_institution:    pi?.pi_institution,
        pi_phone:          pi?.pi_phone,
        match_date:        r.created_at
          ? new Date(r.created_at).toLocaleDateString('en-IN')
          : '',
      }
    })
}

/**
 * Converts rows to CSV string.
 * Insta HMS expects UTF-8 with BOM for Indian characters.
 */
export function rowsToCSV(rows: HMSExportRow[]): string {
  const HEADERS = [
    'Patient Code',
    'Primary Diagnosis',
    'Age',
    'Sex',
    'Location',
    'Trial ID (NCT/CTRI)',
    'Trial Title',
    'Match Strength',
    'Enrollment Status',
    'PI Name',
    'PI Institution',
    'PI Phone',
    'Match Date',
  ]

  const escape = (v: any) => {
    const s = String(v ?? '')
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }

  const lines = [
    HEADERS.join(','),
    ...rows.map(r =>
      [
        r.patient_code,
        r.diagnosis,
        r.age,
        r.sex,
        r.location,
        r.top_trial_id,
        r.top_trial_title,
        r.match_strength,
        r.enrollment_status,
        r.pi_name     ?? '',
        r.pi_institution ?? '',
        r.pi_phone    ?? '',
        r.match_date,
      ].map(escape).join(',')
    ),
  ]

  // UTF-8 BOM for Excel / Insta HMS compatibility
  return '\uFEFF' + lines.join('\r\n')
}
