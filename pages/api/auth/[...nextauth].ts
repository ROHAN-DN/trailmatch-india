import NextAuth, { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import { supabaseAdmin } from '../../../lib/supabase'
import { checkLimit } from '../../../lib/gate'
import { PLANS } from '../../../lib/plans'
import { roleRequiresMFA } from '../../../lib/mfa'

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false

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
          const userGate = await checkLimit(invite.org_id, 'users')
          if (!userGate.allowed) return false

          await supabaseAdmin().from('users').insert({
            email: user.email,
            name: user.name,
            org_id: invite.org_id,
            role: invite.role,
          })
          await supabaseAdmin()
            .from('invitations')
            .update({ accepted_at: new Date().toISOString() })
            .eq('id', invite.id)
        } else {
          // New user – create personal org
          const { data: org, error: orgError } = await supabaseAdmin()
            .from('organizations')
            .insert({
              name: `${user.name || user.email}'s Workspace`,
              type: 'other',
              plan: 'trial',
              max_patients: PLANS.trial.max_patients,
              max_users: PLANS.trial.max_users,
              max_match_jobs_per_month: PLANS.trial.max_match_jobs_per_month,
            })
            .select('id')
            .single()

          if (orgError || !org) {
            console.error('[signIn][org-create-failed]', JSON.stringify(orgError))
            return false
          }

          const { error: userInsertError } = await supabaseAdmin()
            .from('users')
            .insert({
              email: user.email,
              name: user.name,
              org_id: org.id,
              role: 'owner',
            })

          if (userInsertError) {
            console.error('[signIn][user-create-failed]', JSON.stringify(userInsertError))
            return false
          }
        }
      }

      // Update last_login
      await supabaseAdmin()
        .from('users')
        .update({ last_login: new Date().toISOString(), name: user.name })
        .eq('email', user.email)

      return true
    },

    async jwt({ token, user, trigger, session }) {
      if (user) {
        const { data: dbUser } = await supabaseAdmin()
          .from('users')
          .select('role')
          .eq('email', token.email!)
          .single()

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
        ;(session.user as any).id = dbUser.id
        ;(session.user as any).org_id = dbUser.org_id
        ;(session.user as any).role = dbUser.role

        const required = roleRequiresMFA(dbUser.role)
        ;(session.user as any).mfaStatus = !required
          ? 'not_required'
          : !dbUser.mfa_enabled
          ? 'must_enroll'
          : !(token as any).mfaVerified
          ? 'must_verify'
          : 'verified'
      }

      return session
    },
  },
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
    verifyRequest: '/auth/verify',
  },
  session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 },
}

export default NextAuth(authOptions)