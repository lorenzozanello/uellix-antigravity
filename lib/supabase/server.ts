import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { assertSupabaseProjectCoherence } from './project-coherence'

/**
 * The request-scoped Supabase client for Server Components, Server Actions and
 * Route Handlers.
 *
 * SYS-03: the Auth project is proven to be the SAME Supabase project the
 * runtime database is pinned to, before the client exists. `lib/auth/identity.ts`
 * takes the `sub` this client verifies and hands it to db/identity-context.ts as
 * `request.jwt.claims`, which is the value every RLS policy evaluates through
 * `auth.uid()` — so a session verified by one project and applied to another
 * project's rows is a data-access defect that no policy can catch.
 *
 * The URL comes back OUT of the guard rather than being read again here. That is
 * the same discipline db/client.ts applies to connection strings: the string
 * that was validated and the string that is dialled must be one value, or the
 * check describes a destination the client never uses.
 */
export async function createClient() {
  const { authUrl } = assertSupabaseProjectCoherence()
  const cookieStore = await cookies()

  return createServerClient(
    authUrl,
    // NOT an identity source. A key authorises; it does not decide which
    // project the request is routed to, and inferring a project from one would
    // mean trusting a credential to describe itself. See SYS-03 Phase K.
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have proxy refreshing user sessions.
          }
        },
      },
    }
  )
}
