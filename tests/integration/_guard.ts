// tests/integration/_guard.ts
//
// PER-FILE fail-closed gate for the integration suites.
//
// `vitest.setup.integration.ts` performs the same check, but it is selected by
// `vitest.integration.config.ts` — so the guarantee held only for whoever ran
// the right config. Running `pnpm test`, or pointing vitest at one of these
// files directly, loaded the base config instead: no setup file, no capability
// assertion, and the shared `db` still on `app_runtime`, which permits a
// managed remote target. An exported remote connection URL was enough to make
// the integration suites create auth users and write fixtures remotely.
//
// Importing this module FIRST in every integration test file moves the gate
// from "depends on the config" to "depends on the file itself".
//
// POST-CUTOVER (reaudit finding M2): the target no longer comes from
// `DATABASE_URL` — that variable is inert everywhere since the capability
// split, and reading it here left this gate pointing at a name nothing
// provisions, which made the whole suite unrunnable. The connection the
// integration tests actually use is the shared `db` client, which resolves
// `UELLIX_RUNTIME_DATABASE_URL`; so THAT is the URL this gate must vet:
//
//   1. resolveRuntimeDatabaseUrl(): the variable exists and declares
//      `uellix_app` — a wrong or administrative role aborts before a socket;
//   2. assertDatabaseOperationAllowed(): the target is THIS worktree's local
//      stack — loopback, db port 56322 — under `local_integration_test`,
//      which permits no remote of any kind;
//   3. the Supabase API target is the local stack too;
//   4. restrictDefaultDatabaseClient(): the shared client is narrowed away
//      from `app_runtime` before its first query.
//
// Both controls are idempotent: `restrictDefaultDatabaseClient` is one-shot,
// so whichever of the two runs first wins and the second is a no-op.

import * as dotenv from 'dotenv'
import path from 'path'
import { restrictDefaultDatabaseClient } from '@/db/client'
import {
  assertDatabaseOperationAllowed,
  assertSupabaseApiOperationAllowed,
} from '@/db/safety/database-access'
import { resolveRuntimeDatabaseUrl } from '@/db/safety/resolve-capability-database-url'
import { LOCAL_API_PORT, LOCAL_DB_PORT, LOCAL_SUPABASE_API_URL } from '@/db/safety/local-stack'
import { describeError } from '@/db/safety/redact-error'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

function abort(error: unknown): never {
  console.error('\n================================================================')
  console.error('INTEGRATION TESTS REFUSED TO START')
  console.error(describeError(error))
  console.error('')
  console.error('Integration suites create users and write fixtures. They are')
  console.error(`restricted to this worktree's local stack (loopback, db port`)
  console.error(`${LOCAL_DB_PORT}, api port ${LOCAL_API_PORT}), reached as uellix_app via`)
  console.error('UELLIX_RUNTIME_DATABASE_URL. Start the stack with `pnpm supabase start`')
  console.error('and run `pnpm db:test:integration:local`.')
  console.error('================================================================\n')
  process.exit(1)
}

try {
  // Role first: names the variable, never its value. DATABASE_URL is not
  // consulted — deliberately, and resolveRuntimeDatabaseUrl warns if it is
  // still exported.
  const resolved = resolveRuntimeDatabaseUrl()
  for (const warning of resolved.warnings) console.warn(`[integration-guard] ${warning}`)

  // Target second: loopback + this worktree's port, no remote of any kind.
  assertDatabaseOperationAllowed({
    url: resolved.url,
    capability: 'local_integration_test',
    expectedLocalPort: LOCAL_DB_PORT,
  })
  assertSupabaseApiOperationAllowed({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || LOCAL_SUPABASE_API_URL,
    capability: 'local_integration_test',
    expectedLocalPort: LOCAL_API_PORT,
  })
} catch (error) {
  abort(error)
}

try {
  restrictDefaultDatabaseClient({
    capability: 'local_integration_test',
    expectedLocalPort: LOCAL_DB_PORT,
  })
} catch (error) {
  // ONLY "already applied" is tolerable — that is the expected path under the
  // integration config, where vitest.setup.integration.ts got there first.
  // A bare `catch {}` would also have swallowed DB_RESTRICTION_TOO_LATE, the
  // one case where the restriction did NOT apply and `db` is still on
  // `app_runtime`.
  if ((error as { code?: string }).code !== 'DB_RESTRICTION_ALREADY_APPLIED') abort(error)
}

export {}
