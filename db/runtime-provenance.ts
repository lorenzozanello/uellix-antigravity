// db/runtime-provenance.ts
//
// ASK THE DATABASE WHICH PROJECT IT IS — do not read it off the connection.
//
// db/runtime-bootstrap.ts answers "who did the server authenticate". This
// module answers the other half of SYS-02: "which Supabase project is on the
// far end of that connection", and it answers it the same way — by asking
// something the connection string cannot decide.
//
// ---------------------------------------------------------------------------
// WHY NOT `deriveTargetProjectIdentity`
// ---------------------------------------------------------------------------
// db/safety/runtime-project-pins.ts already proves a project ref, and it is
// correct — for what it does. It reads the HOST, the qualified Supavisor login
// role and the `?options=reference=` routing parameter, all of them parts of
// the DSN, and it does so BEFORE a socket exists, which is exactly where a
// construction-time guard has to work.
//
// That makes it configuration. It states an intention, and an intention is the
// thing that is wrong when someone pastes the other project's string into the
// wrong variable. A guard that reads the DSN can only ever confirm that the
// DSN says what the DSN says.
//
// The observational source already exists and is already reachable. Train 5B's
// third signal is a row the database keeps about itself:
//
//     uellix_bootstrap.staging_sentinel (environment, project_ref)
//
// written once at provisioning by a human reading the dashboard, refused by the
// hosted migrator when absent, and constrained so a production database cannot
// satisfy it by editing a variable (`CHECK (environment = 'staging')`). And
// stella_hosted_0001 §7 already granted `uellix_app` USAGE on the schema and
// SELECT on the table — so reading it here exercises a privilege the runtime
// was given at provisioning time. It requests none.
//
// A pasted connection string cannot move that row. That is the whole point.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS DELIBERATELY NOT WIRED INTO
// ---------------------------------------------------------------------------
// NOT the bootstrap gate. `ensureRuntimeIdentityVerified` must keep refusing on
// role divergence alone, because the sentinel is a STAGING artefact: local
// stacks and the production project carry no such row, and making the runtime
// refuse to serve wherever the row is absent would turn an observability
// improvement into an outage in two environments that are not in this
// workstream's scope. The asymmetry is stated rather than hidden — see
// STELLA_STAGING_B, "remaining gaps".
//
// The consequence is honest in the other direction too: outside staging this
// module reports "not proven", never "proven anyway".

import type postgres from 'postgres'
import { resolveEnvironment } from './safety/database-access'
import type { EnvironmentSource } from './safety/database-target'
import { runtimeProjectPinFor } from './safety/runtime-project-pins'

export type RuntimeTargetErrorCode =
  /** This deployment environment pins no hosted project, so none can be proven. */
  | 'DB_RUNTIME_TARGET_ENVIRONMENT_NOT_PINNED'
  /** The database carries no sentinel: it makes no claim about its own identity. */
  | 'DB_RUNTIME_TARGET_SENTINEL_ABSENT'
  /** The sentinel exists but this role cannot read it, or it holds no row. */
  | 'DB_RUNTIME_TARGET_SENTINEL_UNREADABLE'
  /** The database says it is a different environment than this process believes. */
  | 'DB_RUNTIME_TARGET_ENVIRONMENT_MISMATCH'
  /** The database names a different project than the one pinned here. */
  | 'DB_RUNTIME_TARGET_PROJECT_MISMATCH'

/**
 * What the LIVE session saw. Nothing here is derived from configuration.
 *
 * `projectRef` and `environment` are the values the row carries. They are read
 * so they can be COMPARED — neither is ever put in a response payload, because
 * the safety layer's rule (db/safety/runtime-project-pins.ts) keeps project
 * refs out of this layer's output even though a ref is public in every URL the
 * project serves.
 */
export interface RuntimeTargetObservation {
  readonly sentinelPresent: boolean
  readonly sentinelReadable: boolean
  readonly environment: string | null
  readonly projectRef: string | null
}

/** What this process believes it is. The side an environment variable can move. */
export interface RuntimeTargetExpectation {
  readonly environment: string
  readonly pinnedProjectRef: string | null
}

/**
 * The expectation, resolved from the deployment environment.
 *
 * Both halves come from modules that already own the question:
 * `resolveEnvironment` (which refuses to read a typo as an intention) and
 * `runtimeProjectPinFor` (which returns null rather than a wildcard for an
 * environment with no hosted project).
 */
export function resolveRuntimeTargetExpectation(
  env: EnvironmentSource = process.env
): RuntimeTargetExpectation {
  const environment = resolveEnvironment(env)
  return { environment, pinnedProjectRef: runtimeProjectPinFor(environment) }
}

/**
 * Two round trips, and neither can raise on a database that lacks the table.
 *
 * WHY THE EXISTENCE PROBE IS SHAPED LIKE THIS
 *
 * `has_table_privilege(text, text)` raises `42P01` for a relation that does not
 * exist, and an exception here would abort the CALLER's transaction and take
 * the role observation down with it — turning "this database has no sentinel"
 * (a fact worth reporting, and the normal answer outside staging) into "the
 * probe crashed" (a fact that hides it).
 *
 * So the privilege question is asked through a SCALAR SUBQUERY over the
 * catalog. When the relation is absent the subquery returns no rows, the
 * function is never evaluated at all, and `COALESCE` supplies `false`. The
 * shorter `LEFT JOIN … has_table_privilege(c.oid, 'SELECT')` form would depend
 * on that oid overload being STRICT — which it is, but a fail-closed layer
 * should not rest on a catalog property it cannot check from here.
 */
export async function readRuntimeTargetProvenance(
  sql: postgres.Sql
): Promise<RuntimeTargetObservation> {
  const [existence] = await sql<{ sentinel_present: boolean; sentinel_readable: boolean }[]>`
    SELECT
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'uellix_bootstrap' AND c.relname = 'staging_sentinel'
      ) AS sentinel_present,
      COALESCE((
        SELECT pg_catalog.has_table_privilege(c.oid, 'SELECT')
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'uellix_bootstrap' AND c.relname = 'staging_sentinel'
      ), false) AS sentinel_readable
  `

  if (existence === undefined || !existence.sentinel_present) {
    return { sentinelPresent: false, sentinelReadable: false, environment: null, projectRef: null }
  }
  if (!existence.sentinel_readable) {
    return { sentinelPresent: true, sentinelReadable: false, environment: null, projectRef: null }
  }

  // Singleton by construction (`CHECK (id)` plus a boolean primary key), so
  // LIMIT 1 cannot pick between two competing claims — there can only be one.
  const [row] = await sql<{ environment: string | null; project_ref: string | null }[]>`
    SELECT environment::text AS environment, project_ref::text AS project_ref
    FROM uellix_bootstrap.staging_sentinel
    LIMIT 1
  `

  return {
    sentinelPresent: true,
    sentinelReadable: true,
    environment: row?.environment ?? null,
    projectRef: row?.project_ref ?? null,
  }
}

/**
 * EVERY reason the target is not proven, in a stable order. Empty means proven.
 *
 * Mirrors `collectRuntimeIdentityFailures`: one collector, no throwing variant,
 * because there is no startup gate on this half — see the module header.
 *
 * "Cannot be proven" is a FAILURE, not a neutral outcome. An environment with
 * no pin, a database with no sentinel and a role that cannot read one all land
 * here, and all of them make `projectRefProven` false. The alternative — a
 * third "unknown" state that callers are free to treat as acceptable — is the
 * fallback-to-pass this whole layer exists to refuse.
 */
export function collectRuntimeTargetFailures(
  observation: RuntimeTargetObservation,
  expectation: RuntimeTargetExpectation
): readonly RuntimeTargetErrorCode[] {
  const failures: RuntimeTargetErrorCode[] = []

  if (expectation.pinnedProjectRef === null) {
    failures.push('DB_RUNTIME_TARGET_ENVIRONMENT_NOT_PINNED')
  }

  if (!observation.sentinelPresent) {
    failures.push('DB_RUNTIME_TARGET_SENTINEL_ABSENT')
    return failures
  }

  if (!observation.sentinelReadable || observation.projectRef === null) {
    failures.push('DB_RUNTIME_TARGET_SENTINEL_UNREADABLE')
    return failures
  }

  if (observation.environment !== expectation.environment) {
    failures.push('DB_RUNTIME_TARGET_ENVIRONMENT_MISMATCH')
  }

  if (
    expectation.pinnedProjectRef !== null &&
    observation.projectRef !== expectation.pinnedProjectRef
  ) {
    failures.push('DB_RUNTIME_TARGET_PROJECT_MISMATCH')
  }

  return failures
}
