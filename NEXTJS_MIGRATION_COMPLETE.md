# NEXTJS_MIGRATION_COMPLETE.md

Executed the plan scoped in `NEXTJS_MIGRATION_PLAN.md`. Two real
dependency conflicts surfaced that the scoping doc couldn't have
predicted (they only exist in the actual current npm registry state,
not in anything readable from the source code beforehand) — both found
by actually running the upgrade, not by re-reading documentation, and
both fixed and re-verified.

## What changed

- `next`: `14.2.35` → `16.3.0`
- `react` / `react-dom`: `18.3.1` → `19.2.8`
- `@types/react`: `18.3.3` → `19.2.18`
- `eslint`: `8.57.0` → `9.39.5` (see "Real problem #2" below — not `10.x`,
  despite the official upgrade codemod defaulting to "latest")
- `eslint-config-next`: `14.2.3` → `16.3.0`
- `zod`: `3.23.8` → `3.25.76` (see "Real problem #1" below — same v3
  major, no API changes to this app's own zod usage)
- `middleware.ts` → `proxy.ts` (Next.js 16's rename; confirmed via the
  official `middleware-to-proxy` codemod's diff that this was a clean
  rename — file name and exported function name only, zero logic
  changes)
- `next.config.js`: `experimental.serverComponentsExternalPackages` →
  `serverExternalPackages` (stabilized location as of Next 15)
- `package.json`'s `lint` script: `next lint` → `eslint .` (`next lint`
  was removed entirely in Next.js 16)
- New `eslint.config.mjs` — **this project had no ESLint config at all
  before this migration.** `next lint` used to fall back to
  `eslint-config-next`'s implicit defaults; now that ESLint runs
  directly, an explicit config is required. Written against
  `eslint-config-next`'s actual installed flat-config exports (checked
  `node_modules/eslint-config-next/dist/*.js` directly rather than
  trusted a blog post's syntax).

## Real problem #1: a genuine dependency conflict, not a config mistake

First `npm run lint` run failed outright:
`ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './v4/core' is not
defined by "exports" in .../node_modules/zod/package.json`.

Traced with `npm ls zod`: `eslint-config-next@16.3.0` pulls in
`eslint-plugin-react-hooks@7.1.1`, which depends on
`zod-validation-error@4.0.2`, which requires `zod@^3.25.0 || ^4.0.0`.
This app's own top-level `zod@3.23.8` — used for request validation
throughout the API routes, unrelated to linting — was one minor version
below that floor, and npm's resolver deduped an actually-invalid version
into that slot (`npm ls` confirmed this explicitly with an `invalid:`
marker). Fixed by bumping this app's own `zod` to `3.25.76` — the latest
stable **v3** release, deliberately not v4, since jumping the major
version would mean auditing every `.parse()`/`.safeParse()` call in the
app for v3→v4 API changes, which is real work unrelated to a Next.js
migration and explicitly out of scope per the scoping doc's own "don't
bundle feature work into this branch" guidance.

## Real problem #2: the upgrade codemod's "latest" ESLint was too new for the plugin ecosystem

After fixing zod, `npm run lint` ran but crashed differently:
`context.getFilename is not a function`, inside `eslint-plugin-react`'s
internal `display-name` rule logic. Checked directly —
`eslint-plugin-react@7.37.5`'s actual declared peer range is
`^3 || ^4 || ^5 || ^6 || ^7 || ^8 || ^9.7`. It does not support ESLint
10 yet. The `@next/codemod upgrade latest` command had installed
`eslint@10.8.1` (genuinely "latest" on npm), but the plugin ecosystem
`eslint-config-next` itself depends on hasn't caught up. Every ESLint
plugin in the tree showed the same `invalid:` marker under `npm ls`.
Fixed by pinning `eslint` to `9.39.5` — the latest release the plugins
actually declare support for. Confirmed after the fix: `npm ls` shows
zero `invalid` markers anywhere in the tree.

## Verification — from a fully clean install, not incrementally

```
rm -rf node_modules .next && npm install    → 664 packages, zero `invalid` markers
tsc --noEmit (both configs)                  → clean
vitest run                                   → 267/267 passing (unchanged from pre-migration)
next build                                   → succeeds, Turbopack, all routes,
                                                 output explicitly shows "ƒ Proxy (Middleware)"
node scripts/security-audit.js               → 9/9 passed
npm audit                                    → 13 → 6 vulnerabilities (1 low, 2 moderate,
                                                 2 high, 1 critical) — expected, years of
                                                 upstream fixes landing at once
```

## `proxy.ts` — tested against real tokens, not assumed

This is the file that gates MFA for every route in the app, so "the
build succeeded" isn't sufficient evidence for it. Built real,
validly-encrypted next-auth JWTs using next-auth's own `encode()`
function (not a hand-rolled token — next-auth v4 uses encrypted JWE
tokens, not plain signed JWTs, so a hand-rolled token wouldn't have
exercised the real decode path), and ran the built server against them:

1. Valid session, MFA required but not verified, hitting a protected API
   route → **`proxy.ts`'s own 403 with the MFA-required message fired**,
   not the route's own auth logic.
2. Same session, hitting a page route → **clean 307 redirect to
   `/auth/mfa-challenge?from=%2Fdashboard`**.
3. Same MFA-required session, hitting an MFA-*exempt* route
   (`/api/mfa/setup`) → **correctly bypassed the block** (reached the
   real route, which returned its own 405 for the wrong HTTP method —
   not proxy's 403). Confirms someone stuck needing MFA can still reach
   the route that lets them complete it.
4. MFA already verified, hitting the same protected route → **passed
   proxy.ts cleanly**, reached real application code (which then hit a
   `fetch failed` against the placeholder Supabase URL — expected, that's
   the fake credentials, not a proxy problem).

All four are exactly the intended behavior. The confirmation from the
scoping doc — that this codebase's middleware already followed the
"thin proxy, no DB calls" pattern Next 16 pushes toward — held up under
an actual adversarial-shaped test, not just a reading of the diff.

## What's real but genuinely out of scope here

- **643 pre-existing ESLint findings** (591 errors, 52 warnings — mostly
  `no-explicit-any`), now visible for the first time because lint
  tooling was never actually configured before this migration. Not a
  regression. Not fixed here — real, separate work.
- **Manual browser click-through of every screen** — the scoping doc's
  own step 8. No live browser or deployed environment is available in
  this session; the build succeeding and the four `proxy.ts` tests above
  are the strongest verification possible without one. A real
  browser-based sweep through the actual screens is still worth doing
  before this goes to production, same as it was before this migration.
- **Vercel preview deployment** — scoping doc's step 10. Needs real
  Vercel access; not available here.

## Git state

- `master` — pre-migration baseline, tagged `pre-nextjs-16`
- `nextjs-16-migration` — this work, merged into `master` after the
  verification above passed
- Rollback, if ever needed: `git checkout pre-nextjs-16` restores the
  exact pre-migration state, or — faster in practice — re-promote the
  last known-good deployment from Vercel's dashboard, which requires no
  git operation at all.
