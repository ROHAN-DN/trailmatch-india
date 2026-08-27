import NextAuth, { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
// import EmailProvider from 'next-auth/providers/email'
import { supabaseAdmin } from '../../../lib/supabase'
import { checkLimit } from '../../../lib/gate'
import { PLANS } from '../../../lib/plans'
import { roleRequiresMFA } from '../../../lib/mfa'

// REAL BUG FOUND AND FIXED HERE: this file used to create its own
// separate, eager, top-level Supabase client via createClient(...) at
// module scope — a duplicate of what lib/supabase.ts already provides
// correctly as the lazy supabaseAdmin() factory. Same crash as
// lib/supabase.ts's now-removed eager client: @supabase/supabase-js
// throws synchronously ("supabaseUrl is required") the moment this
// module is imported with no NEXT_PUBLIC_SUPABASE_URL set — which
// crashed `next build` on a real first Vercel deploy, before project
// env vars were configured. Fixed by using the shared, already-lazy
// supabaseAdmin() everywhere below instead of a second, independent,
// eager instance.

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId:     process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    // EmailProvider({
    //   server: {
    //     host:   'smtp.resend.com',
    //     port:   465,
    //     secure: true,
    //     auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
    //   },
    //   from: process.env.RESEND_FROM_EMAIL,
    //   sendVerificationRequest: async ({ identifier, url, provider }) => {
    //     const { Resend } = await import('resend')
    //     const resend = new Resend(process.env.RESEND_API_KEY)
    //     await resend.emails.send({
    //       from:    provider.from!,
    //       to:      identifier,
    //       subject: 'Sign in to TrialMatch India',
    //       html: `
    //         <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
    //           <div style="background:#0F6E56;padding:18px 24px;border-radius:10px 10px 0 0">
    //             <h1 style="color:#fff;margin:0;font-size:20px;font-weight:500">TrialMatch India</h1>
    //           </div>
    //           <div style="background:#fff;padding:28px 24px;border:1px solid #E2E0D8;border-top:none;border-radius:0 0 10px 10px">
    //             <p style="color:#1C1B18;font-size:15px;line-height:1.6;margin:0 0 20px">
    //               Click the button below to sign in. This link expires in 24 hours.
    //             </p>
    //             <a href="${url}" style="display:inline-block;background:#0F6E56;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px">
    //               Sign in to TrialMatch
    //             </a>
    //             <p style="color:#72706A;font-size:12px;margin:20px 0 0;line-height:1.6">
    //               If you didn't request this, you can safely ignore this email.
    //             </p>
    //           </div>
    //         </div>
    //       `,
    //     })
    //   },
    // }),
  ],

  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false
      // Upsert user in our DB on every sign-in
      const { data: existing } = await supabaseAdmin()
        .from('users')
        .select('id, org_id, is_active')
        .eq('email', user.email)
        .single()

      if (existing && !existing.is_active) return false

      if (!existing) {
        // Check if invited
        const { data: invite } = await supabaseAdmin()
          .from('invitations')
          .select('*')
          .eq('email', user.email)
          .is('accepted_at', null)
          .gt('expires_at', new Date().toISOString())
          .single()

        if (invite) {
          // max_users was never checked here — the actual point a new
          // users row gets created for an invited person — even though
          // team/index.ts's invite-time check (best-effort only, doesn't
          // account for other pending invites) might suggest otherwise.
          // Without this, an org could exceed its plan's user cap simply
          // by having pending invites accepted after other team members
          // were already added, or after a plan downgrade.
          const userGate = await checkLimit(invite.org_id, 'users')
          if (!userGate.allowed) return false

          // Create user under invited org
          await supabaseAdmin().from('users').insert({
            email:    user.email,
            name:     user.name,
            org_id:   invite.org_id,
            role:     invite.role,
          })
          await supabaseAdmin().from('invitations')
            .update({ accepted_at: new Date().toISOString() })
            .eq('id', invite.id)
        } else {
          // New user — create personal org (they can rename it).
          // Limits set explicitly from PLANS.trial (the single source of
          // truth) rather than left to the organizations table's column
          // defaults — those defaults previously didn't match PLANS.trial
          // at all (50 patients / 5 users vs the advertised 10 / 2), so
          // every self-signup org silently got several times the
          // advertised free-trial capacity. See migration
          // 020_match_job_limits.sql for the full story and the
          // corrected defaults, kept as a defensive backstop.
          const { data: org } = await supabaseAdmin()
            .from('organizations')
            .insert({
              name: `${user.name || user.email}'s Workspace`, type: 'other',
              plan: 'trial',
              max_patients:             PLANS.trial.max_patients,
              max_users:                PLANS.trial.max_users,
              max_match_jobs_per_month: PLANS.trial.max_match_jobs_per_month,
            })
            .select('id').single()

          await supabaseAdmin().from('users').insert({
            email:   user.email,
            name:    user.name,
            org_id:  org!.id,
            role:    'owner',
          })
        }
      }

      // Update last_login
      await supabaseAdmin().from('users')
        .update({ last_login: new Date().toISOString(), name: user.name })
        .eq('email', user.email)

      return true
    },

    // MFA verification is a fact about THIS SESSION (did the person
    // complete a step-up challenge after primary auth?), not about the
    // user account — under next-auth's JWT strategy there's no
    // server-side session table to store that in, so it has to live in
    // the JWT itself, set once at sign-in and updated only via an
    // explicit client-triggered update() call after
    // pages/api/mfa/verify.ts confirms a real code. Everything else
    // (role, whether MFA is even enabled) is deliberately NOT cached
    // here — see the session callback below, which re-derives those
    // fresh on every check, same as it already did for role/org_id
    // before this feature existed.
    async jwt({ token, user, trigger, session }) {
      if (user) {
        // Fresh sign-in — look up role once to bake mfaRequired into the
        // token for middleware.ts's fast, DB-free check on every request.
        // This can go stale if the role changes mid-session (documented,
        // deliberate — see middleware.ts's own header comment); the
        // session callback below re-derives the real, current gate state
        // from a fresh DB read on every call, which is what
        // lib/api-handler.ts's withApiHandler actually enforces against.
        const { data: dbUser } = await supabaseAdmin().from('users').select('role').eq('email', user.email).single()
        token.mfaRequired = roleRequiresMFA(dbUser?.role)
        token.mfaVerified = false
      }
      if (trigger === 'update' && session?.mfaVerified) {
        token.mfaVerified = true
      }
      return token
    },

    async session({ session, token }) {
      if (!session.user?.email) return session
      const { data: dbUser } = await supabaseAdmin()
        .from('users')
        .select('id, org_id, role, name, mfa_enabled')
        .eq('email', session.user.email)
        .single()

      if (dbUser) {
        ;(session.user as any).id     = dbUser.id
        ;(session.user as any).org_id = dbUser.org_id
        ;(session.user as any).role   = dbUser.role

        // Recomputed fresh every session check from the user's CURRENT
        // role and CURRENT mfa_enabled state — only mfaVerified (whether
        // this specific session already passed a step-up challenge)
        // comes from the JWT, since that's the one piece that's
        // genuinely per-session rather than re-derivable from the DB.
        const required = roleRequiresMFA(dbUser.role)
        ;(session.user as any).mfaStatus =
          !required                    ? 'not_required' :
          !dbUser.mfa_enabled          ? 'must_enroll'   :
          !(token as any).mfaVerified  ? 'must_verify'   :
                                          'verified'
      }
      return session
    },
  },

  pages: {
    signIn:  '/auth/signin',
    error:   '/auth/error',
    verifyRequest: '/auth/verify',
  },

  session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 },
debug: true,
  logger: {
    error(code, metadata) {
      console.error('[next-auth][error]', code, JSON.stringify(metadata))
    },
    warn(code) {
      console.warn('[next-auth][warn]', code)
    },
  },  
}

export default NextAuth(authOptions)
