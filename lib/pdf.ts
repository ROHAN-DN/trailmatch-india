// Server-side PDF generation using jsPDF
// Called from /api/reports/generate
//
// Phase 2: added optional prescreening checklist appendix section
// (Week 8-9: "Included in PDF report as new section")

import { jsPDF } from 'jspdf'
import type { Patient, MatchResult } from './matcher'
import type { ChecklistItem } from './prescreening'

export interface PDFOptions {
  prescreening?: {
    nct_id:       string
    trial_title:  string
    checklist:    ChecklistItem[]
    status:       string
  }
}

const CATEGORY_ICONS: Record<string, string> = {
  labs:        'Lab tests to bring',
  documents:   'Documents to carry',
  medications: 'Medication information',
  preparation: 'Day-of preparation',
  questions:   'Questions for the PI',
}

export function generateReportPDF(patient: Patient, result: MatchResult, options?: PDFOptions): Buffer {
  const doc  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const pw   = 210, ml = 14, mr = 14, cw = 210 - ml - mr
  let y      = 14

  const TEAL    = [15, 110, 86]  as [number,number,number]
  const TEALM   = [29, 158, 117] as [number,number,number]
  const TEALL   = [225, 245, 238] as [number,number,number]
  const AMBER   = [186, 117, 23]  as [number,number,number]
  const AMBERL  = [254, 238, 218] as [number,number,number]
  const REDL    = [254, 240, 238] as [number,number,number]
  const RED     = [181, 48, 48]   as [number,number,number]
  const GRAY    = [245, 244, 242] as [number,number,number]
  const BORDER  = [226, 224, 216] as [number,number,number]
  const TEXT    = [28, 27, 24]    as [number,number,number]
  const MUTED   = [114, 112, 106] as [number,number,number]
  const GREEN_BG = [234, 243, 222] as [number,number,number]
  const GREEN_FG = [39, 80, 10]    as [number,number,number]
  const WHITE   = [255, 255, 255] as [number,number,number]

  function checkPage(need: number) {
    if (y + need > 285) { doc.addPage(); y = 14 }
  }

  // Header
  doc.setFillColor(...TEAL); doc.rect(0, 0, pw, 15, 'F')
  doc.setTextColor(...WHITE); doc.setFontSize(13); doc.setFont('helvetica', 'bold')
  doc.text('TrialMatch India — Patient Match Report', ml, 9.5)
  doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(200, 235, 225)
  doc.text('CONFIDENTIAL — AI Decision Support Only', pw - mr, 9.5, { align: 'right' })
  y = 20

  const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

  // Patient meta
  doc.setFillColor(...GRAY); doc.rect(ml, y, cw, 20, 'F')
  doc.setDrawColor(...BORDER); doc.rect(ml, y, cw, 20, 'D')
  doc.setTextColor(...MUTED); doc.setFontSize(7); doc.setFont('helvetica', 'bold')
  doc.text('PATIENT CODE', ml + 2, y + 4)
  doc.text('DIAGNOSIS', ml + 45, y + 4)
  doc.text('AGE / SEX', ml + 110, y + 4)
  doc.text('LOCATION', ml + 145, y + 4)
  doc.setTextColor(...TEXT); doc.setFontSize(9); doc.setFont('helvetica', 'bold')
  doc.text(patient.patient_code, ml + 2, y + 11)
  doc.setFont('helvetica', 'normal')
  doc.text((patient.diagnosis || '').slice(0, 32), ml + 45, y + 11)
  doc.text(`${patient.age}y / ${patient.sex}`, ml + 110, y + 11)
  doc.text((patient.location || '').slice(0, 22), ml + 145, y + 11)
  doc.setTextColor(...MUTED); doc.setFontSize(7.5)
  doc.text(`Meds: ${(patient.medications || 'None').slice(0, 50)}  |  Labs: ${(patient.labs || 'NR').slice(0, 40)}`, ml + 2, y + 17)
  y += 24

  // Summary
  checkPage(20)
  const sumLines = doc.splitTextToSize(result.summary || '', cw - 8)
  const sumH = sumLines.length * 4.5 + 8
  doc.setFillColor(...TEALL); doc.rect(ml, y, cw, sumH, 'F')
  doc.setFillColor(...TEALM); doc.rect(ml, y, 2, sumH, 'F')
  doc.setTextColor(...TEAL); doc.setFontSize(8); doc.setFont('helvetica', 'normal')
  doc.text(sumLines, ml + 4, y + 5)
  // Quick stats
  const strong  = result.matches.filter(m => m.matchStrength === 'STRONG').length
  const partial = result.matches.filter(m => m.matchStrength === 'PARTIAL').length
  doc.setFontSize(7); doc.setTextColor(...MUTED)
  doc.text(`Screened: ${result.trialsSearched || 0}  |  CT.gov: ${result.ctgovCount || 0}  |  CTRI: ${result.ctriCount || 0}  |  Strong: ${strong}  |  Partial: ${partial}`, ml + 4, y + sumH - 3)
  y += sumH + 4

  // Matches
  for (const m of result.matches) {
    const matchBg  = m.matchStrength === 'STRONG' ? TEALL : m.matchStrength === 'PARTIAL' ? AMBERL : GRAY
    const matchFg  = m.matchStrength === 'STRONG' ? TEAL  : m.matchStrength === 'PARTIAL' ? AMBER  : MUTED
    const badgeTxt = m.matchStrength === 'STRONG' ? 'STRONG' : m.matchStrength === 'PARTIAL' ? 'PARTIAL' : 'LOW'

    checkPage(40)

    // Trial header
    doc.setFillColor(...matchBg); doc.rect(ml, y, cw, 9, 'F')
    doc.setTextColor(...matchFg); doc.setFontSize(10); doc.setFont('helvetica', 'bold')
    doc.text(`#${m.rank}`, ml + 2, y + 6.3)
    doc.setFontSize(8.5)
    doc.text((m.title || '').slice(0, 72), ml + 10, y + 6.3)
    doc.setFillColor(...matchFg); doc.roundedRect(ml + cw - 28, y + 1.5, 26, 6, 1, 1, 'F')
    doc.setTextColor(...WHITE); doc.setFontSize(7)
    doc.text(badgeTxt, ml + cw - 15, y + 5.8, { align: 'center' })
    y += 11

    // Meta row
    const metaItems = [
      ['PHASE', m.phase || 'NR'],
      ['SPONSOR', (m.sponsor || '').slice(0, 30)],
      ['SITES', (m.indiaSites || 'India').slice(0, 25)],
      ['SCORE', `${m.matchScore}%`],
    ]
    const mw = cw / 4
    doc.setDrawColor(...BORDER)
    metaItems.forEach(([label, val], i) => {
      const mx = ml + i * mw
      doc.setFillColor(...GRAY); doc.rect(mx, y, mw, 10, 'FD')
      doc.setTextColor(...MUTED); doc.setFontSize(6.5); doc.setFont('helvetica', 'bold')
      doc.text(label, mx + 2, y + 4)
      doc.setTextColor(i === 3 ? matchFg[0] : TEXT[0], i === 3 ? matchFg[1] : TEXT[1], i === 3 ? matchFg[2] : TEXT[2])
      doc.setFontSize(8); doc.setFont(i === 3 ? 'helvetica' : 'helvetica', i === 3 ? 'bold' : 'normal')
      doc.text(val, mx + 2, y + 8.5)
    })
    y += 12

    // Plain summary
    const sumL2 = doc.splitTextToSize(m.plainSummary || '', cw - 8)
    const sumH2 = sumL2.length * 4.2 + 6
    checkPage(sumH2 + 2)
    doc.setFillColor(...TEALL); doc.rect(ml, y, cw, sumH2, 'F')
    doc.setFillColor(...TEALM); doc.rect(ml, y, 1.5, sumH2, 'F')
    doc.setTextColor(...TEXT); doc.setFontSize(8); doc.setFont('helvetica', 'normal')
    doc.text(sumL2, ml + 4, y + 4)
    y += sumH2 + 3

    // Criteria
    const renderCriteria = (items: string[], bg: number[], fg: number[], icon: string) => {
      items.forEach(item => {
        const lines = doc.splitTextToSize(`${icon} ${item}`, cw - 5)
        const h = lines.length * 4 + 4
        checkPage(h + 1)
        doc.setFillColor(...(bg as [number,number,number]))
        doc.rect(ml, y, cw, h, 'F')
        doc.setTextColor(...(fg as [number,number,number]))
        doc.setFontSize(7.5); doc.setFont('helvetica', 'normal')
        doc.text(lines, ml + 2, y + 3.5)
        y += h + 1
      })
    }
    renderCriteria(m.criteriaMet || [],     GREEN_BG, GREEN_FG, '✓')
    renderCriteria(m.criteriaPartial || [], AMBERL,   [92, 58, 8], '~')
    renderCriteria(m.criteriaFail || [],    REDL,     RED, '✗')
    y += 2

    // Next steps
    const nsLines = doc.splitTextToSize((m.nextSteps || '').replace(/\\n/g, '\n'), cw - 6)
    const nsH = nsLines.length * 4.2 + 9
    checkPage(nsH + 2)
    doc.setFillColor(...TEALL); doc.setDrawColor(...BORDER)
    doc.rect(ml, y, cw, nsH, 'FD')
    doc.setTextColor(...TEAL); doc.setFontSize(7.5); doc.setFont('helvetica', 'bold')
    doc.text('Next steps:', ml + 2, y + 5)
    doc.setFont('helvetica', 'normal'); doc.text(nsLines, ml + 2, y + 9.5)
    y += nsH + 6
  }

  // ── PRE-SCREENING CHECKLIST APPENDIX (Phase 2 Week 8-9) ─────────────────
  if (options?.prescreening?.checklist?.length) {
    const cl      = options.prescreening
    const items   = cl.checklist

    doc.addPage()
    y = 14

    // Appendix header
    doc.setFillColor(...TEAL); doc.rect(ml, y, cw, 10, 'F')
    doc.setTextColor(...WHITE); doc.setFontSize(10); doc.setFont('helvetica', 'bold')
    doc.text('Pre-screening Checklist — Visit Preparation', ml + 3, y + 7)
    y += 14

    // Trial reference
    doc.setFillColor(...GRAY); doc.rect(ml, y, cw, 9, 'FD')
    doc.setTextColor(...MUTED); doc.setFontSize(7); doc.setFont('helvetica', 'bold')
    doc.text('TRIAL', ml + 2, y + 3.5)
    doc.text('NCT ID', ml + cw / 2, y + 3.5)
    doc.setTextColor(...TEXT); doc.setFontSize(8.5); doc.setFont('helvetica', 'normal')
    doc.text((cl.trial_title || '').slice(0, 60), ml + 2, y + 7.5)
    doc.text(cl.nct_id, ml + cw / 2, y + 7.5)
    y += 13

    // Intro note
    const introLines = doc.splitTextToSize(
      'This checklist was generated by Claude AI to help the patient prepare for their pre-screening visit. ' +
      'Please review all items and confirm with the patient before the appointment.',
      cw - 6
    )
    const introH = introLines.length * 4 + 8
    doc.setFillColor(...TEALL); doc.rect(ml, y, cw, introH, 'F')
    doc.setFillColor(...TEALM); doc.rect(ml, y, 2, introH, 'F')
    doc.setTextColor(...TEXT); doc.setFontSize(8); doc.setFont('helvetica', 'normal')
    doc.text(introLines, ml + 4, y + 5)
    y += introH + 5

    // Group by category
    const catOrder = ['labs','documents','medications','preparation','questions']
    const grouped: Record<string, ChecklistItem[]> = {}
    for (const item of items) {
      if (!grouped[item.category]) grouped[item.category] = []
      grouped[item.category].push(item)
    }

    for (const cat of catOrder) {
      const catItems = grouped[cat]
      if (!catItems?.length) continue

      checkPage(25)

      // Category header
      const catLabel = CATEGORY_ICONS[cat] || cat
      doc.setFillColor(...BORDER); doc.rect(ml, y, cw, 7, 'F')
      doc.setTextColor(...TEXT); doc.setFontSize(7.5); doc.setFont('helvetica', 'bold')
      doc.text(catLabel.toUpperCase(), ml + 3, y + 5)
      y += 9

      for (const item of catItems) {
        const reqBg  = item.required ? TEALL : GRAY
        const reqFg  = item.required ? TEAL  : MUTED
        const bullet = item.required ? '✓ ' : '◦ '

        const itemLines = doc.splitTextToSize(`${bullet}${item.item}`, cw - 40)
        const noteLines = item.notes ? doc.splitTextToSize(item.notes, cw - 46) : []
        const totalH    = (itemLines.length * 4.2) + (noteLines.length * 3.8) + 7

        checkPage(totalH + 2)

        doc.setFillColor(...(reqBg as [number,number,number])); doc.rect(ml, y, cw, totalH, 'F')
        doc.setDrawColor(...BORDER); doc.rect(ml, y, cw, totalH, 'D')
        doc.setTextColor(...(reqFg as [number,number,number])); doc.setFontSize(8.5); doc.setFont('helvetica', 'normal')
        doc.text(itemLines, ml + 3, y + 5)
        if (noteLines.length > 0) {
          doc.setTextColor(...MUTED); doc.setFontSize(7)
          doc.text(noteLines, ml + 6, y + 5 + itemLines.length * 4.2)
        }

        // Required / Optional badge
        const badgeTxt = item.required ? 'Required' : 'Optional'
        const badgeBg  = item.required ? TEAL : BORDER
        const badgeW   = 22
        doc.setFillColor(...(badgeBg as [number,number,number])); doc.roundedRect(ml + cw - badgeW - 2, y + (totalH/2) - 3.5, badgeW, 7, 1, 1, 'F')
        doc.setTextColor(...WHITE); doc.setFontSize(6.5)
        doc.text(badgeTxt, ml + cw - (badgeW / 2) - 2, y + (totalH / 2) + 1.5, { align: 'center' })
        y += totalH + 2
      }
      y += 3
    }

    // Checklist disclaimer
    checkPage(16)
    doc.setFillColor(...GRAY); doc.rect(ml, y, cw, 14, 'F')
    doc.setTextColor(...MUTED); doc.setFontSize(7); doc.setFont('helvetica', 'italic')
    const discl = doc.splitTextToSize(
      'This checklist is AI-generated based on the matched trial\'s eligibility criteria. ' +
      'Actual pre-screening requirements are determined by the Principal Investigator at each site. ' +
      'Please confirm all items with the site coordinator before the visit.',
      cw - 6
    )
    doc.text(discl, ml + 3, y + 4)
    y += 18
  }

  // Footer on every page
  const totalPages = doc.getNumberOfPages()
  for (let pg = 1; pg <= totalPages; pg++) {
    doc.setPage(pg)
    doc.setFillColor(...GRAY); doc.rect(0, 289, pw, 8, 'F')
    doc.setTextColor(...MUTED); doc.setFontSize(7); doc.setFont('helvetica', 'normal')
    doc.text('TrialMatch India — For research use only. Not a medical recommendation.', ml, 294)
    doc.text(`Page ${pg} of ${totalPages}  ·  ${today}`, pw - mr, 294, { align: 'right' })
  }

  return Buffer.from(doc.output('arraybuffer'))
}
