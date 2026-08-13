/**
 * components/HMSImportModal.tsx
 * Two-phase Insta HMS patient import modal.
 *
 * Phase 1: coordinator selects CSV → preview (no DB write, shows first 10 rows + stats)
 * Phase 2: coordinator clicks "Import X patients" → confirmed insert
 *
 * After import: consent_given = false on all rows — a banner reminds coordinator
 * to set consent before running match jobs (DPDP Act compliance).
 */

import { useState, useRef } from 'react'

interface Props {
  brandColor: string
  onClose:    () => void
  onImported: (count: number) => void
}

interface PreviewResult {
  preview:         any[]
  valid_count:     number
  skip_count:      number
  total_rows:      number
  warnings:        string[]
  detected_format: string
  all_valid_rows:  any[]
}

export default function HMSImportModal({ brandColor, onClose, onImported }: Props) {
  const [stage,    setStage]    = useState<'upload' | 'preview' | 'importing' | 'done'>('upload')
  const [preview,  setPreview]  = useState<PreviewResult | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [result,   setResult]   = useState<{ imported: number; message: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const B = (primary = false): React.CSSProperties => ({
    padding: '9px 18px', background: primary ? brandColor : '#fff',
    color: primary ? '#fff' : '#1C1B18', border: primary ? 'none' : '1px solid #E2E0D8',
    borderRadius: '8px', fontSize: '13px', fontWeight: 500, cursor: 'pointer',
    fontFamily: 'sans-serif', display: 'inline-flex', alignItems: 'center', gap: '6px',
  })

  async function handleFileSelect(file: File) {
    if (!file.name.endsWith('.csv')) { setError('Please select a CSV file.'); return }
    // Server limit is 5MB (set via export const config in pages/api/import/hms.ts).
    // This client check matches that limit exactly — not 3MB, not 4MB.
    if (file.size > 5 * 1024 * 1024) { setError('CSV file must be under 5 MB. For larger exports, split the file by ward or department.'); return }
    setLoading(true); setError(null)

    try {
      // Read file as text — send as JSON, no multipart needed
      const csv_text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload  = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error('Failed to read file'))
        reader.readAsText(file, 'utf-8')
      })

      const r = await fetch('/api/import/hms', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ csv_text }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error?.message || 'Parse failed.'); setLoading(false); return }
      setPreview(d)
      setStage('preview')
    } catch (e: any) { setError(e.message || 'Network error. Please try again.') }
    setLoading(false)
  }

  async function confirmImport() {
    if (!preview?.all_valid_rows.length) return
    setStage('importing')
    setError(null)

    try {
      const r = await fetch('/api/import/hms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, rows: preview.all_valid_rows }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error?.message || 'Import failed.'); setStage('preview'); return }
      setResult({ imported: d.imported_count, message: d.message })
      setStage('done')
    } catch { setError('Network error during import.'); setStage('preview') }
  }

  const formatDetected: Record<string, string> = {
    trialmatch_export: 'TrialMatch export (round-trip)',
    hms_native:        'Insta HMS native format',
    unknown:           'Unknown format (best-effort mapping)',
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="hms-modal-title"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', maxWidth: '620px', width: '100%', maxHeight: '85vh', overflowY: 'auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
          <div>
            <h2 id="hms-modal-title" style={{ margin: 0, fontSize: '16px', fontWeight: 500 }}>Import from Insta HMS</h2>
            <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#72706A' }}>
              Accepts Insta HMS CSV exports and TrialMatch export files.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#72706A', lineHeight: 1 }}>×</button>
        </div>

        {error && (
          <div style={{ background: '#FEF0EE', border: '1px solid #F0959566', borderRadius: '8px', padding: '10px 13px', fontSize: '12.5px', color: '#A32D2D', marginBottom: '14px' }}>
            {error}
          </div>
        )}

        {/* Stage: upload */}
        {stage === 'upload' && (
          <div>
            <div
              onClick={() => fileRef.current?.click()}
              style={{ border: `2px dashed ${brandColor}44`, borderRadius: '10px', padding: '40px 24px', textAlign: 'center', cursor: 'pointer', background: `${brandColor}05`, marginBottom: '14px' }}
            >
              {loading ? (
                <div style={{ fontSize: '13px', color: '#72706A' }}>⏳ Parsing CSV…</div>
              ) : (
                <>
                  <div style={{ fontSize: '32px', marginBottom: '8px' }}>📁</div>
                  <div style={{ fontWeight: 500, marginBottom: '5px' }}>Click to select CSV file</div>
                  <div style={{ fontSize: '12px', color: '#72706A' }}>Accepts Insta HMS patient export or TrialMatch export · Max 5 MB</div>
                </>
              )}
            </div>
            <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f) }}/>

            <div style={{ background: '#F7F6F2', borderRadius: '8px', padding: '12px 14px', fontSize: '12px', color: '#72706A', lineHeight: 1.65 }}>
              <strong style={{ color: '#1C1B18' }}>What columns are needed?</strong> Patient code/UHID, Diagnosis/Chief complaint, Age, Gender/Sex, City/Location.
              All other columns (medications, comorbidities, labs) are imported if present.
              <br/><br/>
              <strong style={{ color: '#1C1B18' }}>After import:</strong> All patients will have <em>consent not recorded</em> — you must set consent individually before running match jobs. This is required under India's DPDP Act 2023.
            </div>
          </div>
        )}

        {/* Stage: preview */}
        {stage === 'preview' && preview && (
          <div>
            {/* Stats bar */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '10px', marginBottom: '14px' }}>
              {[
                { label: 'Total rows',        val: preview.total_rows },
                { label: 'Will import',        val: preview.valid_count,  color: '#0F6E56' },
                { label: 'Skipped (invalid)',  val: preview.skip_count,   color: preview.skip_count > 0 ? '#A32D2D' : undefined },
              ].map(s => (
                <div key={s.label} style={{ background: '#F7F6F2', borderRadius: '8px', padding: '10px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: '20px', fontWeight: 500, color: s.color || '#1C1B18' }}>{s.val}</div>
                  <div style={{ fontSize: '11px', color: '#72706A' }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Format detected */}
            <div style={{ fontSize: '12px', color: '#72706A', marginBottom: '10px' }}>
              Format detected: <strong style={{ color: '#1C1B18' }}>{formatDetected[preview.detected_format] || preview.detected_format}</strong>
            </div>

            {/* Warnings */}
            {preview.warnings.length > 0 && (
              <div style={{ background: '#FEF9F0', border: '1px solid #FAC775', borderRadius: '8px', padding: '10px 13px', marginBottom: '12px' }}>
                {preview.warnings.map((w, i) => (
                  <div key={i} style={{ fontSize: '12px', color: '#9C6A00', lineHeight: 1.6 }}>⚠ {w}</div>
                ))}
              </div>
            )}

            {/* Preview table */}
            <div style={{ marginBottom: '14px' }}>
              <div style={{ fontSize: '11px', fontWeight: 600, color: '#72706A', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '8px' }}>
                Preview (first {Math.min(preview.preview.length, 5)} rows)
              </div>
              <div style={{ border: '1px solid #E2E0D8', borderRadius: '8px', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ background: '#F7F6F2' }}>
                      {['Code', 'Diagnosis', 'Age', 'Sex', 'Location'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: '#72706A', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.preview.slice(0, 5).map((row: any, i: number) => (
                      <tr key={i} style={{ borderTop: '1px solid #E2E0D8', opacity: row.valid ? 1 : 0.4 }}>
                        <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>{row.patient_code}</td>
                        <td style={{ padding: '7px 10px' }}>{row.diagnosis}</td>
                        <td style={{ padding: '7px 10px' }}>{row.age || '—'}</td>
                        <td style={{ padding: '7px 10px' }}>{row.sex}</td>
                        <td style={{ padding: '7px 10px', color: '#72706A' }}>{row.location || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* DPDP consent note */}
            <div style={{ background: '#E6F1FB', border: '1px solid #C3DCF5', borderRadius: '8px', padding: '10px 13px', fontSize: '12px', color: '#185FA5', marginBottom: '14px', lineHeight: 1.65 }}>
              🔒 <strong>DPDP Act 2023:</strong> All {preview.valid_count} imported patients will be marked <em>consent not recorded</em>. You must obtain and record patient consent before running any match jobs.
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button style={{ ...B(true), flex: 1, justifyContent: 'center' }} onClick={confirmImport}
                disabled={preview.valid_count === 0}>
                Import {preview.valid_count} patient{preview.valid_count !== 1 ? 's' : ''}
              </button>
              <button style={B()} onClick={() => { setStage('upload'); setPreview(null) }}>Back</button>
            </div>
          </div>
        )}

        {/* Stage: importing */}
        {stage === 'importing' && (
          <div style={{ textAlign: 'center', padding: '32px' }}>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>⏳</div>
            <div style={{ fontWeight: 500, marginBottom: '6px' }}>Importing patients…</div>
            <div style={{ fontSize: '12px', color: '#72706A' }}>This may take a few seconds.</div>
          </div>
        )}

        {/* Stage: done */}
        {stage === 'done' && result && (
          <div style={{ textAlign: 'center', padding: '24px' }}>
            <div style={{ fontSize: '40px', marginBottom: '12px' }}>✅</div>
            <div style={{ fontWeight: 500, fontSize: '15px', marginBottom: '8px' }}>Import complete</div>
            <div style={{ fontSize: '13px', color: '#72706A', lineHeight: 1.6, marginBottom: '18px', maxWidth: '380px', margin: '0 auto 18px' }}>
              {result.message}
            </div>
            <div style={{ background: '#FEF9F0', border: '1px solid #FAC775', borderRadius: '8px', padding: '10px 13px', fontSize: '12px', color: '#9C6A00', lineHeight: 1.65, marginBottom: '18px', textAlign: 'left' }}>
              ⚠ Next step: Go to each imported patient, confirm their details, and record consent before running match jobs.
            </div>
            <button style={B(true)} onClick={() => { onImported(result.imported); onClose() }}>
              View patients →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
