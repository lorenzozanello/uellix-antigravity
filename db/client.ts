import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import {
  assertDatabaseOperationAllowed,
  CAPABILITY_POLICIES,
  type DatabaseCapability,
  type DatabaseOperationDecision,
  type DeploymentEnvironment,
} from './safety/database-access'
import type { EnvironmentSource } from './safety/database-target'
import { getBoundDatabaseContext } from './identity-store'
import { gateSqlOnRuntimeIdentity } from './runtime-gate'
import { LOCAL_DB_PORT } from './safety/local-stack'
import { resolveLocalDatabaseUrl } from './safety/resolve-local-database-url'
import { resolveRuntimeDatabaseUrl } from './safety/resolve-capability-database-url'

// db/client.ts
//
// SINGLE CHOKEPOINT for every Postgres connection in this repository.
//
// Two things changed here during the database-access hardening:
//
//  1. NO IMPORT-TIME SIDE EFFECT. This module used to build a postgres-js
//     client in its module body from the ambient connection variable. Because
//     65 modules import it — including `lib/*` files that scripts pull in
//     transitively — the connection target was captured, unguarded, before
//     any script had a chance to run a check: ESM evaluates imports before
//     the importing module's first statement, so "put a guard at the top of
//     the seed" was structurally impossible. The default client is now built
//     lazily, on first use, which is also the first moment a capability is
//     known.
//
//  2. EVERY CLIENT IS GUARDED. `createDatabaseClient` runs
//     `assertDatabaseOperationAllowed` before the driver is constructed.
//     There is no exported path to an unguarded connection.
//
// The application runtime is deliberately unchanged in behaviour: `db` is
// still a drizzle instance with the same schema and the same query surface,
// and `app_runtime` still permits remote targets without any destructive
// flag.

export interface DatabaseClient {
  readonly db: PostgresJsDatabase<typeof schema>
  /** Raw postgres-js handle, for scripts that need tagged-template SQL. */
  readonly sql: postgres.Sql
  readonly decision: DatabaseOperationDecision
  close(): Promise<void>
}

export interface CreateDatabaseClientOptions {
  readonly connectionString: string | null | undefined
  readonly capability: DatabaseCapability
  readonly environment?: DeploymentEnvironment
  readonly expectedLocalPort?: number
  readonly expectedProjectId?: string
  readonly confirmation?: string
  readonly operation?: string
  readonly env?: EnvironmentSource
  readonly containerHosts?: readonly string[]
  /**
   * Extra postgres-js options. `prepare: false` is always forced, and any key
   * that could redirect the connection is REFUSED — see
   * `TARGET_DETERMINING_OPTIONS`.
   */
  readonly postgresOptions?: postgres.Options<Record<string, postgres.PostgresType>>
}

/**
 * postgres-js resolves its target as `o.hostname || o.host || multihost ||
 * url.hostname` (src/index.js `parseOptions`) — an options object BEATS the
 * connection string. Accepting these keys would mean the guard classified one
 * destination while the driver dialled another, which is the same class of
 * defect as the multihost divergence. They are refused rather than merged.
 */
const TARGET_DETERMINING_OPTIONS = [
  'host',
  'hostname',
  'port',
  'path',
  'socket',
  'database',
  'db',
  'user',
  'username',
  'pass',
  'password',
] as const

/**
 * Startup-packet keys the guard itself sets. A caller supplying one could
 * overwrite the read-only enforcement: postgres-js keeps `...o.connection` in
 * the same object, and both settings travel in one startup packet.
 *
 * Values here are already lowercase — the caller's keys are normalised to
 * lowercase before comparison (see `createDatabaseClient`), because Postgres
 * GUC names are themselves case-insensitive: `DEFAULT_TRANSACTION_READ_ONLY`
 * reaches the server as the same setting as the lowercase form.
 */
const GUARD_OWNED_CONNECTION_KEYS = ['options', 'default_transaction_read_only'] as const

/**
 * Merge a caller's `postgresOptions.connection` with the read-only flag this
 * guard applies, guaranteeing the protected key wins.
 *
 * Extracted as its own function so it can be tested directly, independent of
 * the earlier `GUARD_OWNED_CONNECTION_KEYS` refusal in `createDatabaseClient`:
 * that check already stops a caller from supplying
 * `default_transaction_read_only` today, but the two are separate layers of
 * the same guarantee, and defense in depth only works if each layer is
 * independently correct — a test that only calls `createDatabaseClient` can
 * never reach this function with a conflicting value, so it can never prove
 * the SPREAD ORDER below is what actually protects the flag.
 *
 * The caller's keys are spread FIRST and the protected key is assigned
 * AFTER, unconditionally when `readOnly` is true — this order is the entire
 * guarantee. Inverting it would let a future caller connection key silently
 * win.
 */
export function mergeGuardedConnectionOptions(
  callerConnection: Record<string, string> | undefined,
  readOnly: boolean
): Record<string, string> {
  const merged: Record<string, string> = { ...(callerConnection ?? {}) }
  if (readOnly) {
    merged.default_transaction_read_only = 'on'
  }
  return merged
}

/** Capabilities whose policy pins TLS. Checked before the guard builds a decision. */
function assertsTlsFor(capability: DatabaseCapability): boolean {
  return CAPABILITY_POLICIES[capability]?.requiresTls === true
}

/**
 * Build a guarded database client.
 *
 * Throws `DatabaseSafetyError` — before any socket is opened and before the
 * connection string is handed to the driver — when the capability does not
 * authorise the classified target.
 */
export function createDatabaseClient(options: CreateDatabaseClientOptions): DatabaseClient {
  // Checked BEFORE the guard: an option that redirects the connection would
  // make the guard's answer describe the wrong destination.
  if (options.postgresOptions) {
    const supplied = options.postgresOptions as Record<string, unknown>
    const offending = TARGET_DETERMINING_OPTIONS.filter((key) => supplied[key] !== undefined)
    if (offending.length > 0) {
      throw new Error(
        `createDatabaseClient: postgresOptions may not contain [${offending.join(', ')}]. ` +
          'postgres-js lets those override the connection string, so the guard would classify one ' +
          'destination while the driver dialled another. Put the target in connectionString.'
      )
    }

    // Case-insensitive: Postgres GUC names are, so `DEFAULT_TRANSACTION_READ_ONLY`
    // must be caught exactly like the lowercase form. The comparison works off
    // a derived lowercase key set — the caller's own object is never mutated.
    const suppliedConnection = (supplied.connection ?? {}) as Record<string, unknown>
    const suppliedConnectionKeysLower = new Set(
      Object.keys(suppliedConnection).map((key) => key.toLowerCase())
    )
    const owned = GUARD_OWNED_CONNECTION_KEYS.filter((key) => suppliedConnectionKeysLower.has(key))
    if (owned.length > 0) {
      throw new Error(
        `createDatabaseClient: postgresOptions.connection may not contain [${owned.join(', ')}]. ` +
          'Those keys carry the read-only enforcement this guard applies, and both the caller\'s ' +
          'value and the guard\'s travel in the same startup packet.'
      )
    }
  }

  // `ssl` may only be RAISED, never lowered. `?? 'verify-full'` alone guarded
  // nullish, so a caller could pass `ssl: false` (plaintext) or
  // `ssl: 'require'` (unauthenticated) to a capability that requires TLS —
  // and the audit line would still have said `tls=verified`. A caller may
  // supply an object, which is the only way to pass a private CA, but not one
  // that turns verification off.
  if (assertsTlsFor(options.capability)) {
    const callerSsl = options.postgresOptions?.ssl
    const verifies =
      callerSsl === undefined ||
      (typeof callerSsl === 'object' &&
        callerSsl !== null &&
        (callerSsl as { rejectUnauthorized?: boolean }).rejectUnauthorized !== false)
    if (!verifies) {
      throw new Error(
        `createDatabaseClient: capability "${options.capability}" requires verified TLS, so ` +
          'postgresOptions.ssl may only be an object that keeps certificate verification on. ' +
          'A string or `false` would downgrade it while the audit line still reported it as verified.'
      )
    }
  }

  const decision = assertDatabaseOperationAllowed({
    url: options.connectionString,
    capability: options.capability,
    environment: options.environment,
    expectedLocalPort: options.expectedLocalPort,
    expectedProjectId: options.expectedProjectId,
    confirmation: options.confirmation,
    operation: options.operation,
    env: options.env,
    containerHosts: options.containerHosts,
  })

  // Safe to assert: the guard rejects `invalid`, and a missing URL is `invalid`.
  const connectionString = options.connectionString as string

  // Read-only capabilities are enforced by the SERVER, not by reviewing the
  // caller's SQL: the startup parameter makes every transaction on this
  // connection read-only, so an accidental INSERT/UPDATE/DDL fails with
  // "cannot execute ... in a read-only transaction" instead of succeeding.
  //
  // It is emitted as a DIRECT startup parameter rather than inside `options`.
  // PostgreSQL processes the `options` field (cmdline_options) BEFORE the
  // per-parameter list, so a direct pair wins over anything smuggled through
  // `-c`. Callers may not supply either key — see GUARD_OWNED_CONNECTION_KEYS.
  const connection = mergeGuardedConnectionOptions(
    options.postgresOptions?.connection as Record<string, string> | undefined,
    decision.readOnly
  )

  const sql = postgres(connectionString, {
    ...options.postgresOptions,
    ...(Object.keys(connection).length > 0
      ? { connection: connection as postgres.Options<Record<string, never>>['connection'] }
      : {}),
    // Pinned in the OPTIONS object, which beats the URL: postgres-js defaults
    // to `ssl: false` and honours `?sslmode=disable`, so without this a
    // controlled remote read against production could run in cleartext.
    //
    // `verify-full`, NOT `require`. In postgres-js, `require`/`allow`/`prefer`
    // set `rejectUnauthorized = false` (src/connection.js) — encryption with
    // no server authentication, which an on-path attacker defeats by
    // presenting any certificate. `verify-full` falls through to `tls.connect`
    // with Node's default verification and sets SNI.
    //
    // A caller-supplied `ssl` OBJECT is honoured instead of being replaced: it
    // is the only way to supply a private CA, and overriding it would turn a
    // verified configuration into a weaker one.
    ...(decision.requiresTls
      ? { ssl: (options.postgresOptions?.ssl as never) ?? ('verify-full' as never) }
      : {}),
    // Not supported in Supabase's "Transaction" pool mode.
    prepare: false,
  })

  return {
    db: drizzle(sql, { schema }),
    sql,
    decision,
    close: () => sql.end(),
  }
}

/** Capabilities that a local-only entry point may open a client with. */
export type LocalDatabaseCapability =
  | 'local_seed'
  | 'local_integration_test'
  | 'local_migration'
  | 'local_reset'
  | 'local_role_credential_rotation'
  | 'readonly_audit'

export interface LocalDatabaseClient extends DatabaseClient {
  /** Credential-free notes from URL resolution, e.g. "ambient URL ignored". */
  readonly warnings: readonly string[]
}

/**
 * One-call helper for local entry points (seeds, fixtures, read-only audit).
 *
 * Resolves the URL from this worktree's pinned local stack — never from the
 * ambient environment — and then runs it through the same fail-closed guard
 * as every other connection.
 */
export function createLocalDatabaseClient(options: {
  capability: LocalDatabaseCapability
  expectedLocalPort?: number
  expectedProjectId?: string
  confirmation?: string
  env?: EnvironmentSource
}): LocalDatabaseClient {
  const env = options.env ?? process.env
  const expectedLocalPort = options.expectedLocalPort ?? LOCAL_DB_PORT
  const resolved = resolveLocalDatabaseUrl(env, { expectedLocalPort })

  const client = createDatabaseClient({
    connectionString: resolved.url,
    capability: options.capability,
    expectedLocalPort,
    expectedProjectId: options.expectedProjectId,
    confirmation: options.confirmation,
    env,
  })

  return { ...client, warnings: resolved.warnings }
}

/* -------------------------------------------------------------------------- */
/* Default application client                                                 */
/* -------------------------------------------------------------------------- */

interface DefaultRestriction {
  readonly capability: DatabaseCapability
  readonly expectedLocalPort?: number
}

let defaultClient: DatabaseClient | null = null
let defaultRestriction: DefaultRestriction | null = null

/**
 * Narrow the capability the DEFAULT client will be created with.
 *
 * Used by the integration-test setup file so that suites which import
 * `{ db }` from this module cannot reach a remote database even though
 * `app_runtime` would allow one.
 *
 * ONE-WAY AND ONE-SHOT. Three refusals, because this function is exported
 * from a module 65 production files import:
 *
 *   * it may not run after a client exists;
 *   * it may not be called twice — a second call cannot re-open what the
 *     first closed, even to the same value;
 *   * it may not select `app_runtime`, the only capability that permits a
 *     remote target. Restricting must never be a way to widen.
 */
export function restrictDefaultDatabaseClient(restriction: DefaultRestriction): void {
  if (defaultClient !== null) {
    // NOT the same as "already restricted". This is the case where the
    // restriction genuinely did NOT apply, so callers must be able to tell it
    // apart and abort instead of swallowing it.
    throw Object.assign(
      new Error(
        'restrictDefaultDatabaseClient() was called after the default database client was already created. ' +
          'The restriction must be applied before any query runs (e.g. from a Vitest setup file).'
      ),
      { code: 'DB_RESTRICTION_TOO_LATE' as const }
    )
  }
  if (defaultRestriction !== null) {
    throw Object.assign(
      new Error(
        'restrictDefaultDatabaseClient() was already called with capability ' +
          `"${defaultRestriction.capability}". The restriction is one-shot: a second call could only ever ` +
          'widen what the first established.'
      ),
      { code: 'DB_RESTRICTION_ALREADY_APPLIED' as const }
    )
  }
  if (restriction.capability === 'app_runtime') {
    throw new Error(
      'restrictDefaultDatabaseClient() cannot select "app_runtime": that is the default and the only ' +
        'capability permitting a remote target, so selecting it would widen rather than narrow.'
    )
  }
  defaultRestriction = restriction
}

/**
 * The shared application client.
 *
 * The connection string comes from `UELLIX_RUNTIME_DATABASE_URL`, which must
 * declare `uellix_app`. It no longer comes from `DATABASE_URL` — that variable
 * meant the runtime, the migrator and the auditor at once, and the most
 * privileged reading always won. See db/safety/resolve-capability-database-url.ts.
 *
 * Resolution still happens lazily, on first use, so importing this module
 * opens no socket and reads no credential.
 */
export function getDefaultDatabaseClient(): DatabaseClient {
  if (defaultClient === null) {
    const resolved = resolveRuntimeDatabaseUrl()
    for (const warning of resolved.warnings) console.warn(`[db] ${warning}`)

    defaultClient = createDatabaseClient({
      connectionString: resolved.url,
      capability: defaultRestriction?.capability ?? 'app_runtime',
      expectedLocalPort: defaultRestriction?.expectedLocalPort,
    })
  }
  return defaultClient
}

function getDefaultClient(): DatabaseClient {
  return getDefaultDatabaseClient()
}

/**
 * The drizzle handle the `db` proxy falls back to OUTSIDE an identity context.
 *
 * Deliberately NOT `getDefaultClient().db`. That handle sits on the raw
 * postgres-js client, and the raw client had never been asked who the server
 * authenticated it as: `ensureRuntimeIdentityVerified` has one caller,
 * db/identity-context.ts, and this path does not go through it. See
 * db/runtime-gate.ts for what that meant for the three entry points that
 * legitimately query outside a context.
 *
 * Built once and cached, because the certification is memoised per handle and a
 * second drizzle instance over the same connection would be a second thing to
 * keep in step for no gain.
 */
let gatedFallbackDatabase: PostgresJsDatabase<typeof schema> | null = null

function getGatedFallbackDatabase(): PostgresJsDatabase<typeof schema> {
  if (gatedFallbackDatabase === null) {
    gatedFallbackDatabase = drizzle(gateSqlOnRuntimeIdentity(getDefaultClient().sql), { schema })
  }
  return gatedFallbackDatabase
}

/**
 * Keys that are module/language protocol rather than part of drizzle's query
 * surface. Reading one is INSPECTION, and inspection must never build a
 * client — only use may.
 *
 * `__esModule` is the CJS/ESM interop marker. It is not cosmetic: Vitest's
 * automocker reads it (and `Symbol.toStringTag`) when a suite writes
 * `vi.mock('@/db/client')` with no factory. Without this rule, three existing
 * service suites that never touch the database would start demanding a live
 * connection URL just to be mocked.
 */
const INERT_PROPERTIES: ReadonlySet<string> = new Set(['__esModule'])

/**
 * The application-wide drizzle instance.
 *
 * A `Proxy` rather than a plain object so that importing this module has no
 * side effect: the underlying postgres-js client — and the guard that
 * authorises it — is created on first use.
 *
 * Only `get` is trapped. Enumeration traps (`ownKeys`,
 * `getOwnPropertyDescriptor`, `has`) would make merely listing this object's
 * keys build a client, so they are deliberately absent and the empty target
 * answers those questions: `Object.keys(db)` is `[]`. Nothing in this
 * repository enumerates a drizzle instance.
 */
export const db: PostgresJsDatabase<typeof schema> = new Proxy(
  {} as PostgresJsDatabase<typeof schema>,
  {
    get(target, property) {
      if (typeof property === 'symbol' || INERT_PROPERTIES.has(property)) {
        return (target as unknown as Record<string | symbol, unknown>)[property]
      }

      // THE CUTOVER'S LOAD-BEARING LINE.
      //
      // Inside `withDatabaseIdentityContext`, this resolves to the drizzle
      // handle bound to that request's transaction — the one carrying the
      // `request.jwt.claims` setting every RLS policy reads. Outside a
      // context, it falls back to the pooled client, which has no claims and
      // therefore sees no rows.
      //
      // The fallback used to be defended as "not a hole: as `uellix_app` a
      // claimless query returns zero rows rather than everything". The premise
      // is the load-bearing half of that sentence, and this path was the one
      // place in the runtime that never checked it — see db/runtime-gate.ts.
      // It now goes through a handle that cannot execute a statement until the
      // server has confirmed which role it authenticated, so BOTH halves of
      // "fails closed as uellix_app" are established rather than one assumed.
      //
      // The in-context branch is unchanged and uncosted: it already awaited the
      // same memoised gate before its transaction opened.
      const bound = getBoundDatabaseContext()
      const real = (bound?.db ?? getGatedFallbackDatabase()) as unknown as Record<string, unknown>
      const value = real[property]
      return typeof value === 'function' ? value.bind(real) : value
    },
  }
)
