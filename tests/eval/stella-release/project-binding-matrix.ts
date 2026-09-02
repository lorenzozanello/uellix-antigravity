// tests/eval/stella-release/project-binding-matrix.ts
// RELEASE line — Train 4.2 (STELLA_RELEASE_PROJECT_BOUND_TICKET_GATE_TRAIN_4_2), Fase 2.
//
// R2-INT (docs/ops/contracts/CONTRACT_LEDGER.md#r2-int), MAJOR, still open:
// `bind_operation_ticket`/`complete_operation_ticket` receive no parameter
// for the project the query actually executes against, so the real database
// cannot compare it with the ticket's own project — a charge silently lands
// under the TICKET's project while the work reads evidence from the ACTION's
// project. `tests/e2e/stella-ticket-journey.e2e.test.ts` ("un ticket de OTRO
// proyecto de la misma organización y actor...") already PINS this as
// today's real, measured behaviour — this train does not touch that file or
// the real signatures; it builds the evaluation contract the eventual fix
// must satisfy, exactly as ticket-protocol.ts's own header describes for
// Train 4.1's idempotency contract.
//
// 10 entries, one per Fase 2 case, exercised by one function per `caseId` in
// project-binding-harness.ts — same matrix<->implementation reconciliation
// discipline idempotency-matrix.ts / idempotency-harness.ts already use
// (assertProjectBindingCasesMatchMatrix() there; never let a matrix entry
// exist with no check, or a check exist with no matrix entry).
//
// The oracle requires THREE identifiers to agree — ticket.project_id ==
// execution.project_id == charge.project_id — and Fase 3 requires the
// matrix to keep four DIFFERENT failure axes distinguishable, because a
// caller that conflates them ends up "testing" the same thing four times
// under four different names:
//
//   project scope mismatch      — the ticket is presented/executed against a
//                                  SIBLING project of the SAME organization.
//                                  The narrow, easy-to-miss case R2-INT names.
//   organization scope mismatch — the asserted execution project belongs to
//                                  a DIFFERENT organization entirely. Already
//                                  covered in principle by Train 4.1's own
//                                  scope check; re-proven here because the
//                                  *ForExecution verbs are a NEW call surface
//                                  and must not silently skip it.
//   actor mismatch               — orthogonal to project attribution; NOT a
//                                  case in this matrix (idempotency-matrix.ts
//                                  already owns cross-actor-ticket-rejected).
//                                  Named here only so a reader of Fase 3
//                                  knows it was considered and deliberately
//                                  left with its existing owner, not missed.
//   query mismatch                — likewise already owned by
//                                  same-ticket-different-query-text-rejected
//                                  in idempotency-matrix.ts; not duplicated.

export const PROJECT_BINDING_MATRIX_VERSION = '1.0.0'

export type ProjectBindingCaseCategory =
  | 'project-attribution-match'
  | 'project-attribution-cross-project-same-organization'
  | 'project-attribution-cross-organization'
  | 'project-attribution-bind-complete-mismatch'
  | 'project-attribution-abort-mismatch'
  | 'project-attribution-inspect-mismatch'
  | 'project-attribution-retry-after-complete-mismatch'
  | 'project-attribution-same-query-new-project'
  | 'project-attribution-concurrency-last-unit'
  | 'project-attribution-charge-storage'

export interface ProjectBindingMatrixEntry {
  readonly caseId: string
  readonly category: ProjectBindingCaseCategory
  readonly description: string
  /** Which of Fase 3's four failure axes this case pins, when it applies —
   *  'actor-mismatch' and 'query-mismatch' never appear here (see header):
   *  they already have an owner in idempotency-matrix.ts and are not
   *  reproduced under a new name. */
  readonly distinguishes: readonly ('project-scope-mismatch' | 'organization-scope-mismatch')[]
}

export const PROJECT_BINDING_MATRIX: readonly ProjectBindingMatrixEntry[] = [
  {
    caseId: 'ticket-and-execution-same-project-charges-once',
    category: 'project-attribution-match',
    description:
      'issue -> bindForExecution -> completeForExecution with the SAME project throughout charges exactly one unit, and the charge is attributable to that project via the extended oracle (Fase 2 case 1).',
    distinguishes: [],
  },
  {
    caseId: 'execution-cross-project-same-organization-rejected',
    category: 'project-attribution-cross-project-same-organization',
    description:
      'A ticket issued for project A, whose execution is asserted against a SIBLING project of the SAME organization, is rejected by bindForExecution with zero charge — the exact axis R2-INT names as unenforced by the real bind_operation_ticket/complete_operation_ticket today (Fase 2 case 2).',
    distinguishes: ['project-scope-mismatch'],
  },
  {
    caseId: 'execution-cross-organization-rejected',
    category: 'project-attribution-cross-organization',
    description:
      'A ticket issued for project A is presented with an executionProjectId belonging to a DIFFERENT organization entirely. Rejected with zero charge — defense in depth on the NEW *ForExecution call surface, proven independently of the pre-existing scope check (Fase 2 case 3).',
    distinguishes: ['organization-scope-mismatch'],
  },
  {
    caseId: 'bind-and-complete-different-project-mismatch-rejected',
    category: 'project-attribution-bind-complete-mismatch',
    description:
      'bindForExecution correctly asserts project A; a LATER completeForExecution asserts sibling project B. Rejected at complete, zero charge, ticket remains reserved and completable later with the correct project (Fase 2 case 4).',
    distinguishes: ['project-scope-mismatch'],
  },
  {
    caseId: 'bind-and-abort-different-project-mismatch-rejected',
    category: 'project-attribution-abort-mismatch',
    description:
      'bindForExecution correctly asserts project A; abortForExecution asserts sibling project B. Rejected, ticket remains "reserved" (not aborted), zero charge — an abort presented from the wrong project must not be able to release someone else\'s reservation either (Fase 2 case 5).',
    distinguishes: ['project-scope-mismatch'],
  },
  {
    caseId: 'inspect-from-foreign-project-rejected',
    category: 'project-attribution-inspect-mismatch',
    description:
      'inspectForExecution asserting a foreign project is rejected (throws) rather than silently returning ticket state — read access is scoped exactly like every mutating verb (Fase 2 case 6).',
    distinguishes: ['project-scope-mismatch'],
  },
  {
    caseId: 'retry-after-complete-from-foreign-project-rejected',
    category: 'project-attribution-retry-after-complete-mismatch',
    description:
      'A ticket completed under project A is later retryForExecution\'d asserting sibling project B. Rejected with execution_project_mismatch and zero additional charge — a completed ticket\'s replay path is scoped exactly like every other verb (Fase 2 case 7).',
    distinguishes: ['project-scope-mismatch'],
  },
  {
    caseId: 'same-query-text-new-project-charges-independently',
    category: 'project-attribution-same-query-new-project',
    description:
      'Two INDEPENDENTLY issued tickets, one for project A and one for a sibling project B of the same organization, bound to the IDENTICAL query text, each execute correctly against their own project and each charges its own unit, each correctly attributed — project-scoped charging is not a global de-duplication key (Fase 2 case 8).',
    distinguishes: [],
  },
  {
    caseId: 'concurrent-cross-project-attempts-charge-correct-project-once',
    category: 'project-attribution-concurrency-last-unit',
    description:
      'Two distinct tickets from two distinct projects of the same organization, sharing one unit of quota, both execute against their OWN correct project. Exactly one charges and one is quota_exceeded, and the winning charge is attributed to the project that actually won — never swapped (Fase 2 case 9).',
    distinguishes: [],
  },
  {
    caseId: 'charge-stored-under-correct-project',
    category: 'project-attribution-charge-storage',
    description:
      'The stored ChargeRecord.projectId for a correctly-matched execution equals both the ticket\'s own project and the asserted execution project — proven by the EXTENDED oracle (expectedChargeProjectId), which is also shown to catch a same-organization storage-layer drift that an organization-only oracle would miss entirely (Fase 2 case 10; Fase 3\'s three-way equality; Fase 4\'s "cargo correcto en organización pero proyecto incorrecto" and "test que sólo revisa organization_id").',
    distinguishes: [],
  },
] as const

const REQUIRED_CATEGORIES: readonly ProjectBindingCaseCategory[] = [
  'project-attribution-match',
  'project-attribution-cross-project-same-organization',
  'project-attribution-cross-organization',
  'project-attribution-bind-complete-mismatch',
  'project-attribution-abort-mismatch',
  'project-attribution-inspect-mismatch',
  'project-attribution-retry-after-complete-mismatch',
  'project-attribution-same-query-new-project',
  'project-attribution-concurrency-last-unit',
  'project-attribution-charge-storage',
]

export class ProjectBindingMatrixError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ProjectBindingMatrixError'
  }
}

/** Same discipline as validateIdempotencyMatrix: fails closed on a duplicate
 *  or missing caseId, and on a missing required category — 10 categories,
 *  ni una más ni una menos (Fase 2 lists exactly 10 numbered cases). */
export function validateProjectBindingMatrix(matrix: readonly ProjectBindingMatrixEntry[]): void {
  const seen = new Set<string>()
  for (const entry of matrix) {
    if (!entry.caseId || seen.has(entry.caseId)) {
      throw new ProjectBindingMatrixError(`duplicated or missing caseId: "${entry.caseId}"`)
    }
    seen.add(entry.caseId)
  }
  const covered = new Set(matrix.map((e) => e.category))
  for (const category of REQUIRED_CATEGORIES) {
    if (!covered.has(category)) throw new ProjectBindingMatrixError(`matrix is missing required category "${category}"`)
  }
  if (matrix.length !== 10) {
    throw new ProjectBindingMatrixError(`matrix has ${matrix.length} entries, Fase 2 requires exactly 10`)
  }
}
