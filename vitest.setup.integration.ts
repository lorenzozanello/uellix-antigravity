// vitest.setup.integration.ts
//
// FAIL-CLOSED ENTRY GATE for the integration suites.
//
// Vitest evaluates setup files before the module graph of each test file, so
// this is the last point at which we can refuse to run *before* any test
// module imports `@/db/client`, constructs a Supabase admin client, or calls
// `auth.admin.createUser`.
//
// Two independent controls, both required:
//
//   1. An eager assertion on the resolved targets. `pnpm test:integration`
//      against a remote `DATABASE_URL` now aborts here — before a connection,
//      before a user, before a row — instead of quietly rewriting a managed
//      database with test fixtures.
//   2. `restrictDefaultDatabaseClient`, which narrows the capability the
//      shared `db` export will be created with, from `app_runtime` (which may
//      legitimately be remote) to `local_integration_test` (which may not).
//      It can only narrow, and only before the first query.

import * as dotenv from 'dotenv'
import path from 'path'
import { restrictDefaultDatabaseClient } from './db/client'
import {
  assertDatabaseOperationAllowed,
  assertSupabaseApiOperationAllowed,
  DatabaseSafetyError,
} from './db/safety/database-access'
import { resolveRuntimeDatabaseUrl } from './db/safety/resolve-capability-database-url'
import { LOCAL_API_PORT, LOCAL_DB_PORT, LOCAL_SUPABASE_API_URL } from './db/safety/local-stack'

// Loads local anon/service-role keys and UELLIX_RUNTIME_DATABASE_URL — the
// capability variable the shared client resolves. DATABASE_URL is inert since
// the cutover and is deliberately not consulted here (reaudit finding M2).
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

function abort(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  console.error('\n================================================================')
  console.error('INTEGRATION TESTS REFUSED TO START')
  console.error(message)
  console.error('')
  console.error('Integration suites create users and write fixtures. They are')
  console.error(`restricted to this worktree's local stack (loopback, db port`)
  console.error(`${LOCAL_DB_PORT}, api port ${LOCAL_API_PORT}). Start it with`)
  console.error('`pnpm supabase start` and re-run.')
  console.error('================================================================\n')
  // Non-zero exit rather than a thrown error: a throw inside a setup file is
  // reported per-file and later files would still be attempted.
  process.exit(1)
}

try {
  // Role first (uellix_app, named variable, value never logged), target second
  // (loopback + this worktree's port under local_integration_test).
  const resolved = resolveRuntimeDatabaseUrl()
  for (const warning of resolved.warnings) console.warn(`[integration] ${warning}`)

  const dbDecision = assertDatabaseOperationAllowed({
    url: resolved.url,
    capability: 'local_integration_test',
    expectedLocalPort: LOCAL_DB_PORT,
  })

  const apiDecision = assertSupabaseApiOperationAllowed({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || LOCAL_SUPABASE_API_URL,
    capability: 'local_integration_test',
    expectedLocalPort: LOCAL_API_PORT,
  })

  console.log(`[integration] ${dbDecision.auditLine}`)
  console.log(`[integration] supabase-api ${apiDecision.auditLine}`)
} catch (error) {
  if (error instanceof DatabaseSafetyError || error instanceof Error) abort(error)
  throw error
}

try {
  restrictDefaultDatabaseClient({
    capability: 'local_integration_test',
    expectedLocalPort: LOCAL_DB_PORT,
  })
} catch (error) {
  // ONLY "already applied" is tolerable — tests/integration/_guard.ts (which
  // every integration file imports first, so the gate does not depend on the
  // config) may have got there first. A bare catch would also have swallowed
  // DB_RESTRICTION_TOO_LATE, the one case where the restriction did NOT apply.
  if ((error as { code?: string }).code !== 'DB_RESTRICTION_ALREADY_APPLIED') abort(error)
}
