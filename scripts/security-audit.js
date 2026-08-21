#!/usr/bin/env node
/**
 * scripts/security-audit.js
 * Run before every deployment: npm run security-audit
 */

const fs   = require('fs')
const path = require('path')

let passed = 0, failed = 0
const issues = []
function fail(msg) { issues.push(`✗ ${msg}`); failed++ }
function pass(msg) { console.log(`  ✓ ${msg}`); passed++ }

function readFilesRecursive(dir, ext = ['.ts', '.tsx', '.js']) {
  const results = []
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', '.git'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) results.push(...readFilesRecursive(full, ext))
    else if (ext.some(e => entry.name.endsWith(e))) results.push(full)
  }
  return results
}

const root = path.resolve(__dirname, '..')
const allFiles = readFilesRecursive(root)
const apiFiles = allFiles.filter(f => f.includes(`${path.sep}pages${path.sep}api${path.sep}`))
const clientFiles = allFiles.filter(f =>
  f.includes(`${path.sep}pages${path.sep}`) || f.includes(`${path.sep}components${path.sep}`)
)

console.log('\n=== TrialMatch India — Security Audit ===\n')

// 1. Hardcoded API keys
console.log('1. Checking for hardcoded API keys...')
const keyPatterns = [
  { p: /sk-ant-[a-zA-Z0-9\-_]{20,}/, name: 'Anthropic key' },
  { p: /re_[a-zA-Z0-9]{20,}/,         name: 'Resend key' },
  { p: /sk_live_[a-zA-Z0-9]{20,}/,    name: 'Stripe live key' },
  { p: /whsec_[a-zA-Z0-9]{20,}/,      name: 'Stripe webhook secret' },
]
let keyFound = false
for (const file of allFiles) {
  if (file.endsWith('.env.local.example')) continue
  const content = fs.readFileSync(file, 'utf-8')
  for (const { p, name } of keyPatterns) {
    content.split('\n').forEach((line, i) => {
      if (p.test(line) && !line.includes('process.env') && !line.trim().startsWith('//')) {
        fail(`Possible hardcoded ${name} in ${path.relative(root, file)}:${i + 1}`)
        keyFound = true
      }
    })
  }
}
if (!keyFound) pass('No hardcoded API keys found')

// 2. Service role key exposure
console.log('2. Checking service role key exposure...')
let exposed = false
for (const file of clientFiles) {
  const c = fs.readFileSync(file, 'utf-8')
  if (c.includes('SUPABASE_SERVICE_ROLE_KEY') && !c.includes('process.env')) {
    fail(`Service role key without process.env in: ${path.relative(root, file)}`); exposed = true
  }
}
if (!exposed) pass('Service role key not exposed client-side')

// 3. API auth checks
//
// A route is considered authenticated if EITHER:
//  (a) it calls getServerSession/authOptions directly, or
//  (b) it's wrapped in the shared withApiHandler() (lib/api-handler.ts),
//      which calls getServerSession internally and 401s before the route's
//      own handler ever runs.
// (b) used to be invisible to this script — it string-matched only the
// route file's own contents, so every route built against the shared
// wrapper (the standard pattern for every Phase 2+ route) was flagged as
// unauthenticated even though it's enforced one layer up. That was a false
// positive in the audit, not a real gap — confirmed by reading
// lib/api-handler.ts directly: withApiHandler 401s via getServerSession
// before invoking the wrapped handler at all.
console.log('3. Checking API route authentication...')
const EXEMPT = ['auth/', 'abdm/callback', 'billing/webhook', 'cron/']
let unauth = 0
for (const file of apiFiles) {
  const rel = path.relative(root, file)
  if (EXEMPT.some(e => rel.includes(e))) continue
  const c = fs.readFileSync(file, 'utf-8')
  const hasDirectAuth  = c.includes('getServerSession') || c.includes('authOptions')
  const hasSharedGuard = /export\s+default\s+withApiHandler\s*\(/.test(c)
  if (!hasDirectAuth && !hasSharedGuard) {
    fail(`API route missing authentication: ${rel}`); unauth++
  }
}
if (!unauth) pass('All API routes have authentication checks (direct or via withApiHandler)')

// 4. .gitignore check
console.log('4. Checking .env.local is gitignored...')
const gi = path.join(root, '.gitignore')
if (fs.existsSync(gi) && fs.readFileSync(gi, 'utf-8').includes('.env.local')) {
  pass('.env.local is in .gitignore')
} else {
  fail('.env.local NOT in .gitignore — add it now')
}

// 5. Rate limiting
console.log('5. Checking rate limiting on sensitive routes...')
const routes = ['pages/api/match/index.ts', 'pages/api/patients/index.ts', 'pages/api/abdm/initiate.ts', 'pages/api/org/test-llm-provider.ts']
let missing = 0
for (const r of routes) {
  const fp = path.join(root, r)
  if (!fs.existsSync(fp)) { fail(`Route not found: ${r}`); missing++; continue }
  const c = fs.readFileSync(fp, 'utf-8')
  if (c.includes('RateLimit') || c.includes('rateLimit')) pass(`Rate limiting present on ${r}`)
  else { fail(`Rate limiting MISSING on ${r}`); missing++ }
}

// 6. ABDM callback validation
console.log('6. Checking ABDM callback security...')
const cb = path.join(root, 'pages/api/abdm/callback.ts')
if (fs.existsSync(cb)) {
  const c = fs.readFileSync(cb, 'utf-8')
  if (c.includes('isValidUUID') || c.includes('test(sessionId')) pass('ABDM callback validates session ID format')
  else fail('ABDM callback missing session ID format validation')
} else fail('ABDM callback file not found')

// 7. Compliance schema
console.log('7. Checking compliance schema...')
const mig = path.join(root, 'supabase/migrations/001_compliance.sql')
if (fs.existsSync(mig)) pass('Compliance migration file exists')
else fail('Compliance migration missing — run 001_compliance.sql')

console.log('\n=== Results ===')
if (issues.length) { console.log('\nIssues:'); issues.forEach(i => console.log(' ', i)) }
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) { console.log('\n⛔ FAILED — fix before deploying.\n'); process.exit(1) }
console.log('\n✅ PASSED — safe to deploy.\n')
