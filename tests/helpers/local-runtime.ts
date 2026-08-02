// tests/helpers/local-runtime.ts
//
// Live connections for the cutover suites, using the SAME credentials and the
// SAME factory the application and the migration wrapper use.
//
// WHY NOT `SET ROLE` IN A TEST
//
// The pre-cutover reaudit proved the role model was correct when exercised
// with `SET ROLE` from an administrative session — and the runtime still ran
// as `postgres` the whole time. A test that reaches `uellix_app` by SET ROLE
// re-proves the thing that was already true and misses the thing that was
// false. These helpers therefore AUTHENTICATE as the role, with the real
// credential, through `getDefaultDatabaseClient()` / `createMigratorClient()`.
//
// Like tests/helpers/local-catalog.ts, everything degrades to a skip when the
// stack or the credential files are absent, so `pnpm test:unit` still runs on
// a machine with no Docker.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as loadEnvFile } from 'dotenv'
import type postgres from 'postgres'
import { getDefaultDatabaseClient, type DatabaseClient } from '@/db/client'
import { createMigratorClient } from '@/db/migrator'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

/**
 * Load both credential files.
 *
 * `.env.local` and `.env.migration.local` are separate on purpose — see
 * db/safety/resolve-capability-database-url.ts. A test process legitimately
 * needs both, because it exercises both paths; the point of the split is that
 * the NEXT.JS process only ever loads the first.
 */
function loadCredentials(): void {
  for (const file of ['.env.local', '.env.migration.local']) {
    const path = resolve(REPO_ROOT, file)
    if (existsSync(path)) loadEnvFile({ path, quiet: true })
  }
}

export interface LiveConnection {
  readonly available: boolean
  readonly reason: string | null
  readonly client: DatabaseClient | null
  readonly sql: postgres.Sql | null
  close(): Promise<void>
}

const PROBE_TIMEOUT_MS = 5_000

async function probe(open: () => DatabaseClient): Promise<LiveConnection> {
  let client: DatabaseClient | null = null
  try {
    loadCredentials()
    client = open()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      client.sql`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('LiveConnectionProbeTimeout')), PROBE_TIMEOUT_MS)
      }),
    ]).finally(() => clearTimeout(timer))
    const handle = client
    return {
      available: true,
      reason: null,
      client: handle,
      sql: handle.sql,
      close: () => handle.close(),
    }
  } catch (error) {
    if (client) await client.close().catch(() => undefined)
    return {
      available: false,
      // Name only. postgres-js errors do not carry the URL, and the resolver's
      // errors name the variable rather than its value, but narrowing to the
      // error NAME removes the question entirely.
      reason: error instanceof Error ? error.name : 'unknown',
      client: null,
      sql: null,
      close: async () => undefined,
    }
  }
}

/** The application's own client, authenticated as `uellix_app`. */
export const RUNTIME_CONNECTION: LiveConnection = await probe(() => getDefaultDatabaseClient())

/** The migration wrapper's client, authenticated as `uellix_migrator`. */
export const MIGRATOR_CONNECTION: LiveConnection = await probe(() => createMigratorClient())

export const runtimeSql = RUNTIME_CONNECTION.sql as NonNullable<LiveConnection['sql']>
export const migratorSql = MIGRATOR_CONNECTION.sql as NonNullable<LiveConnection['sql']>
export const runtimeClient = RUNTIME_CONNECTION.client as NonNullable<LiveConnection['client']>

/**
 * A user id that has an active membership, plus their organisation and a
 * DIFFERENT organisation, read once for the RLS suites.
 *
 * Read through the migrator connection rather than the runtime one: the
 * runtime cannot see these rows without a context, which is the property the
 * suites are about. Bootstrapping the fixture from the subject under test
 * would make an empty database look like a passing test.
 */
export interface RlsFixture {
  readonly userId: string
  readonly organizationId: string
  readonly otherOrganizationId: string | null
}

export async function readRlsFixture(): Promise<RlsFixture | null> {
  if (!MIGRATOR_CONNECTION.available) return null

  // `uellix_migrator` holds NO privilege on any table in `public` — that is the
  // point of it. It reaches data only by borrowing the owner, and only inside a
  // transaction, which is the same discipline db/migrator.ts enforces. The
  // owner is exempt from RLS on its own tables (FORCE ROW LEVEL SECURITY is
  // off), so this sees every organisation and can pick two different ones.
  const rows = await migratorSql.begin(async (tx) => {
    await tx.unsafe('SET LOCAL ROLE uellix_owner')
    return tx<RlsFixture[]>`
      SELECT
        om.user_id::text          AS "userId",
        om.organization_id::text  AS "organizationId",
        (SELECT o.id::text FROM public.organizations o
          WHERE o.id <> om.organization_id ORDER BY o.id LIMIT 1) AS "otherOrganizationId"
      FROM public.organization_members om
      WHERE om.status = 'active' AND om.role = 'organization_admin'
      ORDER BY om.user_id
      LIMIT 1
    `
  })

  return (rows as unknown as RlsFixture[])[0] ?? null
}
