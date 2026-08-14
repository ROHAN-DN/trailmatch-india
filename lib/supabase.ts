import { createClient } from '@supabase/supabase-js'

// REAL BUG FOUND AND FIXED HERE: this file used to also export a
// top-level, eagerly-created browser client:
//   export const supabase = createClient(NEXT_PUBLIC_SUPABASE_URL!, ...)
// Confirmed by grepping every import site in the app (33 files, all of
// them): NOTHING ever actually imported `supabase` — only
// `supabaseAdmin`, the lazy factory below. But importing anything from
// a module runs the whole file top-to-bottom, so that unused, eager
// createClient() call fired on every single import regardless, and
// @supabase/supabase-js throws synchronously if the URL is empty:
// "Error: supabaseUrl is required." That crashed `next build` outright
// during Next's page-data-collection phase, on a real Vercel deploy,
// the moment NEXT_PUBLIC_SUPABASE_URL wasn't set yet — which is exactly
// the state of a first deploy, before Vercel's project env vars are
// configured. It never surfaced in local testing because local builds
// always had placeholder env vars set. Removed entirely rather than
// left unused, since dead code that crashes the build on missing env
// vars is worse than no code at all.

// Server client (uses service role key, bypasses RLS — server-side only)
export const supabaseAdmin = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
