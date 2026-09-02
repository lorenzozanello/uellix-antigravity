// tests/integration/_owner.ts
//
// FIXTURE PATH for the integration suites, post runtime cutover.
//
// These suites used to seed and clean their fixtures through the shared `db`
// export — which connected as `postgres` and bypassed RLS. After the cutover
// `db` authenticates as `uellix_app`, RLS applies, and a bare
// `db.insert(organizations)` with no identity context is refused (42501).
// That is the CORRECT production behaviour; test fixtures are the thing that
// has to move, and this module is where they moved to.
//
// It reaches `uellix_owner` exactly the way the migration wrapper does:
// authenticate as `uellix_migrator` (its own credential file, own capability
// guard, loopback + this worktree's port only) and `SET LOCAL ROLE
// uellix_owner` inside a transaction. The owner is exempt from RLS on its own
// tables (FORCE ROW LEVEL SECURITY is off) and CAN seed cross-organisation
// fixtures — while the append-only triggers still fire for it, which is
// precisely what the trigger tests exercise through this same path.
//
// NOTHING HERE WIDENS THE RUNTIME: the suites' assertions keep running
// through the PostgREST role clients and the `uellix_app` shared client; only
// fixture setup/teardown and the deliberate owner-path probes come through
// here.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { config as loadEnvFile } from 'dotenv'
import { createMigratorClient } from '@/db/migrator'
import type { DatabaseClient } from '@/db/client'

let client: DatabaseClient | null = null

function ownerClient(): DatabaseClient {
  if (client) return client
  const migrationEnv = path.resolve(process.cwd(), '.env.migration.local')
  if (existsSync(migrationEnv)) loadEnvFile({ path: migrationEnv, quiet: true })
  client = createMigratorClient()
  return client
}

/**
 * Run one statement as `uellix_owner`, in its own transaction.
 *
 * Errors propagate raw (the postgres-js error, e.g. the append-only trigger's
 * 42501) and the transaction rolls back — which is what the trigger probes
 * assert on.
 */
export async function ownerExecute(query: string): Promise<void> {
  const sql = ownerClient().sql
  await sql.begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE uellix_owner')
    await tx.unsafe(query)
  })
}

/** Run one query as `uellix_owner` and return its rows. */
export async function ownerRows(query: string): Promise<Record<string, string>[]> {
  const sql = ownerClient().sql
  const rows = await sql.begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE uellix_owner')
    return tx.unsafe(query)
  })
  return rows as unknown as Record<string, string>[]
}

/** Close the owner connection. Call from the suite's afterAll. */
export async function closeOwnerConnection(): Promise<void> {
  if (client) {
    await client.close()
    client = null
  }
}
