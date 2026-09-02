// tests/eval/stella-release/reserved-quota-matrix.ts
// RELEASE line — Train 4.3 (STELLA_RELEASE_RESERVED_QUOTA_GATE_TRAIN_4_3), Fase 3.
//
// 15 entries, exactly the Fase 3 dispatch list, in order. Declarative only —
// see reserved-quota-harness.ts for the one function per `caseId` that
// exercises reserved-quota-protocol.ts's reference model, and
// assertReservedQuotaCasesMatchMatrix() there for the same
// matrix<->implementation reconciliation discipline idempotency-matrix.ts /
// idempotency-harness.ts already use.
//
// The outcome vocabulary Fase 3 requires kept distinguishable —
// quota_exceeded, reservation_held, completed, aborted, expired, replayed,
// scope mismatch — is the union of ReservationAttemptKind,
// SiblingConsumptionKind and GroundedCompletionKind in
// reserved-quota-protocol.ts, plus the thrown scope/expiry/completed/aborted
// error types; no case here invents a new one.

export const RESERVED_QUOTA_MATRIX_VERSION = '1.0.0'

export type ReservedQuotaCaseCategory =
  | 'grounded-reserves-last-unit'
  | 'sibling-rejected-after-reservation'
  | 'grounded-completes-without-recontending'
  | 'abort-then-sibling-consumes'
  | 'expiration-then-sibling-consumes'
  | 'sibling-first-then-bind-rejected'
  | 'grounded-complete-vs-sibling-concurrent'
  | 'two-grounded-reservations-last-unit'
  | 'two-siblings-last-unit'
  | 'retry-no-double-reserve-or-charge'
  | 'failure-and-abort-zero-charge'
  | 'period-boundary-crossing'
  | 'category-shares-single-pool'
  | 'cross-project-reservation-rejected'
  | 'cross-organization-reservation-rejected'

export interface ReservedQuotaMatrixEntry {
  readonly caseId: string
  readonly category: ReservedQuotaCaseCategory
  readonly description: string
}

export const RESERVED_QUOTA_MATRIX: readonly ReservedQuotaMatrixEntry[] = [
  {
    caseId: 'grounded-reserves-last-unit',
    category: 'grounded-reserves-last-unit',
    description:
      'With exactly one unit of shared capacity remaining, reserveGroundedOperation() succeeds — reservation_held — and inspectCapacity() shows Consumed=0, LiveReserved=1, available=0.',
  },
  {
    caseId: 'sibling-rejected-after-grounded-reserves-last-unit',
    category: 'sibling-rejected-after-reservation',
    description:
      'A sibling operation attempted AFTER a grounded reservation already holds the organization\'s last unit is rejected — quota_exceeded, zero charge — because the reservation counts as capacity, not merely the eventual charge.',
  },
  {
    caseId: 'grounded-completes-without-recontending',
    category: 'grounded-completes-without-recontending',
    description:
      'The grounded reservation from the previous case completes — charged — without having to compete for capacity a second time: Consumed goes from 0 to 1 and LiveReserved goes from 1 to 0 in the SAME transition.',
  },
  {
    caseId: 'explicit-abort-releases-then-sibling-consumes',
    category: 'abort-then-sibling-consumes',
    description:
      'A live grounded reservation is explicitly aborted; the unit it held becomes available immediately, and a subsequent sibling consumption for the SAME organization succeeds.',
  },
  {
    caseId: 'expiration-releases-then-sibling-consumes',
    category: 'expiration-then-sibling-consumes',
    description:
      'A live grounded reservation is never completed and its TTL elapses; expireReservation() releases the held unit, and a subsequent sibling consumption succeeds.',
  },
  {
    caseId: 'sibling-consumes-first-then-grounded-reserve-rejected',
    category: 'sibling-first-then-bind-rejected',
    description:
      'A sibling operation consumes the organization\'s last unit FIRST; a subsequent reserveGroundedOperation() for the same organization is rejected — quota_exceeded, no reservation minted.',
  },
  {
    caseId: 'grounded-complete-vs-sibling-concurrent',
    category: 'grounded-complete-vs-sibling-concurrent',
    description:
      'A live grounded reservation already holds the last unit; a sibling consumption and the reservation\'s own completion are evaluated through the concurrent-attempt simulator. Under the healthy model the sibling is rejected and the reservation charges, because the reservation\'s hold predates the race window. Additionally, WITH the sibling-ignores-reservations defect isolated to the sibling\'s own gate, completeGroundedReservation\'s independent re-check against the true combined ledger still refuses (quota_refused, discardedComputedResponse=true) rather than letting the ledger oversell — R1\'s policy, proven reachable without ever letting Consumed exceed Limit.',
  },
  {
    caseId: 'two-grounded-reservations-for-last-unit',
    category: 'two-grounded-reservations-last-unit',
    description:
      'Two DISTINCT grounded reservation attempts race, via the concurrent simulator, for the organization\'s single remaining unit. Exactly one reservation is held and one is quota_exceeded under the healthy (locked) model.',
  },
  {
    caseId: 'two-siblings-for-last-unit',
    category: 'two-siblings-last-unit',
    description:
      'Two sibling consumption attempts — possibly different categories, per case 13\'s single-shared-pool requirement — race, via the concurrent simulator, for the organization\'s single remaining unit. Exactly one consumes and one is quota_exceeded under the healthy (locked) model.',
  },
  {
    caseId: 'retry-grounded-does-not-reserve-or-charge-again',
    category: 'retry-no-double-reserve-or-charge',
    description:
      'retry() on an already-completed grounded reservation reports replayed with the ORIGINAL chargeId and mints no new reservation, charges no additional unit — never re-reserves, never re-charges.',
  },
  {
    caseId: 'grounded-failure-and-abort-charges-nothing',
    category: 'failure-and-abort-zero-charge',
    description:
      'A grounded reservation whose orchestration fails before completeGroundedReservation() is called, followed by an explicit abort(), produces definitively zero charge and the released unit is available to any subsequent operation.',
  },
  {
    caseId: 'reservation-crossing-period-boundary',
    category: 'period-boundary-crossing',
    description:
      'A reservation held in period P, completed at a tick that has already crossed into period P+1, is still charged against period P (the period the reservation — and the capacity check that granted it — actually belongs to), never silently reattributed to the new period.',
  },
  {
    caseId: 'independent-category-shares-single-pool',
    category: 'category-shares-single-pool',
    description:
      'Two DIFFERENT sibling categories draw down the SAME shared organization pool — db/prepared/stella_0013_grounded_query_quota.sql §6 counts every governed stella_role together, so this contract does NOT permit independent per-category limits (Fase 3\'s "si el contrato lo permite" resolves to: it does not). A second category\'s consumption attempt against an already-exhausted pool is rejected exactly like a same-category one would be.',
  },
  {
    caseId: 'reservation-scoped-to-other-project-rejected',
    category: 'cross-project-reservation-rejected',
    description:
      'completeGroundedReservation()/abortReservation() presented with a scope whose projectId differs from the reservation\'s own issuing scope (same organization) is rejected — ReservationScopeViolationError — and charges zero units.',
  },
  {
    caseId: 'reservation-scoped-to-other-organization-rejected',
    category: 'cross-organization-reservation-rejected',
    description:
      'Same as above, for organizationId — the wider and more consequential axis: a reservation issued to one organization is not completable/abortable by a caller asserting a different one.',
  },
] as const

const REQUIRED_CATEGORIES: readonly ReservedQuotaCaseCategory[] = [
  'grounded-reserves-last-unit',
  'sibling-rejected-after-reservation',
  'grounded-completes-without-recontending',
  'abort-then-sibling-consumes',
  'expiration-then-sibling-consumes',
  'sibling-first-then-bind-rejected',
  'grounded-complete-vs-sibling-concurrent',
  'two-grounded-reservations-last-unit',
  'two-siblings-last-unit',
  'retry-no-double-reserve-or-charge',
  'failure-and-abort-zero-charge',
  'period-boundary-crossing',
  'category-shares-single-pool',
  'cross-project-reservation-rejected',
  'cross-organization-reservation-rejected',
]

export class ReservedQuotaMatrixError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ReservedQuotaMatrixError'
  }
}

/** Same discipline as validateIdempotencyMatrix/validateProjectBindingMatrix:
 *  fails closed on a duplicate or missing caseId, and on a missing required
 *  category — 15 categories, ni una más ni una menos. */
export function validateReservedQuotaMatrix(matrix: readonly ReservedQuotaMatrixEntry[]): void {
  const seen = new Set<string>()
  for (const entry of matrix) {
    if (!entry.caseId || seen.has(entry.caseId)) {
      throw new ReservedQuotaMatrixError(`duplicated or missing caseId: "${entry.caseId}"`)
    }
    seen.add(entry.caseId)
  }
  const covered = new Set(matrix.map((e) => e.category))
  for (const category of REQUIRED_CATEGORIES) {
    if (!covered.has(category)) throw new ReservedQuotaMatrixError(`matrix is missing required category "${category}"`)
  }
  if (matrix.length !== 15) {
    throw new ReservedQuotaMatrixError(`matrix has ${matrix.length} entries, Fase 3 requires exactly 15`)
  }
}
