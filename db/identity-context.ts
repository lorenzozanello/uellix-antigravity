// db/identity-context.ts
//
// HOW A REQUEST'S IDENTITY REACHES ROW-LEVEL SECURITY.
//
// Measured on this database, the whole RLS surface reduces to one function
// (counts from the pre-stella_0005 measurement; the total is 107 since the
// three append-only INSERT policies landed, rescoped TO uellix_app by 0005c):
//
//     104 policies
//       ├── 98 call current_user_is_super_admin()
//       ├── 33 call current_user_org_ids()
//       └──  6 call auth.uid() directly
//     …and all three of those resolve identity through auth.uid(), which is
//     COALESCE(current_setting('request.jwt.claim.sub'), claims->>'sub').
//
// So "connect as uellix_app" is necessary and does nothing on its own. With no
// claims set, `auth.uid()` is NULL, `current_user_org_ids()` is an empty array,
// and every policy evaluates false: the application connects successfully and
// sees zero rows. Verified, not assumed — that is exactly what the pre-cutover
// probe returned.
//
// The claim therefore has to be set per unit of work, and the ONLY safe scope
// for that is a transaction:
//
//   * `set_config(..., is_local => true)` is undone by COMMIT or ROLLBACK,
//     including a ROLLBACK the driver performs after an exception;
//   * postgres-js hands the same physical connection to the next request when
//     this one finishes, so a SESSION-scoped setting would leak one user's
//     identity into another user's queries — a cross-tenant read with no code
//     path to blame;
//   * a transaction is the only place `SET LOCAL` is even meaningful. Outside
//     one, PostgreSQL raises a WARNING and carries on, which is the worst of
//     both worlds: no error, no effect.
//
// WHAT IS AND IS NOT TRUSTED
//
// `userId` must already have been validated by the server — in this codebase
// that means it came from `supabase.auth.getUser()`, which verifies the JWT
// against GoTrue rather than decoding it. This module cannot re-do that check
// and does not pretend to.
//
// Everything else IS re-checked here, against the database, after the claims
// are set:
//
//   * `organizationId` is confirmed to be one the user actually belongs to.
//     A client-supplied organisation id is otherwise the classic IDOR: RLS
//     would still constrain the rows, but application code that trusts the
//     value for anything else would not.
//   * `isSuperAdmin` is confirmed against `current_user_is_super_admin()`.
//     A caller that inflates it gets an error, not a widened context.

import { sql as drizzleSql } from 'drizzle-orm'
import { getDefaultDatabaseClient, type DatabaseClient } from './client'
import { ensureRuntimeIdentityVerified } from './runtime-bootstrap'
import {
  getBoundDatabaseContext,
  runWithBoundDatabaseContext,
  type BoundDatabaseContext,
  type DatabaseIdentity,
} from './identity-store'

export type IdentityContextErrorCode =
  | 'DB_IDENTITY_INVALID_USER_ID'
  | 'DB_IDENTITY_INVALID_ORGANIZATION_ID'
  | 'DB_IDENTITY_NESTED_MISMATCH'
  | 'DB_IDENTITY_ORGANIZATION_NOT_A_MEMBER'
  | 'DB_IDENTITY_SUPER_ADMIN_CLAIM_REJECTED'
  | 'DB_IDENTITY_CONTEXT_NOT_APPLIED'

export class IdentityContextError extends Error {
  readonly name = 'IdentityContextError'
  readonly code: IdentityContextErrorCode

  constructor(code: IdentityContextErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * RFC 4122 shape, any version.
 *
 * The format check is not decoration: the value is interpolated into a JSON
 * claim document, and `auth.uid()` casts it with `::uuid`. A malformed value
 * would surface as a cast error from deep inside a policy — an error that
 * looks like a database fault rather than a bad input.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertUuid(value: string, code: IdentityContextErrorCode, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    // The value itself is not echoed: it is an identifier belonging to a real
    // person, and error text ends up in logs and issue trackers.
    throw new IdentityContextError(code, `${label} is not a well-formed UUID.`)
  }
}

export interface WithDatabaseIdentityContextOptions {
  /** Injected by tests. Defaults to the shared runtime client. */
  readonly client?: DatabaseClient
}

/**
 * Run `callback` inside a transaction that carries the caller's identity.
 *
 * The handle passed to the callback is bound to that transaction, and so is
 * the ambient `db` export — existing code that imports `{ db }` and queries it
 * directly runs inside this context without modification.
 *
 * On any thrown error the transaction rolls back, which also discards the
 * claims. There is no path that commits a transaction whose identity was
 * rejected, and no path that leaves a claim set on a pooled connection.
 */
export async function withDatabaseIdentityContext<T>(
  identity: DatabaseIdentity,
  callback: (db: BoundDatabaseContext['db']) => Promise<T>,
  options: WithDatabaseIdentityContextOptions = {}
): Promise<T> {
  assertUuid(identity.userId, 'DB_IDENTITY_INVALID_USER_ID', 'userId')
  if (identity.organizationId !== null) {
    assertUuid(
      identity.organizationId,
      'DB_IDENTITY_INVALID_ORGANIZATION_ID',
      'organizationId'
    )
  }

  // NESTING. Re-entering with the SAME identity is legitimate and common: a
  // server action calls a service which calls another service, and each was
  // written to be safe on its own. Re-using the open transaction is correct
  // there — a nested BEGIN would deadlock against its own parent's locks.
  //
  // Re-entering with a DIFFERENT identity is never legitimate. Silently
  // reusing the outer context would run the inner work as the outer user;
  // silently opening a second transaction would let the inner work commit
  // independently of the outer one. Both are worse than an error.
  const existing = getBoundDatabaseContext()
  if (existing !== undefined) {
    if (
      existing.identity.userId !== identity.userId ||
      existing.identity.organizationId !== identity.organizationId
    ) {
      throw new IdentityContextError(
        'DB_IDENTITY_NESTED_MISMATCH',
        'A database identity context is already open for a different user or organisation. ' +
          'Nesting contexts with different identities is refused: the inner work would either ' +
          'run as the outer identity or commit independently of it.'
      )
    }
    return callback(existing.db)
  }

  const client = options.client ?? getDefaultDatabaseClient()

  // The privilege check comes BEFORE the first business query, not after. A
  // connection that turned out to be `postgres` would satisfy every query in
  // this function while making the claims meaningless.
  await ensureRuntimeIdentityVerified(client.sql)

  const claims = JSON.stringify({
    sub: identity.userId,
    role: 'authenticated',
  })

  // DRIZZLE'S TRANSACTION, NOT postgres-js's `sql.begin`.
  //
  // Both open a real transaction on one connection, but only drizzle's hands
  // back a drizzle handle. `drizzle(tx)` over a postgres-js transaction object
  // throws `Cannot read properties of undefined (reading 'parsers')`: the
  // scoped `sql` a transaction yields is a callable without the `options` the
  // driver adapter reads. Measured, not assumed — it was the first thing the
  // RLS suite caught.
  const result = await client.db.transaction(async (tx) => {
    // `is_local => true` — discarded at COMMIT or ROLLBACK, so the identity
    // cannot outlive this transaction on a pooled connection.
    await tx.execute(drizzleSql`SELECT set_config('request.jwt.claims', ${claims}, true)`)

    if (identity.organizationId !== null) {
      await tx.execute(
        drizzleSql`SELECT set_config('app.organization_id', ${identity.organizationId}, true)`
      )
    }

    // Confirmation that the claims actually took effect AND that what the
    // caller claimed is true. Both answers come from the database, evaluated
    // under the claims just set — the same evaluation every policy will do.
    const checkRows = (await tx.execute(drizzleSql`
      SELECT
        (current_setting('request.jwt.claims', true)::jsonb ->> 'sub') AS context_user,
        public.current_user_is_super_admin()                          AS is_super_admin,
        CASE
          WHEN ${identity.organizationId}::uuid IS NULL THEN NULL
          ELSE ${identity.organizationId}::uuid = ANY (public.current_user_org_ids())
        END                                                            AS is_member
    `)) as unknown as {
      context_user: string | null
      is_super_admin: boolean
      is_member: boolean | null
    }[]
    const check = checkRows[0]

    if (check === undefined || check.context_user !== identity.userId) {
      throw new IdentityContextError(
        'DB_IDENTITY_CONTEXT_NOT_APPLIED',
        'The identity claim did not take effect on this connection. Refusing to run queries ' +
          'that would silently see no rows, or the wrong ones.'
      )
    }

    if (identity.isSuperAdmin && !check.is_super_admin) {
      throw new IdentityContextError(
        'DB_IDENTITY_SUPER_ADMIN_CLAIM_REJECTED',
        'The caller claimed super-admin status that the database does not confirm.'
      )
    }

    if (identity.organizationId !== null && check.is_member !== true && !check.is_super_admin) {
      throw new IdentityContextError(
        'DB_IDENTITY_ORGANIZATION_NOT_A_MEMBER',
        'The requested organisation is not one this user is an active member of.'
      )
    }

    const bound: BoundDatabaseContext = {
      identity: { ...identity, isSuperAdmin: check.is_super_admin },
      db: tx as unknown as BoundDatabaseContext['db'],
    }

    return runWithBoundDatabaseContext(bound, () => callback(bound.db))
  })

  return result
}

export { getBoundDatabaseContext } from './identity-store'
export type { DatabaseIdentity, BoundDatabaseContext } from './identity-store'
