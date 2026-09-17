// lib/capabilities/entitlement-catalogue.ts
//
// CE-3 — THE CLOSED PRODUCT-CAPABILITY CATALOGUE FOR entitlement_grants.
//
// Authority: docs/ops/commercial/COMMERCIAL_ACCOUNT_CE3_EXECUTION_AUTHORITY_v1.0.0.json
// (PHYSICAL_TARGET_SHAPE.capability_catalogue_rule, SC-9), under
// HPO-ODS-W2-30. The parent declares capability_key as coming "from a closed
// catalogue owned by the implementing node" — i.e. by CE-3, here.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A NEW FILE AND NOT AN EDIT TO contracts.ts
// ---------------------------------------------------------------------------
// lib/capabilities/contracts.ts owns a DIFFERENT closed vocabulary: the
// CAP-01..CAP-05 outcome set over SQLSTATEs U0001/U0002/U0003. That module
// states of itself that it is owned by the CAPABILITIES workstream and that
// every change to it is a contract change routed through docs/ops/contracts/.
// The authority's EVALUATOR_CONTRACT.output_shape.measured_constraint_on_reuse
// therefore makes editing it inside a CE-3 diff a STOP. A capability GRANT is
// not a capability PACKAGE: the two vocabularies are disjoint and are kept in
// disjoint modules. contracts.ts is BYTE-UNCHANGED by this node.
//
// ---------------------------------------------------------------------------
// THE THREE THINGS THIS FILE MUST NOT LET HAPPEN
// ---------------------------------------------------------------------------
// 1. AN UNDECLARED KEY MUST NEVER COLLAPSE TO NO_LIVE_GRANT. "Nobody granted
//    this" and "there is no such capability" are different facts. NO_LIVE_GRANT
//    is an ANSWER about an Organization; an undeclared key is a REFUSAL of the
//    QUESTION. Collapsing them would make a typo in a capability key read as a
//    well-formed negative answer, which is how a future enforcement point ends
//    up silently denying a capability nobody ever blocked — and, in the other
//    direction, how a caller learns to probe the catalogue by watching which
//    spellings come back as "answers".
//
// 2. NO OUTCOME MAY BE DERIVED FROM MISSING METADATA. Every descriptor below
//    ENUMERATES its admissible limit kinds explicitly. There is deliberately
//    no `defaultLimitKind` field and no fallback branch anywhere in this
//    module: a capability whose metered semantic is not stated FAILS CLOSED
//    rather than acquiring one by omission (SC-9, and the authority's
//    capability_catalogue_rule.BINDING_constraints, second clause).
//
// 3. THE LEGACY STELLA QUOTA OVERLOAD DOES NOT GENERALISE. The pre-existing
//    organizations.stella_monthly_quota column reads NULL as "unlimited" and 0
//    as "blocked" — two semantics riding on one nullable integer. limit_kind
//    exists precisely to stop that overload spreading to every future
//    capability. In THIS vocabulary the discriminator is limit_kind and
//    limit_value is only ever the CAP that accompanies CAPPED; BLOCKED is a
//    limit_kind and is NEVER "CAPPED with limit_value 0". CAPPED 0 and BLOCKED
//    are DIFFERENT rows and DIFFERENT answers. That distinction is asserted by
//    CE3-P-6 and is the reason this module never inspects limit_value at all.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE MAY NEVER DO
// ---------------------------------------------------------------------------
// It imports nothing — no driver, no `@/db/client`, no schema. It is types
// plus frozen constants, so it stays safe to import from anywhere and cannot
// become a second, divergent read path onto the relation.
//
// AND IT IS NOT THE ONLY ENFORCEMENT POINT. The SECURITY DEFINER evaluator
// re-validates the capability key at the DATABASE boundary with its own
// SQLSTATE (U0114), because EXECUTE on that function is granted to the
// `authenticated` JWT role and a caller can therefore invoke the SQL function
// directly, bypassing this module entirely. A TypeScript-only catalogue guard
// would be a guard on the polite path only.

/* -------------------------------------------------------------------------- */
/* Metered semantics                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The three metered states of a LIVE grant, from authority SC-9. This is a
 * CLOSED set and is pinned independently in the database by a CHECK
 * constraint on entitlement_grants.limit_kind — the two must agree, and the
 * database is the one that is load-bearing.
 *
 * NOTE WHAT IS ABSENT: there is no 'NO_LIVE_GRANT' member here. Absence of a
 * grant is not a metered state a grant row can carry; it is what the evaluator
 * answers when no row matches. Putting it in this union would make it
 * storable, and a stored "no grant" row is a contradiction that the partial
 * unique index could not even keep unique.
 */
export const ENTITLEMENT_LIMIT_KINDS = ['UNMETERED', 'BLOCKED', 'CAPPED'] as const
export type EntitlementLimitKind = (typeof ENTITLEMENT_LIMIT_KINDS)[number]

/**
 * The four grant sources, from authority SC-7. Also pinned by a database
 * CHECK. Carried here so that a writer constructing a grant has one spelling
 * to import rather than a string literal per call site; this module grants
 * nothing and writes nothing.
 */
export const ENTITLEMENT_GRANT_SOURCES = [
  'PLAN',
  'PLATFORM_ADMIN',
  'BOOTSTRAP_DEFAULT',
  'COMMERCIAL_EXCEPTION',
] as const
export type EntitlementGrantSource = (typeof ENTITLEMENT_GRANT_SOURCES)[number]

/* -------------------------------------------------------------------------- */
/* The catalogue                                                              */
/* -------------------------------------------------------------------------- */

export interface EntitlementCapabilityDescriptor {
  /** The capability_key as it is persisted in entitlement_grants. */
  readonly key: string
  /**
   * EVERY metered semantic this capability may be granted under, enumerated.
   * Not a default and not a hint: the evaluator never consults this list to
   * DECIDE an outcome — the live row's own limit_kind does that — it exists so
   * that "this capability has no declared metered semantic" is a statement
   * this file can be checked against rather than a silence.
   */
  readonly admissibleLimitKinds: readonly EntitlementLimitKind[]
  /** Why this capability is metered at the Organization boundary at all. */
  readonly rationale: string
}

/**
 * THE PRODUCTION CATALOGUE FOR COMMERCIAL V1 — EXACTLY ONE ENTRY.
 *
 * One entry is not a placeholder and is not an oversight. CE-3 delivers the
 * RELATION and the EVALUATOR; it wires no enforcement (ENFORCEMENT_BOUNDARY_CE4),
 * so a second production key would be a capability nothing can grant, nothing
 * reads and nothing enforces — an unfalsifiable entry whose only effect would
 * be to make the catalogue look richer than the node. Capabilities are added
 * when a node exists that meters them.
 *
 * THE SAME SINGLE KEY EXERCISES ALL THREE OUTCOMES. BLOCKED, UNMETERED and
 * CAPPED are properties of a GRANT ROW, not of a capability, so the three
 * metered states — and the fourth answer, NO_LIVE_GRANT — are all reachable by
 * granting this one key differently per Organization. No synthetic production
 * capability is added to make a test easier to write.
 */
export const ENTITLEMENT_CAPABILITY_CATALOGUE: readonly EntitlementCapabilityDescriptor[] = [
  {
    key: 'stella.grounded_query',
    // All three, ENUMERATED. A platform exception may BLOCK the capability for
    // one Organization, a plan may grant it UNMETERED, and a plan may cap it at
    // a non-negative integer — including 0, which is a CAP of zero and is NOT
    // the same row as BLOCKED.
    admissibleLimitKinds: ['UNMETERED', 'BLOCKED', 'CAPPED'],
    rationale:
      'Stella grounded query is the one product capability Commercial V1 meters at the ' +
      'Organization boundary. It is the capability the legacy organizations.stella_monthly_quota ' +
      'column approximates today with its NULL-means-unlimited / 0-means-blocked overload; ' +
      'CE-3 restates it as an explicit grant so that the overload does not survive into the ' +
      'entitlement vocabulary. CE-3 does NOT project a grant onto that legacy column and does ' +
      'not read it — the projection is CE-5 and the backfill is CE-4.',
  },
] as const

/** The declared keys, DERIVED from the catalogue so the two cannot disagree. */
export const ENTITLEMENT_CAPABILITY_KEYS: readonly string[] =
  ENTITLEMENT_CAPABILITY_CATALOGUE.map((entry) => entry.key)

/**
 * Pure: is `key` a declared production capability?
 *
 * Exact string equality against the catalogue. No normalisation, no
 * case-folding, no trimming and no prefix matching: 'Stella.Grounded_Query'
 * and 'stella.grounded_query ' are UNDECLARED, because the value persisted in
 * entitlement_grants.capability_key is compared by the database with exact
 * equality too, and a catalogue that accepted spellings the relation cannot
 * match would hand back an answer about a grant that can never exist.
 */
export function isDeclaredCapabilityKey(key: string): boolean {
  return ENTITLEMENT_CAPABILITY_CATALOGUE.some((entry) => entry.key === key)
}

/**
 * Pure: the descriptor for `key`, or undefined when it is undeclared.
 *
 * Callers MUST treat undefined as REFUSED. It is never a licence to pick a
 * limit kind, and there is no overload of this function that supplies one.
 */
export function describeCapability(key: string): EntitlementCapabilityDescriptor | undefined {
  return ENTITLEMENT_CAPABILITY_CATALOGUE.find((entry) => entry.key === key)
}
