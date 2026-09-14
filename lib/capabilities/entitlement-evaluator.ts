// lib/capabilities/entitlement-evaluator.ts
//
// CE-3 — THE EFFECTIVE-ENTITLEMENT EVALUATOR.
//
// Authority: docs/ops/commercial/COMMERCIAL_ACCOUNT_CE3_EXECUTION_AUTHORITY_v1.0.0.json
// EVALUATOR_CONTRACT, under HPO-ODS-W2-30. A thin typed wrapper over the
// SECURITY DEFINER function public.entitlement_effective(uuid, varchar)
// created by db/migrations/0073_commercial_account_ce3_entitlement_grants.sql.
//
// ---------------------------------------------------------------------------
// NOTHING CONSUMES THIS MODULE, AND THAT IS THE DESIGN
// ---------------------------------------------------------------------------
// ENFORCEMENT_BOUNDARY_CE4: at the end of a conformant CE-3 the count of
// NON-TEST consumers of `evaluateEntitlement` outside this file is ZERO. Not
// Stella quota enforcement, not Measure or Portfolio access, not an API route,
// not a billing page, not generic capability gating, not the selected-
// organization principal. This is NOT incompleteness: it is the property that
// makes CE-3 safe to land BEFORE tenancy S3, S4 and S7, because a relation
// nothing reads cannot leak across a tenant model that has not been frozen
// yet. Wiring it in is mutation CE3-M-5 and is caught by the consumer census.
//
// A VALID GRANT IS NOT AUTHORIZATION. UNMETERED or CAPPED says an Organization
// is entitled to a capability; it says NOTHING about whether the calling
// SUBJECT may act. No caller may use this return value on its own as an
// authorization decision (SC-1 / SC-13).
//
// ---------------------------------------------------------------------------
// WHY THE OUTCOME TYPE LIVES HERE AND NOT IN contracts.ts
// ---------------------------------------------------------------------------
// lib/capabilities/contracts.ts owns the CAP-01..CAP-05 vocabulary over
// U0001/U0002/U0003 and declares that every change to it is a contract change
// routed through docs/ops/contracts/. The authority makes editing it inside a
// CE-3 diff a STOP, so this node defines its own outcome type in its own
// module. contracts.ts is BYTE-UNCHANGED.

import {
  isDeclaredCapabilityKey,
  type EntitlementLimitKind,
} from './entitlement-catalogue'

/* -------------------------------------------------------------------------- */
/* SQLSTATEs                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The ONLY two database codes this boundary understands. Both are raised by
 * public.entitlement_effective with an IDENTICAL fixed message and no DETAIL,
 * HINT or echoed argument, so the CODE is the entire signal — which is exactly
 * why the mapping below keys on it and never on message text.
 *
 * Measured free at the implementing base: the occupied U0 namespace is
 * U0001..U0003 and U0100..U0112.
 */
export const ENTITLEMENT_SQLSTATE = {
  CROSS_ORGANIZATION: 'U0113',
  UNDECLARED_CAPABILITY: 'U0114',
} as const

/* -------------------------------------------------------------------------- */
/* Input and output                                                           */
/* -------------------------------------------------------------------------- */

/**
 * BOTH FIELDS ARE REQUIRED AND NEITHER IS OPTIONAL (SC-3).
 *
 * The EXPLICITNESS is itself the contract. A signature that permitted omitting
 * the Organization would be non-conformant even if every present call site
 * passed one, because the evaluator would then evaluate the WRONG TENANT — not
 * fail — the moment tenancy S7 removes user_single_active_membership. There is
 * deliberately no overload, no default, no `organizationId?`, and no ambient
 * or selected-organization fallback anywhere in this module.
 */
export interface EntitlementQuery {
  readonly organizationId: string
  readonly capabilityKey: string
}

/**
 * FIVE OUTCOMES, AND NO TWO OF THEM MAY COLLAPSE
 * (EVALUATOR_CONTRACT.output_shape.conflation_prohibitions):
 *
 *   NO_LIVE_GRANT  an ANSWER — "nobody decided". Not an error, not a refusal.
 *   BLOCKED        a DECISION — "decided against".
 *   UNMETERED      a live grant with no cap.
 *   CAPPED         a live grant with a non-negative cap, INCLUDING 0.
 *   REFUSED        NOT an answer about entitlement at all — the request itself
 *                  was refused.
 *
 * NO_LIVE_GRANT vs REFUSED is the load-bearing distinction: an empty result and
 * a refusal are indistinguishable to a caller that only checks for absence, and
 * that is precisely how a cross-tenant defect hides.
 *
 * CAPPED carries `limitValue` as a REQUIRED number, so a CAPPED outcome cannot
 * be constructed without one. BLOCKED carries no number at all, so BLOCKED can
 * never be spelled as "CAPPED with limitValue 0" — those are different rows in
 * the database and different values here.
 */
export type EntitlementOutcome =
  | { kind: 'NO_LIVE_GRANT' }
  | { kind: 'BLOCKED' }
  | { kind: 'UNMETERED' }
  | { kind: 'CAPPED'; limitValue: number }
  | { kind: 'REFUSED'; reason: 'CROSS_ORGANIZATION' | 'UNDECLARED_CAPABILITY' }

/* -------------------------------------------------------------------------- */
/* The database boundary                                                      */
/* -------------------------------------------------------------------------- */

/** One row of public.entitlement_effective's exact return shape. */
export interface EntitlementEffectiveRow {
  readonly kind: string
  readonly limit_value: number | null
}

/**
 * The one database call this module makes, as an injected dependency.
 *
 * WHY INJECTED. It is the measured repository precedent for a capability
 * boundary (lib/capabilities/stripe-webhook.ts takes its executor the same
 * way), and it keeps this module free of an import-time edge into the
 * connection chokepoint db/client.ts. It also lets the outcome mapping —
 * which is where a conflation bug would live — be exercised exhaustively
 * WITHOUT a database, so those controls stay deterministic and the real
 * PostgreSQL probes are spent on the properties only a real cluster can show.
 *
 * IT DOES NOT WEAKEN THE BOUND SIGNATURE. `evaluateEntitlement` still takes the
 * EntitlementQuery above as its first and only required argument, with both
 * fields required; the executor is a second, optional parameter and can never
 * supply, default or substitute an Organization.
 */
export interface EntitlementExecutor {
  effective(query: EntitlementQuery): Promise<readonly EntitlementEffectiveRow[]>
}

/** Pure: the five-character SQLSTATE of a driver error, or null. */
function readSqlState(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/* -------------------------------------------------------------------------- */
/* The evaluator                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Answer what `organizationId` is entitled to for `capabilityKey`.
 *
 * PURITY (EVALUATOR_CONTRACT.purity). This function MUTATES NOTHING: it writes
 * no row, sets no GUC, records no audit entry as a side effect of being asked,
 * and never lazily materialises a missing grant. A grant created on a cache
 * miss would be a plan read producing an effective limit with no intervening,
 * separately audited grant write — exactly the path PLAN_ENTITLEMENT_BOUNDARY
 * forbids. The underlying SQL function is declared STABLE for the same reason.
 *
 * THE CATALOGUE IS CHECKED TWICE, DELIBERATELY. The pre-check below refuses an
 * undeclared key before any round trip, and public.entitlement_effective
 * refuses it AGAIN with U0114. The second check is not redundant: EXECUTE on
 * that function is granted to the `authenticated` JWT role, so a caller can
 * invoke it directly and never reach this file. A catalogue enforced only here
 * would be a guard on the polite path.
 *
 * ORDERING NOTE. This pre-check runs BEFORE the database call, so an undeclared
 * key is refused here even for an Organization the caller is not scoped to —
 * whereas the SQL function checks SCOPE FIRST, so a direct caller learns
 * nothing about the catalogue from outside their scope. The asymmetry is
 * intentional and safe in this direction: reaching this function at all means
 * the process already holds the catalogue as a compile-time constant, so
 * refusing early reveals nothing it did not already have.
 */
export async function evaluateEntitlement(
  query: EntitlementQuery,
  executor: EntitlementExecutor = defaultEntitlementExecutor(),
): Promise<EntitlementOutcome> {
  // UNDECLARED IS REFUSED, NEVER DEFAULTED. It is never NO_LIVE_GRANT: "there
  // is no such capability" is a refusal of the QUESTION, while NO_LIVE_GRANT is
  // an ANSWER about an Organization. Collapsing them would make a mistyped key
  // read as a well-formed negative (CE3-N-5, CE3-P-8).
  if (!isDeclaredCapabilityKey(query.capabilityKey)) {
    return { kind: 'REFUSED', reason: 'UNDECLARED_CAPABILITY' }
  }

  let rows: readonly EntitlementEffectiveRow[]
  try {
    rows = await executor.effective(query)
  } catch (error: unknown) {
    const sqlState = readSqlState(error)

    if (sqlState === ENTITLEMENT_SQLSTATE.CROSS_ORGANIZATION) {
      return { kind: 'REFUSED', reason: 'CROSS_ORGANIZATION' }
    }
    if (sqlState === ENTITLEMENT_SQLSTATE.UNDECLARED_CAPABILITY) {
      return { kind: 'REFUSED', reason: 'UNDECLARED_CAPABILITY' }
    }

    // ANYTHING ELSE PROPAGATES. A dropped connection, a 42883 because the
    // migration was never applied, a 42501 because EXECUTE was not granted, a
    // 22P02 because the caller passed something that is not a uuid — none of
    // those is an entitlement answer. Folding them into NO_LIVE_GRANT, BLOCKED
    // or a generic REFUSED would turn an outage or a deployment defect into a
    // confident, wrong statement about what an Organization is entitled to,
    // which is the silent-failure shape this whole boundary exists to prevent.
    throw error
  }

  // EXACTLY ONE ROW, ALWAYS. The SQL function returns one semantic answer row
  // on every path. Zero rows, or more than one, means the deployed function is
  // not the one this module was written against — a shape fault, not an
  // entitlement outcome, so it FAILS CLOSED by throwing rather than being read
  // as "nothing granted".
  if (rows.length !== 1) {
    throw new Error(
      `entitlement_effective returned ${rows.length} rows; exactly one semantic answer row is required`,
    )
  }

  const [row] = rows

  switch (row.kind as EntitlementLimitKind | 'NO_LIVE_GRANT') {
    case 'NO_LIVE_GRANT':
      return { kind: 'NO_LIVE_GRANT' }
    case 'BLOCKED':
      return { kind: 'BLOCKED' }
    case 'UNMETERED':
      return { kind: 'UNMETERED' }
    case 'CAPPED':
      // CHECK-1 guarantees a non-negative limit_value for CAPPED at the storage
      // boundary. If one arrives NULL anyway the constraint is gone, and
      // inventing a number here — 0 especially, which would silently mean
      // BLOCKED — would hide that. Fail closed.
      if (typeof row.limit_value !== 'number') {
        throw new Error('entitlement_effective returned CAPPED without a limit_value')
      }
      return { kind: 'CAPPED', limitValue: row.limit_value }
    default:
      // An unrecognised kind is a deployed-function mismatch, never an answer.
      throw new Error(`entitlement_effective returned an unrecognised kind: ${String(row.kind)}`)
  }
}

/* -------------------------------------------------------------------------- */
/* The production executor                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The real executor, over the repository's single connection chokepoint.
 *
 * The import is LAZY and inside the call, not at module scope: db/client.ts is
 * the guarded chokepoint for every Postgres connection in this repository, and
 * this module must stay importable by a static test, a type-only consumer or a
 * census sweep without dragging a connection path in behind it.
 *
 * IT RESOLVES NO TARGET OF ITS OWN. `getDefaultDatabaseClient()` is the
 * repository's existing guarded accessor; this module names no connection
 * string, no capability and no environment, so it cannot dial a destination the
 * chokepoint has not already classified.
 *
 * NOTE THE CASTS. p_capability_key is declared `varchar`, so the parameter is
 * cast explicitly rather than left for the driver to infer — an inferred `text`
 * would not match the function's signature.
 */
export function defaultEntitlementExecutor(): EntitlementExecutor {
  return {
    async effective(query: EntitlementQuery) {
      const { getDefaultDatabaseClient } = await import('@/db/client')
      const { sql: client } = getDefaultDatabaseClient()
      const rows = await client<EntitlementEffectiveRow[]>`
        SELECT kind, limit_value
        FROM public.entitlement_effective(
          ${query.organizationId}::uuid,
          ${query.capabilityKey}::varchar
        )
      `
      return rows
    },
  }
}
