# Next.js 14 → 16 Migration Plan (TrialMatch India, v17)

Scoping document only — **no migration code has been written yet.** Every
claim below was checked against current sources (Next.js's own docs,
current as of early August 2026, plus this codebase directly) rather than
assumed from general Next.js knowledge, which goes stale fast on major
version changes. Where a source made a claim another source contradicted,
that's noted rather than silently picking one.

## Why this, and why now — the real driver

**Next.js 14 reached end-of-life on October 26, 2025.** `14.2.35` — what
this app runs, added by the `.npmrc` fix earlier in this engagement — was
its final patch release, ever. Two advisory batches have landed since:
13 advisories in May 2026, 9 more in July 2026. None will ever be
patched for 14.x. That's the real reason to move, not the raw count of
currently-flagged advisories.

**Of the ~20 advisories `npm audit` currently flags, most don't touch
this app's actual surface** — checked directly against this codebase:
no `app/` directory (Pages Router only), no `next/image` usage, no
`i18n` config, no `rewrites`, no custom server. That rules out the
React Server Components, Server Actions, App Router segment-prefetch,
and Image Optimizer advisories — the majority of the list. The one that
plausibly applies: a middleware-redirect cache-poisoning bug (`npm audit`
rates it "low"; this app's `middleware.ts` does issue a real redirect,
for MFA step-up). Separately checked the one *famous, severe* middleware
CVE (CVE-2025-29927, CVSS 9.1, the `x-middleware-subrequest` auth
bypass) — **this app is already past the patched version** (fixed in
14.2.25+; this app is on 14.2.35), and it's on Vercel, which had
independent platform-level protection regardless.

**Bottom line: this isn't an emergency patch. It's warranted, unhurried,
real engineering work, done because 14.x can structurally never be
patched again — not because this app is currently exposed.**

## Target version

**Next.js 16.3.0** (current stable as of this writing), not an
intermediate stop. Reasoning: the upgrade effort is similar whether
landing on 15.x or 16.x — the dependency and React-19 work is shared —
so stopping short just means doing this exercise twice.

## The one architectural fact that most changes the risk picture

Next.js 16 renames `middleware.ts` → `proxy.ts` (exported function
`middleware` → `proxy`), and its guidance is explicit: proxy should be
"thin" — check for a session cookie's existence, redirect if absent,
**don't** do real verification or DB calls there; do that in the actual
route/component. **This codebase's `middleware.ts` already works exactly
this way** — it reads `mfaRequired`/`mfaVerified` from the JWT via
`getToken()` (zero DB calls, by explicit design, documented in the
file's own header comment), and the *fresh*, DB-backed check happens
separately in `lib/api-handler.ts`. This isn't a coincidence this
migration benefits from — it's confirmation the existing design was
already right. The rename itself has an official codemod and, per every
source checked, is close to a pure rename for code already shaped this
way. This is the single highest-scrutiny item in this plan regardless,
because it's the file that gates MFA for every route in the app.

## Dependency-by-dependency compatibility check

Checked against this app's actual `package.json`, not a generic list.

### Production dependencies

| Package | Current | Compatibility w/ Next 16 / React 19 | Action needed |
|---|---|---|---|
| `next` | 14.2.35 | — (the upgrade target) | Bump to 16.3.0 |
| `react` | 18.3.1 | Next 15+ requires React **19** minimum — confirmed directly from Next's own upgrade docs | Bump to 19.x, via the official codemod's React 19 pass |
| `react-dom` | 18.3.1 | Same as above | Bump to 19.x, paired with `react` |
| `next-auth` | 4.24.15 | Confirmed working on Next 15 in Pages Router mode (community-reported, `getServerSession`/`[...nextauth].ts` pattern, not deprecated). Next 16 specifically has less direct confirmation in current sources — **this is the one dependency to test most thoroughly**, not because of a known break, but because community attention has shifted to Auth.js v5 + App Router, so v4 + Pages Router gets less scrutiny now | No forced action; budget real test time here specifically |
| `@anthropic-ai/sdk` | 0.24.3 | Server-side only, zero React/Next coupling | None required; separately worth bumping (quite old) — optional, not blocking |
| `@supabase/supabase-js` | 2.112.0 | Server-side usage only in this app (confirmed earlier in this engagement — the browser-facing anon client is never actually imported anywhere); zero React coupling for how this app uses it | None required |
| `@vercel/functions` | 1.5.0 | Vercel's own package, tracks Next.js compatibility by definition | Check for a newer version alongside, low effort |
| `stripe` | 16.2.0 | Payments SDK, zero framework coupling | None required |
| `resend` | 3.2.0 | Email SDK, zero framework coupling | None required |
| `nodemailer` | 9.0.4 | Zero framework coupling | None required |
| `bcryptjs` | 2.4.3 | Zero framework coupling | None required |
| `bn.js` / `elliptic` | 5.2.1 / 6.5.7 | Zero framework coupling (Fidelius ECDH math) | None required |
| `otplib` | 13.4.1 | Zero framework coupling | None required |
| `qrcode` | 1.5.4 | Zero framework coupling | None required |
| `papaparse` | 5.4.1 | Zero framework coupling | None required |
| `jspdf` | 4.2.1 | Not a React component library, isomorphic PDF generation | None required |
| `micro` | 10.0.1 | Small, stable Node utility (raw body parsing for the Stripe webhook route) | None required |
| `zod` | 3.23.8 | Zero framework coupling | None required (zod 4 exists but is a separate, optional, non-blocking upgrade) |

### Dev dependencies

| Package | Current | Compatibility w/ Next 16 / React 19 | Action needed |
|---|---|---|---|
| `@types/react` | 18.3.3 | Must match the `react` bump | Bump to 19.x, paired with `react` |
| `eslint` | 8.57.0 | **`next lint` is removed entirely in Next 16** — confirmed directly from Next's own upgrade docs ("`next lint` no longer exists. You'll use ESLint directly, with a provided codemod"). This app's `package.json` currently has `"lint": "next lint"` | Real action: switch to running ESLint directly (codemod provided); bump `eslint` if `eslint-config-next`'s new major requires it — verify exact version at migration time, don't assume |
| `eslint-config-next` | 14.2.3 | Must track the `next` major version | Bump to 16.x alongside `next` |
| `@types/node` | 20.12.12 | Next 16 requires Node **20.9+** at runtime (this sandbox and Vercel's current runtime both already satisfy this) | Optional: bump to match actual deploy Node version for type accuracy, not blocking |
| `typescript` | 5.4.5 | Next 16 requires TypeScript **5.1.0+** — already satisfied | None required |
| `tailwindcss` | 3.4.3 | No forced Next-16 compatibility requirement (Tailwind v4 exists but is optional, unrelated to this migration) | None required |
| `postcss` / `autoprefixer` | 8.4.38 / 10.4.19 | Stable CSS tooling, no Next-version coupling | None required |
| `ts-node` | 10.9.2 | Used only for standalone scripts (`seed-pi-contacts.ts` etc.), independent of Next.js version | None required |
| `dotenv` | 16.4.5 | Zero framework coupling | None required |
| `vitest` | 1.6.0 | Confirmed directly: **none of the 267 tests render a React component** (no `@testing-library`, no `render()`/`renderHook()` calls anywhere in the test suite — checked, not assumed) — every test is pure logic against `lib/` functions. So there's no React-19-versioned testing-library dependency to reconcile | None required |
| `@types/bcryptjs`, `@types/elliptic`, `@types/papaparse`, `@types/qrcode` | — | Matched to their respective packages, none of which need bumping | None required |

### `next.config.js` — one confirmed, exact required change

This app's actual config:
```js
experimental: { serverComponentsExternalPackages: ['jspdf'] }
```
Confirmed directly: this option **stabilized and moved** in Next.js 15 —
now `serverExternalPackages` at the config root, not nested under
`experimental`. An official codemod exists for exactly this rename.
Required change:
```js
// Before (this app's current config)
experimental: { serverComponentsExternalPackages: ['jspdf'] }

// After
serverExternalPackages: ['jspdf']
```

## Order of operations

1. **Branch, don't touch `main`.** `git checkout -b nextjs-16-migration`.
   Keep the pre-migration branch/tag deployable throughout — this is
   the rollback plan's foundation, not an afterthought.

2. **Run the official upgrade codemod**, not a manual dependency bump:
   ```bash
   npx @next/codemod@canary upgrade latest
   ```
   This handles the `next`/`react`/`react-dom`/`eslint-config-next`
   version bumps together, and offers the specific codemods this app
   needs (React 19 transforms, the `serverExternalPackages` rename,
   `middleware.ts` → `proxy.ts`) as prompts rather than requiring each
   to be found and run manually.

3. **Review every file the codemod touched before running anything else.**
   Don't trust it blindly — confirm `next.config.js`, `middleware.ts` →
   `proxy.ts`, and the `package.json` diffs are what's expected from
   the table above.

4. **Update the `lint` script by hand** — the codemod may not fully
   automate this one, since `next lint`'s removal is a script-level
   change, not just a code transform. Verify the replacement command
   against whatever `eslint-config-next`'s 16.x version actually
   documents at migration time (don't hardcode a guess now).

5. **`npm install` and resolve any peer-dependency fallout.** Given
   this project's history with `next-auth`/`nodemailer` peer ranges
   (see `.npmrc`), expect at least one more instance of this pattern —
   check whether it's `legacy-peer-deps=true`-safe the same way, or a
   genuinely different situation, rather than assuming the same fix
   applies.

6. **Run the existing verification gates, unmodified, as the first
   checkpoint** — before touching a single line of application code:
   ```
   tsc --noEmit -p tsconfig.json
   tsc --noEmit -p tsconfig.scripts.json
   vitest run          # expect 267/267 — these are pure logic tests,
                        # a React-version bump shouldn't touch them at all
   next build
   node scripts/security-audit.js
   ```
   If `vitest run` doesn't hold at 267/267 with zero changes to the
   `lib/__tests__` files themselves, that's a real signal something in
   the dependency graph shifted behavior, not just syntax — stop and
   investigate before proceeding.

7. **Manually test `middleware.ts`/`proxy.ts` specifically, end to end**,
   given what it protects: sign in as a role that requires MFA, confirm
   the redirect to `/auth/mfa-challenge` still fires; confirm an
   already-MFA-verified session still reaches protected routes; confirm
   the `MFA_EXEMPT_PREFIXES` routes (webhook, cron, ABDM callback)
   remain reachable without a session. This is the one file in this
   migration where "it built successfully" isn't sufficient evidence.

8. **Sweep every major screen manually** — dashboard, patient
   intake, match results, sponsor portal, team management, billing —
   collecting errors rather than fixing as you go. Fix by error class
   afterward (e.g., every instance of a specific React 19 hydration
   warning together), not page by page — this was the single most
   consistently repeated piece of real-world advice found while
   researching this plan, from more than one independent account of
   large Pages-Router migrations.

9. **Don't bundle feature work into this branch.** Framework migration
   and product changes reviewed together make it genuinely hard to tell
   which change caused a given regression.

10. **Deploy to a preview environment first** (Vercel does this
    automatically per-PR) and run through the real deployment checks
    from `README.md`'s Tier 0 section — including actually clicking
    "Run" on each of the 5 cron jobs once, given how much of this
    engagement's earlier work went into making sure those actually fire.

## Rollback plan

- **Vercel-specific instant rollback**: Vercel keeps prior production
  deployments as immutable, redeployable artifacts. If anything is
  wrong post-deploy, the fastest rollback is re-promoting the last
  known-good deployment from Vercel's dashboard — this requires no
  branch/git operation and takes effect immediately.
- **Git-level rollback**: keep the pre-migration commit tagged
  (`git tag pre-nextjs-16`) before merging, so `main` can be reset to a
  known point without reconstructing it from history.
- **Database is untouched by this migration** — nothing about a
  Next.js/React version bump requires any schema change, so there's no
  migration-rollback coupling to worry about here; the app layer and
  data layer can be rolled back independently.
- **Treat rollback as a normal deploy action, not a fire drill** — the
  same "redeploy a known-good artifact" action Vercel already supports
  for any deploy, not a special procedure invented for this migration.
- **Don't merge to `main` until the full verification suite (step 6
  above) passes AND the manual `middleware.ts` MFA sweep (step 7) is
  done** — the automated gates alone aren't sufficient sign-off for
  this specific migration, given what step 7 protects.

## What this document is not

This is a scoping plan, not a completed migration. No dependency has
been bumped, no codemod has been run, no code has changed. The next
step, when you're ready, is executing this plan in its own session —
consistent with treating this as real, unhurried engineering work
rather than something to rush alongside everything else already done in
this engagement.
