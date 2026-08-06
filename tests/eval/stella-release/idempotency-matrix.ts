// tests/eval/stella-release/idempotency-matrix.ts
// RELEASE line — Train 4.1 (STELLA_RELEASE_IDEMPOTENCY_GATE_TRAIN_4_1), Fase 2.
//
// 20 entries, one per case the dispatch requires. Declarative only — see
// idempotency-harness.ts for the one function per `caseId` that actually
// exercises ticket-protocol.ts's reference model, and
// assertIdempotencyCasesMatchMatrix() there for the same
// matrix<->implementation reconciliation harness.ts already enforces for the
// grounding matrix (never let a matrix entry exist with no check, or a check
// exist with no matrix entry).
//
// The four failure-mode vocabularies a caller can confuse, kept explicit
// because the dispatch calls out distinguishing them as a requirement:
//
//   retry              — the SAME ticket, re-presented, for the SAME query.
//                         Free after the first charge.
//   new operation      — a NEW ticket, for a query whose TEXT happens to
//                         match a previous one. Charges again — a reviewer
//                         asking the same question twice after new evidence
//                         must not get a silent discount.
//   duplicate delivery — the transport layer redelivers one logical attempt
//                         (e.g. a network-level resend of the same request).
//                         Indistinguishable, AT THIS LAYER, from a retry —
//                         and that is the point: it is why `retry` must be
//                         idempotent rather than relying on the transport to
//                         de-duplicate.
//   replay attack       — a ticket (or its key) is presented again with a
//                         DIFFERENT query, by a caller trying to spend an
//                         already-charged or wrongly-scoped ticket for
//                         something else. Always rejected, never charged.

export const IDEMPOTENCY_MATRIX_VERSION = '1.0.0'

export type IdempotencyCaseCategory =
  | 'first-execution'
  | 'retry-same-ticket'
  | 'new-operation-same-text'
  | 'ticket-text-mismatch'
  | 'cross-organization'
  | 'cross-project'
  | 'cross-actor'
  | 'ticket-expired'
  | 'ticket-nonexistent'
  | 'failure-before-answer'
  | 'failure-after-reserve'
  | 'explicit-abort'
  | 'retry-after-abort'
  | 'retry-after-complete'
  | 'concurrent-same-ticket'
  | 'concurrent-last-unit'
  | 'client-selected-idempotency-key'
  | 'client-selected-ticket-scope'
  | 'feature-flag-disabled'
  | 'observability-event-safe'

export interface IdempotencyMatrixEntry {
  readonly caseId: string
  readonly category: IdempotencyCaseCategory
  readonly description: string
  /** Which of the four vocabularies (see header) this case pins, when it
   *  applies — several cases exist precisely to keep two of them apart. */
  readonly distinguishes: readonly ('retry' | 'new-operation' | 'duplicate-delivery' | 'replay-attack')[]
}

export const IDEMPOTENCY_MATRIX: readonly IdempotencyMatrixEntry[] = [
  {
    caseId: 'first-execution-charges-once',
    category: 'first-execution',
    description: 'issue -> bind -> complete on a fresh ticket charges exactly one unit, and the charge is attributable to that ticket\'s server-derived idempotency key.',
    distinguishes: [],
  },
  {
    caseId: 'retry-same-ticket-same-query-charges-once',
    category: 'retry-same-ticket',
    description: 'The SAME ticket, re-presented via retry() with the SAME query fingerprint after a successful complete(), charges zero additional units and reports replayed with the original chargeId.',
    distinguishes: ['retry'],
  },
  {
    caseId: 'new-ticket-same-query-text-charges-again',
    category: 'new-operation-same-text',
    description: 'A SECOND issue() for the same scope, bound to a query fingerprint identical to a previously-charged ticket\'s, charges a NEW unit — a legitimate repeated question is never free.',
    distinguishes: ['new-operation'],
  },
  {
    caseId: 'same-ticket-different-query-text-rejected',
    category: 'ticket-text-mismatch',
    description: 'Re-binding (or retrying) an already-bound ticket with a DIFFERENT query fingerprint is rejected with query_mismatch — a ticket is not a blank cheque a caller can repoint at a new question.',
    distinguishes: ['replay-attack'],
  },
  {
    caseId: 'cross-organization-ticket-rejected',
    category: 'cross-organization',
    description: 'complete()/retry() presented with a scope whose organizationId differs from the ticket\'s issuing scope is rejected with scope_mismatch/TicketScopeViolationError and charges zero units.',
    distinguishes: ['replay-attack'],
  },
  {
    caseId: 'cross-project-ticket-rejected',
    category: 'cross-project',
    description: 'Same as above, for projectId within the SAME organization — the narrower and easier-to-miss case.',
    distinguishes: ['replay-attack'],
  },
  {
    caseId: 'cross-actor-ticket-rejected',
    category: 'cross-actor',
    description: 'Same as above, for actorId within the same organization and project — a ticket issued to one member is not spendable by another.',
    distinguishes: ['replay-attack'],
  },
  {
    caseId: 'expired-ticket-rejected-not-charged',
    category: 'ticket-expired',
    description: 'A ticket presented to retry()/complete() after now >= expiresAt is reported expired (or rejected, for retry) and charges zero units, regardless of how it was bound.',
    distinguishes: [],
  },
  {
    caseId: 'nonexistent-ticket-rejected',
    category: 'ticket-nonexistent',
    description: 'A ticketId the protocol never issued is rejected (TicketNotFoundError from complete/bind/abort; { kind: rejected, reason: ticket_not_found } from retry) — never silently treated as a fresh operation.',
    distinguishes: ['replay-attack'],
  },
  {
    caseId: 'failure-before-reserve-charges-nothing',
    category: 'failure-before-answer',
    description: 'A ticket that is issued and then never bound (the orchestrator failed before it could name the operation) charges zero units on any subsequent complete() attempt — complete() on an unreserved ticket is rejected outright.',
    distinguishes: [],
  },
  {
    caseId: 'failure-after-reserve-charges-nothing-until-retried',
    category: 'failure-after-reserve',
    description: 'A ticket that is bound but whose orchestration then fails BEFORE complete() is called charges zero units; the reservation survives so a later retry() can still legitimately complete it once.',
    distinguishes: [],
  },
  {
    caseId: 'explicit-abort-charges-nothing-definitively',
    category: 'explicit-abort',
    description: 'abort() on a reserved (never completed) ticket charges zero units, and a completed ticket cannot be aborted at all — abort is a promise, not a decoration.',
    distinguishes: [],
  },
  {
    caseId: 'retry-after-abort-rejected',
    category: 'retry-after-abort',
    description: 'retry() on an aborted ticket is rejected with ticket_aborted and charges zero units — an abort is not a state a retry can resurrect into a charge.',
    distinguishes: ['replay-attack'],
  },
  {
    caseId: 'retry-after-complete-is-free',
    category: 'retry-after-complete',
    description: 'retry() on an already-completed ticket, same query, reports replayed and charges zero additional units — the transport-duplicate-delivery case, indistinguishable from an application-level retry, and correctly free either way.',
    distinguishes: ['retry', 'duplicate-delivery'],
  },
  {
    caseId: 'concurrent-same-ticket-charges-once',
    category: 'concurrent-same-ticket',
    description: 'Two attempts to complete the SAME ticket, simulated as a checked-then-acted race (simulateConcurrentAttempts), still produce exactly one charge under the healthy (locked) model.',
    distinguishes: ['duplicate-delivery'],
  },
  {
    caseId: 'concurrent-distinct-tickets-last-unit-charges-once',
    category: 'concurrent-last-unit',
    description: 'Two DIFFERENT tickets (two legitimate, distinct operations) racing for the organization\'s last remaining unit produce exactly one charge and one quota_exceeded under the healthy model — never two charges against one unit of quota.',
    distinguishes: ['new-operation'],
  },
  {
    caseId: 'client-cannot-choose-idempotency-key',
    category: 'client-selected-idempotency-key',
    description: 'A caller offering its own idempotency key at issue time never has that key honoured — the ticket\'s effective key is always the server-derived one, proven with attemptClientSuppliedIdempotencyKey.',
    distinguishes: [],
  },
  {
    caseId: 'client-cannot-choose-ticket-scope',
    category: 'client-selected-ticket-scope',
    description: 'A caller offering a scope that differs from the authenticated session\'s never has that scope honoured — the issued ticket is always scoped to the session, proven with attemptClientSuppliedScope.',
    distinguishes: [],
  },
  {
    caseId: 'feature-flag-off-blocks-issuance',
    category: 'feature-flag-disabled',
    description: 'With STELLA_GROUNDED_QUERY_ENABLED false — the real flag app/actions/stella/grounded-query.ts already gates on first, per its own header — no ticket protocol call happens at all: this case asserts the boolean is false in this worktree, the same fail-closed discipline stella-decision-feature-flag-blocks-persistence already applies to the sibling decisions flag.',
    distinguishes: [],
  },
  {
    caseId: 'ticket-lifecycle-events-carry-no-secrets',
    category: 'observability-event-safe',
    description: 'Every one of the 10 ticket-lifecycle observability events (operation_ticket_issued/bound/expired, grounded_query_reserved/completed/aborted/retried, quota_consumed, quota_reuse_detected, replay_rejected) validates clean against the SAME validateObservabilityEvent contract the rest of Stella\'s events use — opaque ids and codes only, never a query, a prompt or a secret.',
    distinguishes: [],
  },
] as const

const REQUIRED_CATEGORIES: readonly IdempotencyCaseCategory[] = [
  'first-execution', 'retry-same-ticket', 'new-operation-same-text', 'ticket-text-mismatch',
  'cross-organization', 'cross-project', 'cross-actor', 'ticket-expired', 'ticket-nonexistent',
  'failure-before-answer', 'failure-after-reserve', 'explicit-abort', 'retry-after-abort',
  'retry-after-complete', 'concurrent-same-ticket', 'concurrent-last-unit',
  'client-selected-idempotency-key', 'client-selected-ticket-scope', 'feature-flag-disabled',
  'observability-event-safe',
]

export class IdempotencyMatrixError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'IdempotencyMatrixError'
  }
}

/** Same discipline as validateReleaseEvalMatrix: fails closed on a duplicate
 *  or missing caseId, and on a missing required category — 20 categories,
 *  ni una más ni una menos. */
export function validateIdempotencyMatrix(matrix: readonly IdempotencyMatrixEntry[]): void {
  const seen = new Set<string>()
  for (const entry of matrix) {
    if (!entry.caseId || seen.has(entry.caseId)) {
      throw new IdempotencyMatrixError(`duplicated or missing caseId: "${entry.caseId}"`)
    }
    seen.add(entry.caseId)
  }
  const covered = new Set(matrix.map((e) => e.category))
  for (const category of REQUIRED_CATEGORIES) {
    if (!covered.has(category)) throw new IdempotencyMatrixError(`matrix is missing required category "${category}"`)
  }
  if (matrix.length !== 20) {
    throw new IdempotencyMatrixError(`matrix has ${matrix.length} entries, the dispatch requires exactly 20`)
  }
}
