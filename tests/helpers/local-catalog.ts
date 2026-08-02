// tests/helpers/local-catalog.ts
//
// Read-only catalog access for the privilege tests.
//
// WHY THIS PROBES INSTEAD OF ASSUMING
//
// tests/database-role-safety.test.ts and tests/database-default-privileges.test.ts
// run under the DEFAULT vitest config, i.e. inside `pnpm test:unit`. That suite
// must stay runnable on a machine with no Docker and no local stack, so the
// live half of those files is skipped when the stack is unreachable while the
// offline half always runs.
//
// The skip is deliberately NOT silent about which half ran: `LIVE_CATALOG` is
// exported so each file can name the reason in its describe block, and the
// offline invariants (which are the ones that would catch a bad edit to the
// prepared SQL) are never skipped for any reason.
//
// The connection uses the `readonly_audit` capability, which is local-only and
// opens with `default_transaction_read_only = on`. A write that slipped into a
// test would be refused by the server, not merely by review.

import { createLocalDatabaseClient } from '@/db/client'

export interface LocalCatalog {
  readonly available: boolean
  readonly reason: string | null
  readonly sql: ReturnType<typeof createLocalDatabaseClient>['sql'] | null
  close(): Promise<void>
}

/**
 * Upper bound on the probe.
 *
 * A refused connection rejects immediately, but a port that accepts and then
 * never speaks — a container mid-restart, a stale forward — would otherwise
 * hang `pnpm test:unit` rather than skip it. Failing to a skip is the right
 * direction here: the offline layer still runs and still catches bad edits.
 */
const PROBE_TIMEOUT_MS = 5_000

async function probe(): Promise<LocalCatalog> {
  let client: ReturnType<typeof createLocalDatabaseClient> | null = null
  try {
    client = createLocalDatabaseClient({ capability: 'readonly_audit' })
    // A trivial round trip: proves the socket, the auth and the read-only
    // session all work before any test depends on them.
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      client.sql`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('LocalCatalogProbeTimeout')), PROBE_TIMEOUT_MS)
      }),
    ]).finally(() => clearTimeout(timer))
    const handle = client
    return {
      available: true,
      reason: null,
      sql: handle.sql,
      close: () => handle.close(),
    }
  } catch (error) {
    if (client) {
      // Best effort: the pool may never have opened.
      await client.close().catch(() => undefined)
    }
    return {
      available: false,
      // Credential-free: postgres-js errors carry no URL, but the message is
      // narrowed to a code/name anyway so nothing can leak through here.
      reason: error instanceof Error ? error.name : 'unknown',
      sql: null,
      close: async () => undefined,
    }
  }
}

/** Resolved once per test file, at module scope, so `describe.skipIf` can use it. */
export const LIVE_CATALOG: LocalCatalog = await probe()

/**
 * Tag function for the live queries.
 *
 * Exported as a CONST rather than an accessor so call sites can write
 * `catalogSql<Row[]>\`SELECT ...\`` — a tagged template with explicit type
 * arguments needs a plain identifier as its tag; `accessor()<T>\`...\`` does
 * not parse the way it reads.
 *
 * It is `null` when the stack is unreachable, and every consumer sits inside a
 * `describe.skipIf(!LIVE_CATALOG.available)` block, so the assertion below can
 * only be reached by a test that forgot its guard — which is exactly when a
 * loud failure is wanted.
 */
export const catalogSql = LIVE_CATALOG.sql as NonNullable<LocalCatalog['sql']>
