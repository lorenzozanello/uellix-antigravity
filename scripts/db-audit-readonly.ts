// scripts/db-audit-readonly.ts
//
// Read-only structural audit of this worktree's local stack.
//
// Usage: pnpm db:audit:readonly
//
// Guarantees:
//   * `readonly_audit` is a LOCAL-ONLY capability; a remote target is refused
//     before the connection is opened. Remote inspection has its own
//     capability (`controlled_remote_read`) and is not reachable from here.
//   * The connection is opened with `default_transaction_read_only=on`, so
//     the server itself rejects any write that slips into this file later —
//     the guarantee does not depend on reviewing the SQL below.
//   * Output contains counts and a redacted host. No connection string, no
//     credentials, no row contents.

import { createLocalDatabaseClient } from '../db/client'
import { DatabaseSafetyError } from '../db/safety/database-access'
import { describeError } from '../db/safety/redact-error'

interface Check {
  readonly label: string
  readonly run: (sql: ReturnType<typeof createLocalDatabaseClient>['sql']) => Promise<string>
}

const CHECKS: Check[] = [
  {
    label: 'public tables',
    run: async (sql) => {
      const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `
      return rows[0].n
    },
  },
  {
    label: 'RLS policies',
    run: async (sql) => {
      const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM pg_policies WHERE schemaname = 'public'
      `
      return rows[0].n
    },
  },
  {
    // The append-only guarantee is enforced by TWO trigger families and the
    // documented total counts both: `*_append_only` (row-level BEFORE
    // INSERT/UPDATE/DELETE, tgtype 27) and `*_no_truncate` (statement-level
    // BEFORE TRUNCATE, tgtype 34, added by stella_0002b — the only layer that
    // reaches the table owner). Counting just one family under-reports by half.
    label: 'append-only triggers (total)',
    run: async (sql) => {
      const rows = await sql<{ total: string; rowLevel: string; truncate: string }[]>`
        SELECT count(*)::text AS "total",
               count(*) FILTER (WHERE t.tgname LIKE '%\_append\_only')::text AS "rowLevel",
               count(*) FILTER (WHERE t.tgname LIKE '%\_no\_truncate')::text AS "truncate"
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal
          AND n.nspname = 'public'
          AND (t.tgname LIKE '%\_append\_only' OR t.tgname LIKE '%\_no\_truncate')
      `
      const row = rows[0]
      return `${row.total}  (row-level ${row.rowLevel}, truncate ${row.truncate})`
    },
  },
  {
    label: 'stella_suggestion_decisions rows',
    run: async (sql) => {
      const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM public.stella_suggestion_decisions
      `
      return rows[0].n
    },
  },
  {
    label: 'stella_interactions rows',
    run: async (sql) => {
      const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM public.stella_interactions`
      return rows[0].n
    },
  },
  {
    label: 'evidence_chunks present',
    run: async (sql) => {
      const rows = await sql<{ present: boolean }[]>`
        SELECT to_regclass('public.evidence_chunks') IS NOT NULL AS present
      `
      return String(rows[0].present)
    },
  },
  {
    // Proves the guarantee is enforced by the SERVER, not by trusting that
    // the queries above happen to be SELECTs. `SHOW` returns a row keyed by
    // the setting name, so read it through current_setting() instead.
    label: 'session is read-only',
    run: async (sql) => {
      const rows = await sql<{ v: string }[]>`
        SELECT current_setting('default_transaction_read_only') AS v
      `
      // FAILS, not merely reports. This check previously printed whatever the
      // server said and counted as passing either way — so an audit running
      // with the enforcement defeated would have exited 0 with `off` on
      // screen, which is worse than no check at all.
      if (rows[0].v !== 'on') {
        throw new Error(
          `read-only enforcement is NOT active (default_transaction_read_only=${rows[0].v}). ` +
            'Refusing to report an audit as read-only when it was not.'
        )
      }
      return rows[0].v
    },
  },
]

async function main(): Promise<void> {
  let client: ReturnType<typeof createLocalDatabaseClient>
  try {
    client = createLocalDatabaseClient({ capability: 'readonly_audit' })
  } catch (error) {
    if (error instanceof DatabaseSafetyError) {
      console.error(`[db:audit:readonly] refused: ${error.message}`)
      process.exit(1)
    }
    throw error
  }

  for (const warning of client.warnings) console.warn(`[db:audit:readonly] ${warning}`)
  console.log(`[db:audit:readonly] ${client.decision.auditLine}`)
  console.log('')

  let failures = 0
  for (const check of CHECKS) {
    try {
      const value = await check.run(client.sql)
      console.log(`  ${check.label.padEnd(34)} ${value}`)
    } catch (error) {
      failures += 1
      console.log(
        `  ${check.label.padEnd(34)} ERROR: ${describeError(error)}`
      )
    }
  }

  await client.close()
  console.log('')
  console.log(`[db:audit:readonly] ${CHECKS.length - failures}/${CHECKS.length} checks readable.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[db:audit:readonly] Failed:', describeError(error))
  process.exit(1)
})
