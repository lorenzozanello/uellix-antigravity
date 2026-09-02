// db/runtime-identity-report.ts
//
// ONE OBSERVATION, ONE VALIDATION, ONE RESULT — and a payload that is a
// deliberate list rather than a serialisation.
//
// STELLA_STAGING_B exists because the runtime identity property was strong and
// INFERENTIAL: the bootstrap gate proved it on startup, the smoke test proved
// the boundary behaved as if it held, and nothing anywhere could be asked to
// show the answer. This module is the surface that turns it into an
// observation, and it composes rather than restates:
//
//     db/runtime-bootstrap.ts   readRuntimeIdentity + collectRuntimeIdentityFailures
//     db/runtime-provenance.ts  readRuntimeTargetProvenance + collectRuntimeTargetFailures
//
// Nothing here re-implements a predicate. If a rule changes in either of those
// modules, this surface reports the change without being edited — which is the
// only version of "one source of truth" that survives contact with a second
// consumer.
//
// ---------------------------------------------------------------------------
// WHY THE MEMO IS NOT CONSULTED
// ---------------------------------------------------------------------------
// `ensureRuntimeIdentityVerified` caches its verdict per postgres-js handle,
// which is right for a startup gate: the question there is "may this pool serve
// traffic at all", asked once. It is the WRONG source for this surface, because
// a memo answers "was this pool ever verified" and an operator asking a health
// endpoint is asking "what is this pool now". Reading the memo would let a
// verification taken minutes ago — before a failover, a credential rotation, a
// pooler re-route — be reported as the present state.
//
// So every call issues the query. The cost is two round trips on a diagnostic
// endpoint; the property is that the answer is measured, not remembered.
//
// ---------------------------------------------------------------------------
// WHY ONE READ-ONLY TRANSACTION
// ---------------------------------------------------------------------------
// `BEGIN read only` is not decoration and not documentation. postgres-js hands
// out pooled connections per query, so without a transaction the two
// observations could be answered by two different sockets — still the same
// credentials, but no longer one measurement. Inside one transaction they are
// one connection and one snapshot.
//
// The `read only` half is enforcement by the SERVER: an INSERT, an UPDATE or a
// DDL statement reaching this code path fails with 25006 rather than
// succeeding, and that guarantee does not depend on anyone re-reading the SQL
// below. A health probe that can write is a health probe that can be turned
// into a mutation.

import type postgres from 'postgres'
import {
  collectRuntimeIdentityFailures,
  readRuntimeIdentity,
  type RuntimeIdentity,
  type RuntimeIdentityErrorCode,
} from './runtime-bootstrap'
import {
  collectRuntimeTargetFailures,
  readRuntimeTargetProvenance,
  resolveRuntimeTargetExpectation,
  type RuntimeTargetErrorCode,
  type RuntimeTargetObservation,
} from './runtime-provenance'
import type { EnvironmentSource } from './safety/database-target'

/**
 * The stable code for "the session could not be observed at all".
 *
 * Distinct from every code in the two collectors, which describe an identity
 * that WAS observed and found wanting. A driver error, a dead pool or a refused
 * transaction land here, and they land as a single opaque token: the underlying
 * error carries a host, a port and a SQLSTATE, none of which may leave the
 * server.
 */
export const RUNTIME_IDENTITY_UNOBSERVABLE = 'DB_RUNTIME_IDENTITY_UNOBSERVABLE' as const

export type RuntimeIdentityFailureCode =
  | RuntimeIdentityErrorCode
  | RuntimeTargetErrorCode
  | typeof RUNTIME_IDENTITY_UNOBSERVABLE

export interface RuntimeIdentityReport {
  readonly identity: RuntimeIdentity
  readonly target: RuntimeTargetObservation
  readonly identityFailures: readonly RuntimeIdentityErrorCode[]
  readonly targetFailures: readonly RuntimeTargetErrorCode[]
  /** True only when BOTH halves are clean. Never true on a partial answer. */
  readonly verified: boolean
}

export interface ObserveRuntimeIdentityOptions {
  /** Injectable for tests. Defaults to `process.env`. */
  readonly env?: EnvironmentSource
}

/**
 * Observe the live session and judge it. Throws only when the SESSION cannot be
 * observed — never to report a bad identity, which is a result and not a fault.
 */
export async function observeRuntimeIdentityReport(
  sql: postgres.Sql,
  options: ObserveRuntimeIdentityOptions = {}
): Promise<RuntimeIdentityReport> {
  const observed = await sql.begin('read only', async (tx) => {
    // The ROLE first, deliberately. It is the half that is enforced at startup
    // and the half an operator reads first, so if the provenance statements
    // fault it is worth knowing they faulted AFTER a complete role answer —
    // which the caller sees as the whole probe failing closed.
    const identity = await readRuntimeIdentity(tx as unknown as postgres.Sql)
    const target = await readRuntimeTargetProvenance(tx as unknown as postgres.Sql)
    return { identity, target }
  })

  // postgres-js types `begin` through `UnwrapPromiseArray`, which is shaped for
  // callbacks that return arrays of queries. This one returns a plain object.
  const { identity, target } = observed as unknown as {
    identity: RuntimeIdentity
    target: RuntimeTargetObservation
  }

  const identityFailures = collectRuntimeIdentityFailures(identity)
  const targetFailures = collectRuntimeTargetFailures(
    target,
    resolveRuntimeTargetExpectation(options.env)
  )

  return {
    identity,
    target,
    identityFailures,
    targetFailures,
    verified: identityFailures.length === 0 && targetFailures.length === 0,
  }
}

/* -------------------------------------------------------------------------- */
/* The public projection                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything that may leave the server, written out one field at a time.
 *
 * NOT a serialisation of `RuntimeIdentityReport`. Spreading the report would
 * make the response a moving target: the day someone adds a diagnostic field to
 * `RuntimeIdentity` — a host, a backend pid, an `application_name` — it would
 * ship to every authenticated caller without anyone deciding that it should.
 * Seven named lines are the decision.
 *
 * WHAT IS ABSENT, AND WHY
 *
 *   * the project ref — a boolean says whether the database named the pinned
 *     project; naming it would put an infrastructure identifier in a response
 *     the safety layer keeps out of its own error messages;
 *   * the sentinel row, the environment string, the pin — same reason;
 *   * the host, port, DSN, driver error, SQLSTATE, stack — see
 *     RUNTIME_IDENTITY_UNOBSERVABLE;
 *   * the caller's user id, email, organisation — this endpoint answers a
 *     question about the DEPLOYMENT, and the caller appears in it only as the
 *     reason it was allowed to ask.
 *
 * The two ROLE NAMES are present on purpose. They are PostgreSQL role
 * identifiers, they are compile-time constants of this repository
 * (db/safety/database-role.ts), they carry no credential and no personal data,
 * and the entire point of the endpoint is that the identity is READABLE rather
 * than inferred. Reporting `verified: false` while hiding which role answered
 * would be an observability surface that refuses to observe.
 */
export interface RuntimeIdentityPayload {
  readonly status: 'ok' | 'degraded'
  readonly verified: boolean
  readonly runtime: {
    readonly sessionUser: string
    readonly currentUser: string
    readonly isSuperuser: boolean
    readonly bypassesRls: boolean
    readonly canCreateRole: boolean
    readonly canSetOwnerRole: boolean
    readonly canCreateInPublic: boolean
  } | null
  readonly target: { readonly projectRefProven: boolean }
  readonly failures: readonly RuntimeIdentityFailureCode[]
  readonly observedAt: string
}

export function toRuntimeIdentityPayload(
  report: RuntimeIdentityReport,
  observedAt: string = new Date().toISOString()
): RuntimeIdentityPayload {
  return {
    status: report.verified ? 'ok' : 'degraded',
    verified: report.verified,
    runtime: {
      sessionUser: report.identity.sessionUser,
      currentUser: report.identity.currentUser,
      isSuperuser: report.identity.isSuperuser,
      bypassesRls: report.identity.bypassesRls,
      canCreateRole: report.identity.canCreateRole,
      canSetOwnerRole: report.identity.canSetOwnerRole,
      canCreateInPublic: report.identity.canCreateInPublic,
    },
    target: { projectRefProven: report.targetFailures.length === 0 },
    failures: [...report.identityFailures, ...report.targetFailures],
    observedAt,
  }
}

/**
 * The payload for a session that could not be observed.
 *
 * `runtime: null` rather than a zeroed object: an object full of `false` reads
 * as "nothing is wrong", and nothing is the one thing we know here. `verified`
 * is false and `projectRefProven` is false for the same reason — a probe that
 * failed has proven nothing, and every field must say so.
 */
export function unobservableRuntimeIdentityPayload(
  observedAt: string = new Date().toISOString()
): RuntimeIdentityPayload {
  return {
    status: 'degraded',
    verified: false,
    runtime: null,
    target: { projectRefProven: false },
    failures: [RUNTIME_IDENTITY_UNOBSERVABLE],
    observedAt,
  }
}
