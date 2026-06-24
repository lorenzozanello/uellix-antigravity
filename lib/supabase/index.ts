/**
 * lib/supabase/index.ts
 * Barrel exports for Supabase client factories.
 *
 * Usage:
 *   Server Components / Server Actions / Route Handlers:
 *     import { createClient } from '@/lib/supabase/server'
 *   Client Components:
 *     import { createBrowserClient } from '@/lib/supabase/client'
 */

// Server-side (async, cookie-based session)
export { createClient } from './server'

// Browser-side (stateless, used in Client Components)
export { createClient as createBrowserClient } from './client'
