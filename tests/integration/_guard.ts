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
// Both controls are idempotent: `restrictDefaultDatabaseClient` is one-shot,
// so whichever of the two runs first wins and the second is a no-op.

import * as dotenv from 'dotenv'
import path from 'path'
import { restrictDefaultDatabaseClient } from '@/db/client'
import {
  assertDatabaseOperationAllowed,
  assertSupabaseApiOperationAllowed,
} from '@/db/safety/database-access'
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
  console.error(`${LOCAL_DB_PORT}, api port ${LOCAL_API_PORT}). Start it with`)
  console.error('`pnpm supabase start` and run `pnpm db:test:integration:local`.')
  console.error('================================================================\n')
  process.exit(1)
}

try {
  assertDatabaseOperationAllowed({
    url: process.env.DATABASE_URL,
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
