import { Resend } from 'resend'
import type { Patient, MatchResult } from './matcher'

// REAL BUG FOUND AND FIXED HERE (same class as lib/supabase.ts and
// pages/api/auth/[...nextauth].ts): `new Resend(undefined)` throws
// synchronously — "Missing API key" — confirmed directly against the
// installed SDK. This file's top-level, eager `const resend = new
// Resend(...)` crashed `next build` the moment this module was
// imported without RESEND_API_KEY set, exactly like the Supabase
// cases. Fixed with the same lazy-factory pattern used throughout this
// codebase (see lib/supabase.ts's supabaseAdmin).
const resendClient = () => new Resend(process.env.RESEND_API_KEY)

interface SendReportOptions {
  to:        string
  patient:   Patient
  result:    MatchResult
  pdfBuffer: Buffer
  orgName?:  string
  brandColor?: string
}

export async function sendMatchReport({
  to, patient, result, pdfBuffer, orgName = 'TrialMatch India', brandColor = '#0F6E56'
}: SendReportOptions) {
  const strong  = result.matches.filter(m => m.matchStrength === 'STRONG').length
  const partial = result.matches.filter(m => m.matchStrength === 'PARTIAL').length
  const top     = result.matches[0]

  const matchRows = result.matches.slice(0, 3).map(m => {
    const badgeColor = m.matchStrength === 'STRONG' ? '#0F6E56' : m.matchStrength === 'PARTIAL' ? '#BA7517' : '#888780'
    const badgeBg    = m.matchStrength === 'STRONG' ? '#E1F5EE' : m.matchStrength === 'PARTIAL' ? '#FEF3E2' : '#F1EFE8'
    return `
      <tr style="border-bottom:1px solid #E2E0D8">
        <td style="padding:10px 12px;font-size:13px;color:#1C1B18;line-height:1.4">${m.title.slice(0, 60)}${m.title.length > 60 ? '…' : ''}</td>
        <td style="padding:10px 12px;font-size:11px;color:#72706A">${m.phase} · ${m.indiaSites}</td>
        <td style="padding:10px 12px;text-align:center">
          <span style="background:${badgeBg};color:${badgeColor};font-size:10px;font-weight:600;padding:3px 9px;border-radius:99px;letter-spacing:.04em">${m.matchStrength}</span>
        </td>
        <td style="padding:10px 12px;font-size:13px;font-weight:600;color:${badgeColor};text-align:right">${m.matchScore}%</td>
      </tr>`
  }).join('')

  await resendClient().emails.send({
    from:    process.env.RESEND_FROM_EMAIL!,
    to,
    subject: `Trial match report — ${patient.patient_code} (${patient.diagnosis})`,
    attachments: [{
      filename:    `TrialMatch_${patient.patient_code}_${patient.diagnosis.split(' ')[0]}.pdf`,
      content:     pdfBuffer.toString('base64'),
    }],
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#F7F6F2;font-family:sans-serif">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #E2E0D8">

  <!-- Header -->
  <div style="background:${brandColor};padding:20px 24px">
    <h1 style="margin:0;font-size:18px;font-weight:500;color:#fff;letter-spacing:-.2px">${orgName}</h1>
    <p style="margin:4px 0 0;font-size:12px;color:rgba(255,255,255,.6);letter-spacing:.06em;text-transform:uppercase">Clinical Trial Match Report</p>
  </div>

  <!-- Patient summary card -->
  <div style="padding:20px 24px;border-bottom:1px solid #E2E0D8">
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="width:50%;vertical-align:top">
          <div style="font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#72706A;margin-bottom:4px">Patient</div>
          <div style="font-size:15px;font-weight:500;color:#1C1B18">${patient.patient_code}</div>
          <div style="font-size:13px;color:#72706A;margin-top:2px">${patient.age}y · ${patient.sex} · ${patient.location}</div>
        </td>
        <td style="width:50%;vertical-align:top;text-align:right">
          <div style="font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#72706A;margin-bottom:4px">Diagnosis</div>
          <div style="font-size:14px;font-weight:500;color:#1C1B18">${patient.diagnosis}</div>
          <div style="font-size:12px;color:#72706A;margin-top:2px">${patient.stage || 'Stage not specified'}</div>
        </td>
      </tr>
    </table>
  </div>

  <!-- Stats row -->
  <div style="display:flex;padding:16px 24px;border-bottom:1px solid #E2E0D8;gap:0;background:#F7F6F2">
    ${[
      ['Trials screened', result.trialsSearched || 0, '#1C1B18'],
      ['Strong matches', strong, '#0F6E56'],
      ['Partial matches', partial, '#BA7517'],
    ].map(([label, val, color]) => `
      <div style="flex:1;text-align:center">
        <div style="font-size:22px;font-weight:500;color:${color}">${val}</div>
        <div style="font-size:10px;color:#72706A;margin-top:3px;text-transform:uppercase;letter-spacing:.05em">${label}</div>
      </div>`).join('<div style="width:1px;background:#E2E0D8"></div>')}
  </div>

  <!-- AI summary -->
  <div style="padding:18px 24px;border-bottom:1px solid #E2E0D8">
    <div style="background:#E1F5EE;border-left:3px solid #1D9E75;padding:12px 14px;border-radius:0 8px 8px 0">
      <p style="margin:0;font-size:13px;color:#085041;line-height:1.6">${result.summary}</p>
    </div>
  </div>

  <!-- Match table -->
  <div style="padding:18px 24px;border-bottom:1px solid #E2E0D8">
    <h3 style="margin:0 0 12px;font-size:13px;font-weight:600;color:#1C1B18">Top matched trials</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#F7F6F2">
          <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#72706A">Trial</th>
          <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#72706A">Phase · Sites</th>
          <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#72706A">Match</th>
          <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#72706A">Score</th>
        </tr>
      </thead>
      <tbody>${matchRows}</tbody>
    </table>
  </div>

  <!-- CTA -->
  <div style="padding:20px 24px;text-align:center">
    <p style="margin:0 0 14px;font-size:13px;color:#72706A;line-height:1.6">
      The full detailed report with eligibility criteria breakdown, next steps, and coordinator checklist is attached as a PDF.
    </p>
    <div style="font-size:11px;color:#B4B2A9;margin-top:14px;line-height:1.6">
      This report is AI-assisted decision support only.<br/>
      Final eligibility must be confirmed by the Principal Investigator at each trial site.
    </div>
  </div>

</div>
<p style="text-align:center;font-size:11px;color:#B4B2A9;margin:12px 0 32px">
  Sent by ${orgName} via TrialMatch India
</p>
</body>
</html>`,
  })
}

// ── Generic transactional email send ─────────────────────────────────────
// Used by engagement notifications, enrollment alerts, team invites override,
// and anywhere a plain HTML email is needed without a PDF attachment.
export interface SendEmailOptions {
  to:       string
  subject:  string
  html:     string
  text?:    string
  from?:    string
}

export async function sendEmail({ to, subject, html, text, from }: SendEmailOptions) {
  await resendClient().emails.send({
    from:    from || process.env.RESEND_FROM_EMAIL!,
    to,
    subject,
    html,
    ...(text ? { text } : {}),
  })
}
