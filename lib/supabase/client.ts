import { createBrowserClient } from '@supabase/ssr'
import { assertBrowserSupabaseAuthUrl } from './project-identity'

/**
 * The Supabase client for Client Components.
 *
 * SYS-03, browser half. This bundle cannot know which environment it is —
 * `UELLIX_APP_ENV` and `VERCEL_ENV` are not `NEXT_PUBLIC_`, and inventing a
 * public variable to tell it would be the second project registry SYS-03 exists
 * to avoid. So it enforces what it can prove on its own: the URL must
 * structurally name a Supabase project API host, and that project must be one
 * this application is deployed against.
 *
 * The remaining gap is closed by construction rather than by hope.
 * `NEXT_PUBLIC_SUPABASE_URL` is inlined at BUILD time into the browser, Node
 * server and proxy bundles from one value, so the string validated here is the
 * same string `lib/supabase/project-coherence.ts` validated against the
 * environment pin on the server. The server's check is strictly stronger and
 * covers the same constant.
 */
export function createClient() {
  // Bound to a const rather than passed inline. Argument evaluation would run
  // it first either way, but the ordering of a security check should be visible
  // in the source rather than inferred from the evaluation rules.
  const authUrl = assertBrowserSupabaseAuthUrl()

  return createBrowserClient(
    authUrl,
    // A key is authorisation, never routing. See SYS-03 Phase K.
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
