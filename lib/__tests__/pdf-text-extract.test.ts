import { describe, it, expect } from 'vitest'
import { jsPDF } from 'jspdf'
import { extractTextFromPDF, PDFExtractionError } from '../pdf-text-extract'

function generateTestPDF(lines: string[]): Buffer {
  const doc = new jsPDF()
  lines.forEach((line, i) => doc.text(line, 10, 10 + i * 10))
  return Buffer.from(doc.output('arraybuffer'))
}

describe('extractTextFromPDF', () => {
  it('extracts real text from a real, freshly-generated PDF — not a mock', async () => {
    const pdf = generateTestPDF([
      'Study Title: A Phase III Trial of Drug X in Type 2 Diabetes',
      'Inclusion: Age 18-75, HbA1c between 7.0% and 10.5%',
      'Exclusion: Prior treatment with Drug X class',
    ])
    const text = await extractTextFromPDF(pdf)
    expect(text).toContain('Phase III Trial of Drug X')
    expect(text).toContain('HbA1c between 7.0% and 10.5%')
    expect(text).toContain('Prior treatment with Drug X class')
  })

  it('handles a multi-page PDF, preserving content from every page', async () => {
    const doc = new jsPDF()
    doc.text('Page one content: eligibility criteria section', 10, 10)
    doc.addPage()
    doc.text('Page two content: exclusion criteria section', 10, 10)
    const pdf = Buffer.from(doc.output('arraybuffer'))

    const text = await extractTextFromPDF(pdf)
    expect(text).toContain('Page one content')
    expect(text).toContain('Page two content')
  })

  it('throws PDFExtractionError (not a raw pdfjs-dist exception) on an empty buffer', async () => {
    await expect(extractTextFromPDF(Buffer.alloc(0))).rejects.toThrow(PDFExtractionError)
  })

  it('throws PDFExtractionError on random garbage bytes', async () => {
    await expect(extractTextFromPDF(Buffer.from([1, 2, 3, 4, 5, 255, 254, 0]))).rejects.toThrow(PDFExtractionError)
  })

  it('throws PDFExtractionError with a clear, actionable message on a plain text file mistakenly uploaded as PDF', async () => {
    await expect(
      extractTextFromPDF(Buffer.from('this is not a pdf, just plain text', 'utf-8'))
    ).rejects.toThrow(/Could not read this file as a PDF/)
  })
})
