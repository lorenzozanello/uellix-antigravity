// tests/golden/registry.ts
//
// ONE CONTRACT PER FROZEN STEP. NO STEP WITHOUT ONE. NO CONTRACT WITHOUT A STEP.
//
// ===========================================================================
// WHAT THIS TABLE IS FOR
// ===========================================================================
// The frozen authority names 23 steps across J1, J2 and J3. The requirement on
// this lane is that every one of them exists in the harness as either an
// EXECUTING_ASSERTION or an EXECUTABLE_BLOCKED_CONTRACT, and that none of them
// is silently absent.
//
// "Silently absent" is the whole problem. A journey file that simply does not
// mention a step produces no failure, no skip marker and no reporter row — it
// produces nothing, and nothing reads as success. So coverage cannot be left
// implicit in which `test()` calls happen to exist. It is declared here, keyed
// by the step ids DERIVED from the authority, and the meta guard reconciles
// the two sets in both directions.
//
// ===========================================================================
// WHY DISPOSITION IS COMPUTED, NOT WRITTEN DOWN
// ===========================================================================
// A step is not permanently "blocked". It is blocked GIVEN a target tier and
// GIVEN the current upstream posture. Writing `disposition: 'BLOCKED'` into
// this table would freeze today's accident into the contract, and the whole
// mechanism exists to do the opposite: when the blocker is remediated, the
// contract must turn RED and force conversion into a positive journey.
//
// So each entry declares only what is stable — which journey, which step, and
// what stands in the way — and `disposeStep` derives the disposition at run
// time from the declared target and a live posture reading.
//
// ===========================================================================
// THE HONESTY FIELD
// ===========================================================================
// `blockedBy: TARGET_ONLY` means exactly what it says: the only reason this
// step is not traversed is that no target was declared. It carries NO
// substantive assertion about the product. Nineteen of the twenty-three steps
// are in that state at this base, and they are counted separately from the
// four that carry a posture probe.
//
// This distinction is the difference between a skeleton that reports its own
// shape accurately and one that presents twenty-three placeholders as
// twenty-three controls.

import type { FrozenJourney } from './authority'
import { runPostureProbe, type PostureReading } from './posture'
import { tierIsServed, type GoldenTarget } from './target'

/** Why a step cannot currently be traversed as a positive assertion. */
export type BlockedBy =
  | { readonly kind: 'TARGET_ONLY' }
  | { readonly kind: 'POSTURE_PROBE'; readonly probeId: string }

export interface StepContract {
  readonly journeyId: string
  readonly stepId: string
  readonly blockedBy: BlockedBy
  /**
   * What the positive assertion will be once the step is traversable.
   * Recorded now so conversion is a rewrite of a named thing rather than a
   * fresh design exercise under time pressure.
   */
  readonly positiveIntent: string
}

export type Disposition = 'EXECUTING_ASSERTION' | 'EXECUTABLE_BLOCKED_CONTRACT'

export interface StepDisposition {
  readonly contract: StepContract
  readonly disposition: Disposition
  /** Present only when the disposition is a blocked contract. */
  readonly refusalAsserted: string | undefined
  /** The live posture reading, when this contract has a probe. */
  readonly posture: PostureReading | undefined
}

const j1 = (stepId: string, blockedBy: BlockedBy, positiveIntent: string): StepContract => ({
  journeyId: 'J1',
  stepId,
  blockedBy,
  positiveIntent,
})
const j2 = (stepId: string, blockedBy: BlockedBy, positiveIntent: string): StepContract => ({
  journeyId: 'J2',
  stepId,
  blockedBy,
  positiveIntent,
})
const j3 = (stepId: string, blockedBy: BlockedBy, positiveIntent: string): StepContract => ({
  journeyId: 'J3',
  stepId,
  blockedBy,
  positiveIntent,
})

const TARGET_ONLY: BlockedBy = { kind: 'TARGET_ONLY' }
const probe = (probeId: string): BlockedBy => ({ kind: 'POSTURE_PROBE', probeId })

/**
 * The contracts, keyed by `${journeyId}:${stepId}`.
 *
 * Step ids are the slugs `authority.ts` derives from the frozen `path`
 * sentences. They are written out here rather than generated so that a change
 * to the authority's wording produces a RECONCILIATION FAILURE in the meta
 * guard — a loud, locatable disagreement — instead of a table that silently
 * re-keys itself to whatever the authority now says and keeps passing.
 */
export const STEP_CONTRACTS: readonly StepContract[] = [
  // --- J1, customer journey (13 frozen steps) ---------------------------
  j1('signup', TARGET_ONLY, 'a new subject completes signup and reaches the verify-email surface'),
  j1(
    'organisation-founding',
    TARGET_ONLY,
    'the signed-up subject founds an organisation and becomes its administrator',
  ),
  j1('roles-and-users', TARGET_ONLY, 'the administrator invites a second user and assigns a role'),
  j1('project-creation', TARGET_ONLY, 'a project is created inside the founded organisation'),
  j1('evidence', TARGET_ONLY, 'an evidence item is uploaded and reaches an indexed state'),
  j1('proxy', TARGET_ONLY, 'a financial proxy is selected and bound to an outcome'),
  j1('outcomes-and-filters', TARGET_ONLY, 'outcomes are recorded and the filter surface narrows them'),
  j1(
    'the-social-return-computation',
    TARGET_ONLY,
    'a calculation run completes and yields a result the report can cite',
  ),
  j1(
    'the-governed-assistant',
    TARGET_ONLY,
    'the governed assistant answers within its quota and writes its audit row',
  ),
  j1('report-generation', TARGET_ONLY, 'a report is generated and locked'),
  j1('portfolio', TARGET_ONLY, 'the locked report becomes visible in the portfolio surface'),
  j1(
    'evaluation',
    probe('J1-EVALUATE-RUNTIME-ABSENT'),
    'the evaluation leg is traversed end to end against a real evaluation runtime',
  ),
  j1('review-and-approval', TARGET_ONLY, 'a reviewer approves the locked report through the review surface'),

  // --- J2, operator journey (8 frozen steps) ----------------------------
  j2('signup-allowlist', TARGET_ONLY, 'an operator adds and removes a signup allowlist entry'),
  j2('organisations', TARGET_ONLY, 'an operator lists organisations across tenants'),
  j2('audit-logs', TARGET_ONLY, 'an operator reads the global audit log surface'),
  j2('statistics', TARGET_ONLY, 'an operator reads platform statistics'),
  j2('proxies', TARGET_ONLY, 'an operator administers global proxies'),
  j2('assistant-services', TARGET_ONLY, 'an operator administers assistant service entitlements'),
  j2(
    'deletion-approval',
    TARGET_ONLY,
    'an operator approves a project deletion raised by a different principal',
  ),
  j2('commercial-accounts', TARGET_ONLY, 'an operator administers commercial accounts'),

  // --- J3, public verifier journey (2 frozen steps) ---------------------
  j3(
    'resolve-a-public-verification-locator-as-an-anonymous-caller',
    probe('J3-ANON-READ-BLOCKED'),
    'an anonymous caller resolves a real locator and sees the verified report',
  ),
  j3(
    'its-document-rendering',
    probe('J3-ANON-READ-BLOCKED'),
    'the same anonymous caller renders the verified document from that locator',
  ),
]

/** Negative controls. The authority requires at least one per journey. */
export interface NegativeControl {
  readonly journeyId: string
  readonly id: string
  readonly blockedBy: BlockedBy
  /** The authority's own statement of what this control is for. */
  readonly intentSource: 'frozen negative_control_intent'
}

export const NEGATIVE_CONTROLS: readonly NegativeControl[] = [
  { journeyId: 'J1', id: 'J1-NC-CROSS-TENANT-REFUSAL', blockedBy: TARGET_ONLY, intentSource: 'frozen negative_control_intent' },
  {
    journeyId: 'J2',
    id: 'J2-NC-NON-OPERATOR-REFUSED',
    blockedBy: probe('J2-PLATFORM-PRINCIPAL-AMBIGUOUS'),
    intentSource: 'frozen negative_control_intent',
  },
  {
    journeyId: 'J3',
    id: 'J3-NC-UNKNOWN-LOCATOR-REFUSED',
    blockedBy: probe('J3-NO-RATE-LIMIT'),
    intentSource: 'frozen negative_control_intent',
  },
]

export function contractKey(journeyId: string, stepId: string): string {
  return `${journeyId}:${stepId}`
}

/**
 * Decide a step's disposition for a given target.
 *
 * The order of the checks is the point. Target absence dominates: with nothing
 * served, no step is traversed regardless of posture. Only once a target
 * exists does the upstream blocker decide, and only when neither stands in the
 * way is a step an EXECUTING_ASSERTION.
 */
export function disposeStep(contract: StepContract, target: GoldenTarget): StepDisposition {
  // The posture probe runs FIRST, and runs regardless of the tier.
  //
  // An earlier version returned early on an unserved target and left `posture`
  // undefined. That was wrong in a way worth recording: a posture probe reads
  // the repository's own source and needs no target at all, so short-circuiting
  // on target absence made the entire posture layer inert in the DEFAULT
  // deterministic profile — the one tier where it is the only substantive
  // assertion available. The three posture-backed steps would have collapsed
  // into the same "no target" record as the other twenty, and the blocker
  // remediation signal, which is the whole point of the mechanism, would never
  // have fired in CI.
  const posture =
    contract.blockedBy.kind === 'POSTURE_PROBE' ? runPostureProbe(contract.blockedBy.probeId) : undefined

  if (!tierIsServed(target.kind)) {
    return {
      contract,
      disposition: 'EXECUTABLE_BLOCKED_CONTRACT',
      refusalAsserted:
        posture === undefined
          ? `no Golden Journey target was declared (${target.kind}), so this step was not traversed; ` +
            'recorded as blocked rather than omitted'
          : `${posture.evidence}; additionally, no Golden Journey target was declared (${target.kind})`,
      posture,
    }
  }

  if (posture !== undefined && posture.blockerStillPresent) {
    return {
      contract,
      disposition: 'EXECUTABLE_BLOCKED_CONTRACT',
      refusalAsserted: posture.evidence,
      posture,
    }
  }

  return { contract, disposition: 'EXECUTING_ASSERTION', refusalAsserted: undefined, posture }
}

/**
 * Reconcile the registry against the frozen journeys, in BOTH directions.
 *
 * Returns the two set differences rather than a boolean. A boolean would
 * collapse "the authority gained a step nobody covered" and "the registry
 * covers a step the authority dropped" into one indistinguishable false, and
 * those two conditions call for opposite repairs.
 */
export interface RegistryReconciliation {
  /** Frozen steps with no contract. A coverage hole. */
  readonly uncoveredSteps: readonly string[]
  /** Contracts naming a step the authority does not define. A stale entry. */
  readonly orphanedContracts: readonly string[]
  /** Contracts registered more than once under the same key. */
  readonly duplicateContracts: readonly string[]
}

export function reconcileRegistry(
  journeys: readonly FrozenJourney[],
  contracts: readonly StepContract[] = STEP_CONTRACTS,
): RegistryReconciliation {
  const frozenKeys = new Set<string>()
  for (const journey of journeys) {
    for (const step of journey.steps) frozenKeys.add(contractKey(journey.id, step.id))
  }

  const seen = new Set<string>()
  const duplicateContracts: string[] = []
  const contractKeys = new Set<string>()
  for (const contract of contracts) {
    const key = contractKey(contract.journeyId, contract.stepId)
    if (seen.has(key)) duplicateContracts.push(key)
    seen.add(key)
    contractKeys.add(key)
  }

  return {
    uncoveredSteps: [...frozenKeys].filter((key) => !contractKeys.has(key)).sort(),
    orphanedContracts: [...contractKeys].filter((key) => !frozenKeys.has(key)).sort(),
    duplicateContracts: duplicateContracts.sort(),
  }
}

/** Count of contracts whose only obstacle is target absence. Reported separately, on purpose. */
export function targetOnlyContractCount(
  contracts: readonly StepContract[] = STEP_CONTRACTS,
): number {
  return contracts.filter((contract) => contract.blockedBy.kind === 'TARGET_ONLY').length
}
