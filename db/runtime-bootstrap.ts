// db/runtime-bootstrap.ts
//
// ASK THE SERVER WHO IT AUTHENTICATED, BEFORE SERVING ANY TRAFFIC.
//
// A connection URL states an intention. It is configuration — editable,
// copyable, and wrong in exactly the way that matters when someone pastes an
// administrative string into the wrong variable during an incident. The
// reaudit found the model and the reality had been apart for weeks precisely
// because nothing ever compared them: the least-privilege roles existed and
// were correct, and `DATABASE_URL` still resolved to `postgres`.
//
// So this module does not read configuration. It runs one query and checks the
// answers the SERVER gives:
//
//     session_user, current_user, rolsuper, rolbypassrls, rolcreaterole,
//     "can I SET ROLE to the owner", "can I CREATE in public"
//
// If any answer diverges, initialisation aborts with a stable error code and
// no business query is ever issued. Failing closed here means an outage;
// succeeding here while over-privileged means every RLS policy in the database
// is decorative. The outage is the better failure.
//
// THE EXPECTED ROLE IS NOT A PARAMETER. There is no argument, option or
// environment variable that moves it: it is `RUNTIME_DATABASE_ROLE`, imported
// as a constant. A check a caller can retarget is a check an attacker — or a
// tired operator at 3am — can retarget.

import type postgres from 'postgres'
import { OWNER_DATABASE_ROLE, RUNTIME_DATABASE_ROLE } from './safety/database-role'

export type RuntimeIdentityErrorCode =
  | 'DB_RUNTIME_IDENTITY_WRONG_ROLE'
  | 'DB_RUNTIME_IDENTITY_SUPERUSER'
  | 'DB_RUNTIME_IDENTITY_BYPASSRLS'
  | 'DB_RUNTIME_IDENTITY_CREATEROLE'
  | 'DB_RUNTIME_IDENTITY_CAN_SET_OWNER'
  | 'DB_RUNTIME_IDENTITY_CAN_CREATE_PUBLIC'
  | 'DB_RUNTIME_IDENTITY_UNVERIFIABLE'

export class RuntimeIdentityError extends Error {
  readonly name = 'RuntimeIdentityError'
  readonly code: RuntimeIdentityErrorCode

  constructor(code: RuntimeIdentityErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface RuntimeIdentity {
  readonly sessionUser: string
  readonly currentUser: string
  readonly isSuperuser: boolean
  readonly bypassesRls: boolean
  readonly canCreateRole: boolean
  readonly canSetOwnerRole: boolean
  readonly canCreateInPublic: boolean
}

/**
 * One round trip, seven answers.
 *
 * `pg_has_role(..., 'USAGE')` is the right question for "could this session
 * become the owner", and it is NOT the same as `'MEMBER'`: PostgreSQL 16
 * split membership into inherit and set options, so a role can be a MEMBER of
 * another without being able to use or SET ROLE to it. Asking the weaker
 * question here would fail on a perfectly safe configuration; asking a
 * stronger-sounding but wrong one would pass on a dangerous one.
 */
export async function readRuntimeIdentity(sql: postgres.Sql): Promise<RuntimeIdentity> {
  const rows = await sql<
    {
      session_user: string
      current_user: string
      is_superuser: boolean
      bypasses_rls: boolean
      can_create_role: boolean
      can_set_owner_role: boolean
      can_create_in_public: boolean
    }[]
  >`
    SELECT
      session_user::text                                   AS session_user,
      current_user::text                                   AS current_user,
      COALESCE(r.rolsuper, false)                          AS is_superuser,
      COALESCE(r.rolbypassrls, false)                      AS bypasses_rls,
      COALESCE(r.rolcreaterole, false)                     AS can_create_role,
      COALESCE(
        EXISTS (SELECT 1 FROM pg_roles o WHERE o.rolname = ${OWNER_DATABASE_ROLE})
          AND pg_has_role(session_user, ${OWNER_DATABASE_ROLE}, 'USAGE'),
        false
      )                                                    AS can_set_owner_role,
      has_schema_privilege(session_user, 'public', 'CREATE') AS can_create_in_public
    FROM (SELECT session_user AS name) s
    LEFT JOIN pg_roles r ON r.rolname = s.name
  `

  const row = rows[0]
  if (row === undefined) {
    throw new RuntimeIdentityError(
      'DB_RUNTIME_IDENTITY_UNVERIFIABLE',
      'The identity bootstrap query returned no row. Refusing to serve traffic on a connection ' +
        'whose privileges could not be established.'
    )
  }

  return {
    sessionUser: row.session_user,
    currentUser: row.current_user,
    isSuperuser: row.is_superuser,
    bypassesRls: row.bypasses_rls,
    canCreateRole: row.can_create_role,
    canSetOwnerRole: row.can_set_owner_role,
    canCreateInPublic: row.can_create_in_public,
  }
}

/* -------------------------------------------------------------------------- */
/* The rules — ONE table, two readers                                         */
/* -------------------------------------------------------------------------- */

/**
 * What makes an observed identity unacceptable, as DATA rather than as control
 * flow.
 *
 * Until STELLA_STAGING_B this was a chain of six `if (…) throw` statements
 * inside `assertRuntimeIdentity`, which was fine while the bootstrap gate was
 * the only reader. It is not fine with two: the gate needs the FIRST failure
 * (it is aborting startup and wants the most diagnostic message), while the
 * observability endpoint needs EVERY failure (it is describing a deployment and
 * "wrong role" alone would hide that the role also holds BYPASSRLS).
 *
 * Two readers over two hand-written copies of the same six predicates is how a
 * check drifts: someone adds a seventh property to the gate, the endpoint keeps
 * reporting six, and the endpoint reports `verified` on a connection the gate
 * would refuse. So the predicates live here once, and both readers are derived
 * from this array.
 *
 * ORDER IS PART OF THE CONTRACT. `assertRuntimeIdentity` throws on the first
 * entry that matches, and being the wrong role explains every other failure —
 * so it stays first rather than leaving an operator to work out why `postgres`
 * "has BYPASSRLS".
 *
 * No message contains a URL, a password or a claim value.
 */
interface RuntimeIdentityRule {
  readonly code: Exclude<RuntimeIdentityErrorCode, 'DB_RUNTIME_IDENTITY_UNVERIFIABLE'>
  readonly failed: (identity: RuntimeIdentity) => boolean
  readonly message: (identity: RuntimeIdentity) => string
}

const RUNTIME_IDENTITY_RULES: readonly RuntimeIdentityRule[] = Object.freeze([
  {
    code: 'DB_RUNTIME_IDENTITY_WRONG_ROLE',
    failed: (identity) =>
      identity.sessionUser !== RUNTIME_DATABASE_ROLE ||
      identity.currentUser !== RUNTIME_DATABASE_ROLE,
    message: (identity) =>
      `The runtime connection authenticated as session_user="${identity.sessionUser}", ` +
      `current_user="${identity.currentUser}". It must be "${RUNTIME_DATABASE_ROLE}".`,
  },
  {
    code: 'DB_RUNTIME_IDENTITY_SUPERUSER',
    failed: (identity) => identity.isSuperuser,
    message: () =>
      `"${RUNTIME_DATABASE_ROLE}" is a superuser on this database. Row-level security does not ` +
      'apply to superusers, so every policy would be decorative.',
  },
  {
    code: 'DB_RUNTIME_IDENTITY_BYPASSRLS',
    failed: (identity) => identity.bypassesRls,
    message: () =>
      `"${RUNTIME_DATABASE_ROLE}" holds BYPASSRLS. Tenant isolation would depend entirely on ` +
      'application-side filtering, which is the state this cutover exists to leave.',
  },
  {
    code: 'DB_RUNTIME_IDENTITY_CREATEROLE',
    failed: (identity) => identity.canCreateRole,
    message: () =>
      `"${RUNTIME_DATABASE_ROLE}" holds CREATEROLE, which is an escalation path to any ` +
      'non-superuser role on this database.',
  },
  {
    code: 'DB_RUNTIME_IDENTITY_CAN_SET_OWNER',
    failed: (identity) => identity.canSetOwnerRole,
    message: () =>
      `"${RUNTIME_DATABASE_ROLE}" can SET ROLE to "${OWNER_DATABASE_ROLE}". The owner is exempt ` +
      'from RLS on its own tables and can drop policies and triggers.',
  },
  {
    code: 'DB_RUNTIME_IDENTITY_CAN_CREATE_PUBLIC',
    failed: (identity) => identity.canCreateInPublic,
    message: () =>
      `"${RUNTIME_DATABASE_ROLE}" holds CREATE on schema public, which is enough to define a ` +
      'SECURITY DEFINER function and escalate from there.',
  },
])

/**
 * EVERY rule this identity violates, in rule order. Empty means acceptable.
 *
 * The reporting half of the contract. It exists so that an observability
 * surface never has to re-state a predicate: `failures.length === 0` is the
 * same judgement `assertRuntimeIdentity` makes, evaluated over the same table.
 */
export function collectRuntimeIdentityFailures(
  identity: RuntimeIdentity
): readonly RuntimeIdentityErrorCode[] {
  return RUNTIME_IDENTITY_RULES.filter((rule) => rule.failed(identity)).map((rule) => rule.code)
}

/**
 * Throw unless the connection is the least-privilege runtime role.
 *
 * The enforcing half of the contract, and the one the bootstrap gate calls.
 */
export function assertRuntimeIdentity(identity: RuntimeIdentity): void {
  for (const rule of RUNTIME_IDENTITY_RULES) {
    if (rule.failed(identity)) {
      throw new RuntimeIdentityError(rule.code, rule.message(identity))
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Memoised gate                                                              */
/* -------------------------------------------------------------------------- */

const verified = new WeakMap<object, Promise<RuntimeIdentity>>()

/**
 * Run the bootstrap once per client and remember the answer.
 *
 * Keyed by the postgres-js handle rather than by a module-level flag so a test
 * that builds a second client gets a second, independent verification — a
 * module-level boolean would let one suite's passing bootstrap vouch for
 * another suite's connection.
 *
 * A REJECTED promise is deliberately not cached: the map entry is cleared on
 * failure so a transient error (the database still starting, a dropped socket)
 * can be retried, while a genuine privilege problem simply fails again.
 */
export function ensureRuntimeIdentityVerified(sql: postgres.Sql): Promise<RuntimeIdentity> {
  const key = sql as unknown as object
  const existing = verified.get(key)
  if (existing !== undefined) return existing

  const pending = readRuntimeIdentity(sql)
    .then((identity) => {
      assertRuntimeIdentity(identity)
      return identity
    })
    .catch((error: unknown) => {
      verified.delete(key)
      throw error
    })

  verified.set(key, pending)
  return pending
}
