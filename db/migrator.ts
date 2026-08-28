// db/migrator.ts
//
// The owner-scoped migration path.
//
// BEFORE THE CUTOVER, `pnpm db:migrate:local` ran drizzle-kit against
// `postgresql://postgres:postgres@…`. Every object it created was therefore
// owned by `postgres` — the same role the application connected as — which is
// how 38 tables ended up owned by their own runtime, and how
// `drizzle.__drizzle_migrations` still is.
//
// AFTER THE CUTOVER the chain is:
//
//     connect as uellix_migrator   (LOGIN, no CREATE anywhere, no BYPASSRLS)
//       └── SET ROLE uellix_owner  (NOLOGIN, owns everything in public)
//             └── run the DDL
//
// Two roles rather than one, because the property we want is not "a powerful
// role exists" but "the powerful role cannot be authenticated as". `uellix_owner`
// is NOLOGIN and holds no password; the only way to become it is an explicit
// `SET ROLE` from a session that is already `uellix_migrator`, and that
// membership is `set_option = true, inherit_option = false` — SET-only, never
// inherited. A migrator session that forgets to SET ROLE has no more privilege
// than a bystander, which is exactly why `assertOwnerRoleActive` is not
// optional.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type postgres from 'postgres'
import { createDatabaseClient, type DatabaseClient } from './client'
import { MIGRATOR_DATABASE_ROLE, OWNER_DATABASE_ROLE } from './safety/database-role'
import { resolveMigratorDatabaseUrl } from './safety/resolve-capability-database-url'
import { LOCAL_DB_PORT } from './safety/local-stack'
import type { EnvironmentSource } from './safety/database-target'
import {
  PROJECT_BLIND_SIGNATURES_PRESENT_PROBE,
  PROJECT_BLIND_TICKET_SIGNATURES,
  packageOrderRefusal,
  supersessionsFor,
} from './prepared-package-order'

export type MigratorErrorCode =
  | 'DB_MIGRATOR_WRONG_SESSION_ROLE'
  | 'DB_MIGRATOR_OVERPRIVILEGED'
  | 'DB_MIGRATOR_SET_ROLE_FAILED'
  | 'DB_MIGRATOR_SCRIPT_FAILED'
  | 'DB_MIGRATOR_POSTCONDITION_FAILED'
  /**
   * TRAIN 4.2, R2a. The script is being applied to a database that already has
   * a package which SUPERSEDES it, and applying it would republish a surface
   * the successor exists to remove. Raised as a PRECONDITION, before the script
   * runs, so nothing unsafe is ever published — see db/prepared-package-order.ts.
   */
  | 'DB_MIGRATOR_PACKAGE_ORDER_VIOLATION'

export class MigratorError extends Error {
  readonly name = 'MigratorError'
  readonly code: MigratorErrorCode

  constructor(code: MigratorErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/* -------------------------------------------------------------------------- */
/* Session assertions                                                         */
/* -------------------------------------------------------------------------- */

interface SessionIdentity {
  readonly session_user: string
  readonly current_user: string
  readonly is_superuser: boolean
  readonly is_bypassrls: boolean
  readonly is_createrole: boolean
}

async function readSessionIdentity(sql: postgres.Sql): Promise<SessionIdentity> {
  const [row] = await sql<SessionIdentity[]>`
    SELECT
      session_user::text                              AS session_user,
      current_user::text                              AS current_user,
      COALESCE(r.rolsuper, false)                     AS is_superuser,
      COALESCE(r.rolbypassrls, false)                 AS is_bypassrls,
      COALESCE(r.rolcreaterole, false)                AS is_createrole
    FROM (SELECT session_user AS name) s
    LEFT JOIN pg_roles r ON r.rolname = s.name
  `
  return row
}

/**
 * Assert the connection authenticated as the migrator and nothing stronger.
 *
 * The attributes are read for `session_user`, not `current_user`: role
 * attributes belong to the authenticated identity and do not change when
 * `SET ROLE` does. Reading them after the SET ROLE would answer a question
 * nobody asked.
 */
export async function assertMigratorSession(sql: postgres.Sql): Promise<SessionIdentity> {
  const identity = await readSessionIdentity(sql)

  if (identity.session_user !== MIGRATOR_DATABASE_ROLE) {
    throw new MigratorError(
      'DB_MIGRATOR_WRONG_SESSION_ROLE',
      `Migrations must run on a connection authenticated as "${MIGRATOR_DATABASE_ROLE}", ` +
        `but this session authenticated as "${identity.session_user}".`
    )
  }

  if (identity.is_superuser || identity.is_bypassrls || identity.is_createrole) {
    throw new MigratorError(
      'DB_MIGRATOR_OVERPRIVILEGED',
      `"${MIGRATOR_DATABASE_ROLE}" carries superuser, BYPASSRLS or CREATEROLE. The migration ` +
        'path is supposed to reach its privilege through SET ROLE, not to start with it.'
    )
  }

  return identity
}

/**
 * Assert that `SET ROLE` actually took effect.
 *
 * A failed `SET ROLE` does not always raise: `SET LOCAL ROLE` outside a
 * transaction block is a WARNING, not an error, and the session simply carries
 * on as the migrator. Every subsequent CREATE would then fail with a
 * permission error far from the cause, or — worse, on a database where the
 * migrator did have CREATE — succeed with the wrong owner.
 */
export async function assertOwnerRoleActive(sql: postgres.Sql): Promise<void> {
  const identity = await readSessionIdentity(sql)

  if (identity.current_user !== OWNER_DATABASE_ROLE) {
    throw new MigratorError(
      'DB_MIGRATOR_SET_ROLE_FAILED',
      `SET ROLE ${OWNER_DATABASE_ROLE} did not take effect: current_user is ` +
        `"${identity.current_user}". DDL run from here would create objects with the wrong owner.`
    )
  }

  if (identity.session_user !== MIGRATOR_DATABASE_ROLE) {
    throw new MigratorError(
      'DB_MIGRATOR_WRONG_SESSION_ROLE',
      `current_user is "${OWNER_DATABASE_ROLE}" but session_user is "${identity.session_user}". ` +
        'The owner was reached from an unexpected identity.'
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Post-application verification                                              */
/* -------------------------------------------------------------------------- */

export interface OwnershipReport {
  readonly tablesNotOwnedByOwner: readonly string[]
  readonly functionsNotOwnedByOwner: readonly string[]
  readonly sequencesNotOwnedByOwner: readonly string[]
  readonly typesNotOwnedByOwner: readonly string[]
  readonly publicExecutableFunctions: readonly string[]
  readonly publicUsableTypes: readonly string[]
}

/**
 * Everything in `public` must belong to `uellix_owner`, and nothing new may be
 * reachable by PUBLIC.
 *
 * This runs INSIDE the migration transaction, before COMMIT, so a script that
 * created a PUBLIC-executable function is rolled back rather than reported
 * after the fact.
 */
export async function verifyOwnershipAndAcl(sql: postgres.Sql): Promise<OwnershipReport> {
  const [row] = await sql<OwnershipReport[]>`
    SELECT
      COALESCE((SELECT array_agg(c.relname::text ORDER BY c.relname)
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
                  AND pg_get_userbyid(c.relowner) <> ${OWNER_DATABASE_ROLE}), '{}') AS "tablesNotOwnedByOwner",
      COALESCE((SELECT array_agg(p.proname::text ORDER BY p.proname)
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'
                  AND pg_get_userbyid(p.proowner) <> ${OWNER_DATABASE_ROLE}), '{}') AS "functionsNotOwnedByOwner",
      COALESCE((SELECT array_agg(c.relname::text ORDER BY c.relname)
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind = 'S'
                  AND pg_get_userbyid(c.relowner) <> ${OWNER_DATABASE_ROLE}), '{}') AS "sequencesNotOwnedByOwner",
      COALESCE((SELECT array_agg(t.typname::text ORDER BY t.typname)
                FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname = 'public'
                  AND t.typtype IN ('c','d','e','r')
                  AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')
                  AND pg_get_userbyid(t.typowner) <> ${OWNER_DATABASE_ROLE}), '{}') AS "typesNotOwnedByOwner",
      COALESCE((SELECT array_agg(p.proname::text ORDER BY p.proname)
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'
                  AND has_function_privilege('public', p.oid, 'EXECUTE')), '{}') AS "publicExecutableFunctions",
      COALESCE((SELECT array_agg(t.typname::text ORDER BY t.typname)
                FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname = 'public' AND t.typtype IN ('c','d','e','r')
                  AND has_type_privilege('public', t.oid, 'USAGE')
                  AND t.typacl IS NOT NULL), '{}') AS "publicUsableTypes"
  `
  return row
}

function describeReport(report: OwnershipReport): string[] {
  const problems: string[] = []
  const add = (label: string, names: readonly string[]) => {
    if (names.length > 0) problems.push(`${label}: ${names.join(', ')}`)
  }
  add(`tables not owned by ${OWNER_DATABASE_ROLE}`, report.tablesNotOwnedByOwner)
  add(`functions not owned by ${OWNER_DATABASE_ROLE}`, report.functionsNotOwnedByOwner)
  add(`sequences not owned by ${OWNER_DATABASE_ROLE}`, report.sequencesNotOwnedByOwner)
  add(`types not owned by ${OWNER_DATABASE_ROLE}`, report.typesNotOwnedByOwner)
  add('functions executable by PUBLIC', report.publicExecutableFunctions)
  add('types usable by PUBLIC', report.publicUsableTypes)
  return problems
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Open the migrator connection.
 *
 * `max: 1` is a correctness requirement, not a tuning choice. `SET ROLE` is
 * session state; with a pool of two, half the statements could run on a
 * connection that never received it.
 */
export function createMigratorClient(env: EnvironmentSource = process.env): DatabaseClient {
  const resolved = resolveMigratorDatabaseUrl(env)
  return createDatabaseClient({
    connectionString: resolved.url,
    capability: 'local_migration',
    expectedLocalPort: LOCAL_DB_PORT,
    env,
    postgresOptions: { max: 1 },
  })
}

/* -------------------------------------------------------------------------- */
/* Applying a prepared script                                                 */
/* -------------------------------------------------------------------------- */

/**
 * TRAIN 4.2, R2a. Refuse to apply a prepared script over a package that
 * supersedes it.
 *
 * Runs the registry's fixed probe — a literal from `db/prepared-package-order.ts`,
 * never composed here and never carrying a value from the file being applied —
 * and throws when the successor is present. Scripts with no registered
 * supersession (every package but one, today) reach zero round trips.
 *
 * Exported so `scripts/` and the E2E battery can ask the same question of a
 * database without applying anything.
 */
export async function assertPreparedPackageOrder(sql: postgres.Sql, filePath: string): Promise<void> {
  for (const rule of supersessionsFor(filePath)) {
    const rows = await sql.unsafe(rule.probe)
    const installed = (rows as unknown as Array<{ installed?: unknown }>)[0]?.installed === true
    const refusal = packageOrderRefusal(rule, installed)
    if (refusal !== null) {
      throw new MigratorError('DB_MIGRATOR_PACKAGE_ORDER_VIOLATION', refusal)
    }
  }
}

/**
 * The machine-checkable other half: no project-blind ticket signature exists.
 *
 * A guard proves that a REFUSAL happened; this proves the STATE the refusal was
 * protecting. Both are needed — a run that never attempted the reapply would
 * satisfy the first vacuously.
 */
export async function assertNoProjectBlindTicketSignatures(sql: postgres.Sql): Promise<void> {
  const rows = await sql.unsafe(PROJECT_BLIND_SIGNATURES_PRESENT_PROBE)
  if ((rows as unknown as Array<{ present?: unknown }>)[0]?.present === true) {
    throw new MigratorError(
      'DB_MIGRATOR_PACKAGE_ORDER_VIOLATION',
      'this database publishes at least one project-blind operation-ticket signature ' +
        `(${PROJECT_BLIND_TICKET_SIGNATURES.join(', ')}). stella_0015 drops all four; their ` +
        'presence means a superseded package was applied after it.',
    )
  }
}

export interface ApplyPreparedScriptResult {
  readonly file: string
  readonly sha256: string
  readonly bytes: number
  readonly report: OwnershipReport
}

export interface ApplyOptions {
  /** Roll back instead of committing. Used by the dry-run and by tests. */
  readonly dryRun?: boolean
  /** Injected for tests. Defaults to a real migrator connection. */
  readonly client?: DatabaseClient
  readonly log?: (message: string) => void
  /**
   * R3.4 applies 0003 before 0004 transfers ownership of the pre-existing
   * public objects. 0003's own SQL self-check is still mandatory, but the
   * global ownership report becomes meaningful only after the 0004 phase.
   */
  readonly verifyOwnershipAndAcl?: boolean
}

/**
 * Apply one prepared SQL file as `uellix_owner`, in a single transaction.
 *
 * ORDER MATTERS AND IS THE WHOLE DESIGN:
 *
 *   1. assert we authenticated as the migrator, and only as the migrator;
 *   2. BEGIN;
 *   3. SET LOCAL ROLE uellix_owner — LOCAL, so the role cannot outlive the
 *      transaction even on a connection that is reused;
 *   4. assert the SET ROLE took;
 *   5. run the script;
 *   6. verify ownership and ACLs BEFORE COMMIT;
 *   7. COMMIT, or roll the whole thing back.
 *
 * The script's own text is never logged — only its SHA-256, so a run can be
 * tied to an exact file without reproducing whatever the file contained.
 */
export async function applyPreparedScript(
  filePath: string,
  options: ApplyOptions = {}
): Promise<ApplyPreparedScriptResult> {
  const log = options.log ?? ((message: string) => console.log(message))
  const source = readFileSync(filePath, 'utf8')
  const sha256 = createHash('sha256').update(source, 'utf8').digest('hex')

  const client = options.client ?? createMigratorClient()
  const ownsClient = options.client === undefined

  log(`[migrator] file=${filePath}`)
  log(`[migrator] sha256=${sha256} bytes=${source.length}`)

  // Written from inside the transaction callback and read after it. A plain
  // `let` would be narrowed to `null` by control-flow analysis at the read
  // site, because TypeScript cannot see that the callback ran.
  const captured: { report: OwnershipReport | null } = { report: null }

  try {
    await assertMigratorSession(client.sql)

    // `sql.begin` rolls back on any thrown error, including the ones thrown by
    // the assertions below — so a failed postcondition undoes the script
    // rather than reporting on a change that already landed.
    await client.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${OWNER_DATABASE_ROLE}`)
      await assertOwnerRoleActive(tx as unknown as postgres.Sql)

      // TRAIN 4.2, R2a — THE PACKAGE-ORDER PRECONDITION.
      //
      // Inside the transaction and BEFORE the script runs, so a refusal rolls
      // back and the superseded surface is never published — not even for the
      // duration of a transaction another session could not have seen anyway.
      // A postcondition would be strictly worse: it would have to drop
      // functions it did not write, and it would already have committed on any
      // path that skipped it.
      await assertPreparedPackageOrder(tx as unknown as postgres.Sql, filePath)

      try {
        // Simple protocol: the file is many statements, and PostgreSQL treats
        // the whole string as one unit — the first error aborts all of it,
        // which is the structural equivalent of psql's ON_ERROR_STOP.
        await tx.unsafe(source).simple()
      } catch (error) {
        throw new MigratorError(
          'DB_MIGRATOR_SCRIPT_FAILED',
          `${filePath} failed and the transaction was rolled back: ` +
            (error instanceof Error ? error.message : 'unknown error')
        )
      }

      const report = options.verifyOwnershipAndAcl === false
        ? EMPTY_REPORT
        : await verifyOwnershipAndAcl(tx as unknown as postgres.Sql)
      captured.report = report

      const problems = describeReport(report)
      if (problems.length > 0) {
        throw new MigratorError(
          'DB_MIGRATOR_POSTCONDITION_FAILED',
          `${filePath} left public in an unacceptable state — ${problems.join('; ')}`
        )
      }

      if (options.dryRun) {
        // Not an error condition: the caller asked to prove the script runs
        // without keeping it. Thrown so `sql.begin` rolls back, then swallowed
        // below. The verification above has already run against the uncommitted
        // state, which is the only state a dry run can inspect.
        throw new DryRunRollback()
      }
    })

    log(`[migrator] committed ${filePath}`)
    return { file: filePath, sha256, bytes: source.length, report: captured.report ?? EMPTY_REPORT }
  } catch (error) {
    if (error instanceof DryRunRollback) {
      log(`[migrator] dry run OK, rolled back ${filePath}`)
      return { file: filePath, sha256, bytes: source.length, report: captured.report ?? EMPTY_REPORT }
    }
    throw error
  } finally {
    if (ownsClient) await client.close()
  }
}

const EMPTY_REPORT: OwnershipReport = Object.freeze({
  tablesNotOwnedByOwner: [],
  functionsNotOwnedByOwner: [],
  sequencesNotOwnedByOwner: [],
  typesNotOwnedByOwner: [],
  publicExecutableFunctions: [],
  publicUsableTypes: [],
})

class DryRunRollback extends Error {
  constructor() {
    super('dry run')
  }
}
