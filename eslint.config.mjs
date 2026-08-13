// eslint.config.mjs
//
// This project had no explicit ESLint config before this migration —
// `next lint` (removed in Next.js 16) used to fall back to
// eslint-config-next's defaults implicitly. Now that ESLint runs
// directly, an explicit config is required. eslint-config-next 16
// ships native flat config (confirmed against the actual installed
// package, not assumed) — no FlatCompat/legacy shim needed.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

export default [
  ...nextCoreWebVitals,
  ...nextTypescript,
]
