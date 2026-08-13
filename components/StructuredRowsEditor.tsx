import { useState } from 'react'

export interface FieldConfig {
  key:          string
  label:        string
  type:         'text' | 'number' | 'date' | 'select'
  options?:     string[]      // required when type === 'select'
  placeholder?: string
  width?:       string        // CSS flex-basis, defaults split evenly
}

interface Props {
  rows:      Record<string, any>[]
  onChange:  (rows: Record<string, any>[]) => void
  fields:    FieldConfig[]
  emptyRow:  Record<string, any>
  addLabel:  string
  brandColor?: string
}

const S = {
  row:    { display: 'flex', gap: '8px', alignItems: 'flex-end', marginBottom: '8px' },
  field:  { flex: '1 1 0', minWidth: 0 },
  label:  { fontSize: '9px', fontWeight: 600 as any, letterSpacing: '.04em', textTransform: 'uppercase' as any, color: '#9B998F', display: 'block', marginBottom: '3px' },
  input:  { width: '100%', padding: '7px 9px', border: '1px solid #E2E0D8', borderRadius: '6px', fontSize: '12.5px', fontFamily: 'sans-serif', outline: 'none', boxSizing: 'border-box' as any },
  remove: { flex: '0 0 auto', width: '28px', height: '32px', border: '1px solid #E2E0D8', borderRadius: '6px', background: '#fff', color: '#A32D2D', cursor: 'pointer', fontSize: '15px', lineHeight: 1 },
  add:    (c: string) => ({ padding: '6px 12px', border: `1px dashed ${c}66`, borderRadius: '6px', background: 'none', color: c, cursor: 'pointer', fontSize: '12px', fontWeight: 500 as any, fontFamily: 'sans-serif' }),
  empty:  { fontSize: '12px', color: '#B4B2A9', fontStyle: 'italic' as any, marginBottom: '8px' },
}

/**
 * Generic add/edit/remove row editor for the structured clinical entities
 * (labs, medications, biomarkers, comorbidities, allergies). One component
 * configured per category via `fields`, rather than five near-duplicate
 * hand-built editors — the five categories share the same interaction
 * pattern (list of rows, each with 3-5 typed fields, add/remove) and only
 * differ in which fields they need.
 */
export default function StructuredRowsEditor({ rows, onChange, fields, emptyRow, addLabel, brandColor = '#0F6E56' }: Props) {
  function updateRow(index: number, key: string, value: any) {
    const next = rows.map((r, i) => i === index ? { ...r, [key]: value } : r)
    onChange(next)
  }

  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index))
  }

  function addRow() {
    onChange([...rows, { ...emptyRow }])
  }

  return (
    <div>
      {rows.length === 0 && <p style={S.empty}>None added yet.</p>}

      {rows.map((row, i) => (
        <div key={i} style={S.row}>
          {fields.map(f => (
            <div key={f.key} style={{ ...S.field, flexBasis: f.width }}>
              <label style={S.label}>{f.label}</label>
              {f.type === 'select' ? (
                <select
                  value={row[f.key] ?? ''}
                  onChange={e => updateRow(i, f.key, e.target.value)}
                  style={S.input}
                >
                  {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  type={f.type}
                  value={row[f.key] ?? ''}
                  placeholder={f.placeholder}
                  onChange={e => updateRow(i, f.key, f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
                  style={S.input}
                />
              )}
            </div>
          ))}
          <button type="button" onClick={() => removeRow(i)} style={S.remove} title="Remove">×</button>
        </div>
      ))}

      <button type="button" onClick={addRow} style={S.add(brandColor)}>+ {addLabel}</button>
    </div>
  )
}
