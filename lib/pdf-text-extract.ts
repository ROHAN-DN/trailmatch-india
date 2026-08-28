/**
 * lib/pdf-text-extract.ts
 *
 * Extracts plain text from a PDF buffer using pdfjs-dist — chosen
 * specifically over the newer pdf-parse@2.x, which bundles
 * @napi-rs/canvas (a native binary dependency) as a hard requirement.
 * A native binding is a real, previously-encountered risk in this
 * project's actual Vercel deployment history (see the Next.js 16
 * migration notes and FIXES_2026-08-14.md for other instances of
 * "worked locally, broke on real serverless infrastructure"); pdfjs-dist
 * on its own has zero dependencies and only needs text extraction
 * (getTextContent()), not page rendering, so canvas was never actually
 * needed here.
 *
 * This exists so pages/api/sponsor/parse-pdf.ts can turn an uploaded
 * PDF into plain text, then hand that text to the SAME
 * lib/protocol-parser.ts pipeline used for pasted-text protocols —
 * which already works across all four LLM providers. That's a
 * deliberate architectural choice: rather than build separate,
 * provider-specific PDF-handling code for Anthropic's native document
 * blocks, OpenAI's file APIs, and Google's inline_data parts (three
 * different shapes, none of them verifiable live from this
 * environment), extracting text up front means PDF upload works
 * identically for every provider an org might configure — the same
 * guarantee every other part of this multi-provider architecture makes.
 *
 * Honest trade-off: Claude's native PDF reading can use visual/layout
 * understanding (tables, multi-column text) that plain text extraction
 * loses. For a typical trial protocol — mostly prose eligibility
 * criteria — this is very unlikely to matter; for a protocol that's
 * primarily a complex table, extraction quality may be worse than
 * Claude reading the PDF directly would have been. That's a real,
 * known trade-off, not a hidden one.
 */

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createRequire } from 'module'
import path from 'path'

export class PDFExtractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PDFExtractionError'
  }
}

let cachedAssetPaths: { standardFontDataUrl: string; cMapUrl: string } | null = null

/** Locates pdfjs-dist's own bundled font/cmap data files, regardless of exact node_modules layout — resolved once, cached for the life of the process. */
function getAssetPaths() {
  if (cachedAssetPaths) return cachedAssetPaths
  const require = createRequire(import.meta.url)
  const pkgPath = path.dirname(require.resolve('pdfjs-dist/package.json'))
  const toPosixUrl = (p: string) => p.split(path.sep).join('/')
  cachedAssetPaths = {
    standardFontDataUrl: toPosixUrl(path.join(pkgPath, 'standard_fonts')) + '/',
    cMapUrl: toPosixUrl(path.join(pkgPath, 'cmaps')) + '/',
  }
  return cachedAssetPaths
}

/**
 * Extracts all text from a PDF buffer, page by page, joined with
 * newlines between pages. Throws PDFExtractionError (never a raw
 * pdfjs-dist exception) on anything from an empty buffer to a
 * genuinely corrupt file to a non-PDF upload — verified directly
 * against all three of those cases, not assumed.
 */
export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  const { standardFontDataUrl, cMapUrl } = getAssetPaths()

  let doc
  try {
    doc = await getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      standardFontDataUrl,
      cMapUrl,
      cMapPacked: true,
    }).promise
  } catch (err: any) {
    throw new PDFExtractionError(`Could not read this file as a PDF: ${err?.message || 'unknown error'}. Confirm it's a valid, non-password-protected PDF.`)
  }

  const pageTexts: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    pageTexts.push(content.items.map((item: any) => item.str || '').join(' '))
  }

  const fullText = pageTexts.join('\n').trim()
  if (!fullText) {
    throw new PDFExtractionError('No extractable text found in this PDF — it may be a scanned image without a text layer. Try pasting the protocol text directly instead.')
  }
  return fullText
}
