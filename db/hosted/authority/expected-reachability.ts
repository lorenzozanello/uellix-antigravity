// db/hosted/authority/expected-reachability.ts
// COMMIT 3.3 — RT-07, stated as a graph instead of as a prohibition.
//
// ---------------------------------------------------------------------------
// WHY THE OLD INVARIANT HAD TO CHANGE, AND WHY IT IS NOT BEING WEAKENED
// ---------------------------------------------------------------------------
// RT-07 said: the installer must never have transitive SET reachability to a
// capability role. That is right for an owner window and for a capability
// window, and it is impossible for an ownership transfer — measured, PG 17.6:
//
//   SET ROLE uellix_owner; ALTER ... OWNER TO cap  ->  must be able to SET ROLE
//   installer (INHERIT FALSE) executes it          ->  must be owner of function
//
// The only shape PostgreSQL accepts gives uellix_owner a temporary membership
// in the target, and the installer already holds uellix_owner with SET. So
// `installer -> uellix_owner -> target` exists, transitively, for the length of
// one segment. That is not a violation to be waived; it is the topology the
// operation requires.
//
// So the rule stops being "no transitive path" and becomes "exactly this graph,
// in this phase, and nothing else". The deliberate consequence is that a
// transfer is now MORE constrained than before, not less: the old check could
// only say yes or no about one shape, and this one refuses any edge, any path
// and any principal it was not told to expect.
//
// What was rejected: a `skipRt07` flag, or an `allowTransitive: true` option.
// Either would have turned a specific, checkable expectation into a hole whose
// size nobody could see, and the first bug written through it would have looked
// exactly like correct code.

import { AuthorityRefusal } from './window-contract'
import { isCapabilityRoleName, OWNER_ROLE } from './ownership-simulation'
import type { MembershipEdge } from './primitives'
import { parseMembershipStatement } from './membership'

export type LifecyclePhase = 'before' | 'during' | 'after'

export interface ExpectedReachability {
  readonly segmentId: string
  readonly phase: LifecyclePhase
  /** Membership edges (`role` becomes reachable by `member`) expected to exist. */
  readonly allowedEdges: readonly MembershipEdge[]
  /** Every SET path expected to be reachable, as `member->role`, transitive included. */
  readonly allowedSetPaths: readonly string[]
  /** Principals that must reach NO capability role in this phase. */
  readonly forbiddenPrincipals: readonly string[]
  /**
   * Paths that must be PRESENT, not merely permitted.
   *
   * Without this the model is one-sided: a `WITH SET FALSE` grant produces no
   * edge at all, so "actual is a subset of expected" would pass while the
   * transfer it was meant to enable could not execute. Measured, PG 17.6: the
   * owner must be able to SET ROLE to the incoming owner or the ALTER is
   * refused with `must be able to SET ROLE`.
   */
  readonly requiredSetPaths: readonly string[]
  /** For a transfer: the one capability that may become reachable. */
  readonly exactTargetCapability: string | null
}

const pathKey = (member: string, role: string): string => `${member}->${role}`

/** Every `member->role` pair reachable by following SET edges, transitively. */
export function setReachabilityClosure(edges: readonly MembershipEdge[]): Set<string> {
  const direct = new Map<string, Set<string>>()
  for (const edge of edges) {
    const set = direct.get(edge.member) ?? new Set<string>()
    set.add(edge.role)
    direct.set(edge.member, set)
  }

  const closure = new Set<string>()
  for (const [member] of direct) {
    const queue = [...(direct.get(member) ?? [])]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const role = queue.pop() as string
      if (seen.has(role)) continue
      seen.add(role)
      closure.add(pathKey(member, role))
      for (const next of direct.get(role) ?? []) queue.push(next)
    }
  }
  return closure
}

export interface SegmentTopologyInput {
  readonly segmentId: string
  readonly authorityClass: 'OWNER' | 'CAPABILITY' | 'OWNER_TRANSFER'
  readonly executor: string
  readonly ownerDestination: string | null
  readonly installer: string
  /** Runtime principals that must never reach a capability role. */
  readonly runtimePrincipals: readonly string[]
}

/**
 * The three phases of one execution segment's expected topology.
 *
 * Derived from the segment's OWN class and destination, never from a flag a
 * caller may set. That is what makes "mark an ordinary capability segment as a
 * transfer exception" impossible rather than merely discouraged: a capability
 * segment produces capability expectations because it is a capability segment.
 */
export function expectedReachabilityFor(input: SegmentTopologyInput): ExpectedReachability[] {
  const { segmentId, authorityClass, executor, ownerDestination, installer } = input

  if (authorityClass === 'OWNER_TRANSFER') {
    if (ownerDestination === null || !isCapabilityRoleName(ownerDestination)) {
      throw new AuthorityRefusal(
        'AUTHORITY_EXECUTOR_ROLE_MISMATCH',
        `${segmentId}: a transfer segment must name exactly one capability destination; found ` +
          `\`${ownerDestination}\`.`,
      )
    }
  } else if (ownerDestination !== null) {
    throw new AuthorityRefusal(
      'AUTHORITY_EXECUTOR_ROLE_MISMATCH',
      `${segmentId}: a ${authorityClass} segment declares an owner destination ` +
        `(\`${ownerDestination}\`). Only a transfer has one, and giving a non-transfer segment ` +
        `transfer topology is exactly the mutation this model exists to refuse.`,
    )
  }

  const base = { segmentId, forbiddenPrincipals: input.runtimePrincipals }

  // The installer's persistent membership in the owner is chain state, present
  // in every phase. It is expected everywhere and is not what RT-07 was about.
  const persistent: MembershipEdge[] = [{ role: OWNER_ROLE, member: installer }]
  const persistentPaths = [pathKey(installer, OWNER_ROLE)]

  if (authorityClass === 'OWNER_TRANSFER') {
    const target = ownerDestination as string
    const during: MembershipEdge[] = [...persistent, { role: target, member: OWNER_ROLE }]
    return [
      {
        ...base,
        phase: 'before',
        allowedEdges: persistent,
        allowedSetPaths: persistentPaths,
        requiredSetPaths: [],
        exactTargetCapability: target,
      },
      {
        ...base,
        phase: 'during',
        allowedEdges: during,
        // The transitive path is EXPECTED, and it is the only extra one.
        allowedSetPaths: [
          ...persistentPaths,
          pathKey(OWNER_ROLE, target),
          pathKey(installer, target),
        ],
        // ...and it is also REQUIRED: without it the ALTER cannot execute.
        requiredSetPaths: [pathKey(OWNER_ROLE, target), pathKey(installer, target)],
        exactTargetCapability: target,
      },
      {
        ...base,
        phase: 'after',
        allowedEdges: persistent,
        allowedSetPaths: persistentPaths,
        requiredSetPaths: [],
        exactTargetCapability: target,
      },
    ]
  }

  if (authorityClass === 'CAPABILITY') {
    const during: MembershipEdge[] = [...persistent, { role: executor, member: installer }]
    return [
      { ...base, phase: 'before', allowedEdges: persistent, allowedSetPaths: persistentPaths, requiredSetPaths: [], exactTargetCapability: null },
      {
        ...base,
        phase: 'during',
        allowedEdges: during,
        // Direct only. uellix_owner is a member of no capability role here, so
        // there is no transitive path to expect — and any that appeared would
        // be refused.
        allowedSetPaths: [...persistentPaths, pathKey(installer, executor)],
        requiredSetPaths: [pathKey(installer, executor)],
        exactTargetCapability: null,
      },
      { ...base, phase: 'after', allowedEdges: persistent, allowedSetPaths: persistentPaths, requiredSetPaths: [], exactTargetCapability: null },
    ]
  }

  return [
    { ...base, phase: 'before', allowedEdges: persistent, allowedSetPaths: persistentPaths, requiredSetPaths: [], exactTargetCapability: null },
    { ...base, phase: 'during', allowedEdges: persistent, allowedSetPaths: persistentPaths, requiredSetPaths: persistentPaths, exactTargetCapability: null },
    { ...base, phase: 'after', allowedEdges: persistent, allowedSetPaths: persistentPaths, requiredSetPaths: [], exactTargetCapability: null },
  ]
}

/**
 * Compares the topology a set of membership statements actually produces with
 * the topology the segment declared it would produce.
 *
 * Unknown edge, unknown path, a forbidden principal reaching anything, or a
 * capability other than the declared target becoming reachable: all refuse.
 * There is no tolerance parameter.
 */
export function assertReachabilityMatchesExpectation(
  actualEdges: readonly MembershipEdge[],
  expected: ExpectedReachability,
): void {
  const where = `${expected.segmentId} (${expected.phase})`
  const allowedEdges = new Set(expected.allowedEdges.map((e) => pathKey(e.member, e.role)))

  for (const edge of actualEdges) {
    if (!allowedEdges.has(pathKey(edge.member, edge.role))) {
      throw new AuthorityRefusal(
        'AUTHORITY_STATE_TRANSITION_INVALID',
        `${where}: membership edge ${edge.member} -> ${edge.role} is not in the expected topology ` +
          `for this phase. Expected: ${[...allowedEdges].join(', ') || '(none)'}.`,
      )
    }
  }

  const actual = setReachabilityClosure(actualEdges)
  const allowedPaths = new Set(expected.allowedSetPaths)

  for (const path of actual) {
    if (!allowedPaths.has(path)) {
      throw new AuthorityRefusal(
        'AUTHORITY_STATE_TRANSITION_INVALID',
        `${where}: SET path ${path} exists but was not expected. Measured (lab M4), reachability ` +
          `is transitive, so an unexpected path is authority nobody wrote down.`,
      )
    }
  }

  for (const required of expected.requiredSetPaths) {
    if (!actual.has(required)) {
      throw new AuthorityRefusal(
        'AUTHORITY_STATE_TRANSITION_INVALID',
        `${where}: SET path ${required} is required in this phase and is absent. A membership ` +
          `granted WITH SET FALSE creates no path at all, so the operation this phase exists for ` +
          `could not execute — measured, PG 17.6: \`must be able to SET ROLE\`.`,
      )
    }
  }

  for (const principal of expected.forbiddenPrincipals) {
    for (const path of actual) {
      if (!path.startsWith(`${principal}->`)) continue
      throw new AuthorityRefusal(
        'AUTHORITY_STATE_TRANSITION_INVALID',
        `${where}: runtime principal ${principal} can reach ${path.split('->')[1]}. A runtime role ` +
          `must never be able to become anything, in any phase.`,
      )
    }
  }

  if (expected.exactTargetCapability !== null) {
    for (const path of actual) {
      const [, role] = path.split('->')
      if (isCapabilityRoleName(role) && role !== expected.exactTargetCapability) {
        throw new AuthorityRefusal(
          'AUTHORITY_CONCURRENT_CAPABILITY_LIFECYCLES',
          `${where}: capability ${role} is reachable, but this segment's only declared target is ` +
            `${expected.exactTargetCapability}. Two capability lifecycles open at once is the ` +
            `W46 mutation — quota and ticket must be transferred one after the other, each ` +
            `closing before the next opens.`,
        )
      }
    }
  }
}

/**
 * Refuses a temporary elevation granted WITH INHERIT TRUE.
 *
 * INHERIT would make the member carry the role's privileges for every statement
 * it runs, not only when it announces itself with SET ROLE. That is the shortcut
 * this design refused when the transfer defect was found: widening
 * `installer -> uellix_owner` to INHERIT would have made the transfer work and
 * would have made every other statement in the chain run with owner privileges
 * silently.
 */
export function assertTemporaryGrantShape(where: string, statements: readonly string[]): void {
  for (const statement of statements) {
    const membership = parseMembershipStatement(statement)
    if (membership === null || membership.kind !== 'grant') continue
    if (membership.inheritOption === true) {
      throw new AuthorityRefusal(
        'AUTHORITY_STATE_TRANSITION_INVALID',
        `${where}: \`${statement.trim()}\` grants a temporary membership WITH INHERIT TRUE. The ` +
          `member would then carry that role's privileges on every statement, not only when it ` +
          `announces itself. Temporary elevation is SET, never INHERIT.`,
      )
    }
  }
}
