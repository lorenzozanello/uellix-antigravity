// tests/eval/stella-release/project-binding-harness.ts
// RELEASE line — Train 4.2 (STELLA_RELEASE_PROJECT_BOUND_TICKET_GATE_TRAIN_4_2),
// Fases 2-5. One function per project-binding-matrix.ts `caseId`, exercising
// the `*ForExecution` verbs Train 4.2 added to ticket-protocol.ts. Fully
// offline: no network, no DB, no provider — same discipline as
// idempotency-harness.ts, whose `withControls`/fixture/case-function shape
// this file mirrors deliberately rather than importing (the two harnesses
// must be able to diverge without either one silently breaking the other).

import {
  controlExpectsViolations,
  controlExpectsVerdict,
  runNegativeControl,
  undetectedControls,
  describeUndetected,
  type NegativeControlResult,
} from './negative-controls'
import {
  createReferenceTicketProtocol,
  TicketExecutionProjectMismatchError,
  type OperationTicketReferenceProtocol,
  type TicketProtocolDefect,
  type TicketScope,
} from './ticket-protocol'
import { evaluateQuotaOracle } from './idempotency-oracle'
import { validateObservabilityEvent } from './observability-contract'
import { PROJECT_BINDING_MATRIX, PROJECT_BINDING_MATRIX_VERSION, validateProjectBindingMatrix } from './project-binding-matrix'

export const PROJECT_BINDING_HARNESS_VERSION = '1.0.0'

export type ProjectBindingCaseOutcome = 'pass' | 'system-error'

export interface ProjectBindingCaseResult {
  caseId: string
  ok: boolean
  outcome: ProjectBindingCaseOutcome
  detail: string
  negativeControls: NegativeControlResult[]
}

function withControls(
  base: Omit<ProjectBindingCaseResult, 'negativeControls'>,
  controls: readonly NegativeControlResult[],
): ProjectBindingCaseResult {
  const list = [...controls]
  if (undetectedControls(list).length > 0) {
    return {
      ...base,
      ok: false,
      outcome: 'system-error',
      detail: `TAUTOLOGICAL — this check cannot fail: ${describeUndetected(list)} (clean run said: ${base.detail})`,
      negativeControls: list,
    }
  }
  return { ...base, negativeControls: list }
}

function describeErr(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/* -------------------------------------------------------------------------- */
/* Fixtures — one organization, two sibling projects, plus a second org       */
/* -------------------------------------------------------------------------- */

const ORG_A: TicketScope = { organizationId: 'proj-org-alpha', projectId: 'proj-project-alpha-1', actorId: 'proj-actor-alpha-1' }
const ORG_A_OTHER_PROJECT: TicketScope = { ...ORG_A, projectId: 'proj-project-alpha-2' }
const ORG_B: TicketScope = { organizationId: 'proj-org-beta', projectId: 'proj-project-beta-1', actorId: 'proj-actor-beta-1' }

const AMPLE_QUOTAS = { [ORG_A.organizationId]: 100, [ORG_B.organizationId]: 100 }
const DEFAULT_TTL = 10

function freshProtocol(defect?: TicketProtocolDefect, quotas: Readonly<Record<string, number>> = AMPLE_QUOTAS, ticketTtl = DEFAULT_TTL): OperationTicketReferenceProtocol {
  return createReferenceTicketProtocol({ quotas, ticketTtl, defect })
}

/* -------------------------------------------------------------------------- */
/* ticket-and-execution-same-project-charges-once (Fase 2 case 1)             */
/* -------------------------------------------------------------------------- */

function checkTicketAndExecutionSameProjectChargesOnce(): ProjectBindingCaseResult {
  const caseId = 'ticket-and-execution-same-project-charges-once'
  const protocol = freshProtocol()
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bindForExecution(ticket.ticketId, ORG_A, ORG_A.projectId, 'q-project-match', 1)
  const outcome = protocol.completeForExecution(ticket.ticketId, ORG_A, ORG_A.projectId, 2)
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  const violations = evaluateQuotaOracle(before, after, protocol.allCharges(), {
    additionalCharges: 1,
    chargeableTicketId: ticket.ticketId,
    expectedIdempotencyKey: ticket.idempotencyKey,
    expectedChargeProjectId: ORG_A.projectId,
  })
  if (outcome.kind !== 'charged') violations.push(`completeForExecution() returned kind="${outcome.kind}", expected "charged"`)
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, [])
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: `ticket ${ticket.ticketId} charged exactly once, attributed to its own project ${ORG_A.projectId}` },
    [],
  )
}

/* -------------------------------------------------------------------------- */
/* execution-cross-project-same-organization-rejected (Fase 2 case 2)         */
/* execution-cross-organization-rejected (Fase 2 case 3)                      */
/* -------------------------------------------------------------------------- */

function evaluateBindRejectsForeignProject(defect: TicketProtocolDefect | undefined, foreignProjectId: string): string[] {
  const protocol = freshProtocol(defect)
  const ticket = protocol.issue(ORG_A, 0)
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const violations: string[] = []
  try {
    protocol.bindForExecution(ticket.ticketId, ORG_A, foreignProjectId, 'q-cross-project-exec', 1)
    violations.push('bindForExecution() with a foreign executionProjectId did NOT throw')
  } catch (error) {
    if (!(error instanceof TicketExecutionProjectMismatchError)) violations.push(`rejected for the wrong reason: ${describeErr(error)}`)
  }
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  violations.push(...evaluateQuotaOracle(before, after, protocol.allCharges(), { additionalCharges: 0 }))
  return violations
}

/**
 * Fase 4 control #5 — "firma antigua todavía ejecutable". The legacy `bind`/
 * `complete` verbs have NO parameter through which a caller could ever assert
 * an execution project, so they cannot reject a mismatch — they can only
 * charge unconditionally, exactly as `tests/e2e/stella-ticket-journey.e2e.test.ts`
 * already measures against the real database. `detected: true` here means
 * "the residual risk is confirmed present", not "our defenses caught an
 * attack" — see the long comment on evaluateCallerDerivesExecutionProjectFromTicket
 * below for the same distinction stated in full.
 */
function evaluateLegacySignatureBypassesProjectGate(): { detected: boolean; detail: string } {
  const protocol = freshProtocol()
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bind(ticket.ticketId, ORG_A, 'q-legacy-bypass', 1) // legacy verb — no executionProjectId parameter exists
  const outcome = protocol.complete(ticket.ticketId, ORG_A, 2) // legacy verb — same
  return outcome.kind === 'charged'
    ? {
        detected: true,
        detail:
          'legacy complete() charged unconditionally — it has no parameter through which a mismatched execution project could ever be rejected, confirming R2-INT is not closed merely by adding the *ForExecution verbs alongside the old ones; the old signature must be REPLACED for the real fix, not merely supplemented',
      }
    : { detected: false, detail: `unexpected outcome "${outcome.kind}" — the legacy signature normally has no basis to reject anything project-related` }
}

/**
 * Fase 4 control #6 — "server action usa proyecto del ticket en vez del
 * derivado". Even with the *ForExecution verbs available, a call site that
 * derives `executionProjectId` FROM the ticket it is validating against
 * (rather than independently, from the project the request/evidence actually
 * names) makes the check permanently vacuous: it will always agree with
 * itself, whatever project the work truly ran against. The protocol has
 * structurally no way to detect this from the inside — it only ever sees
 * what the caller hands it. `detected: true` documents that this residual
 * risk exists and is NOT closed by this train; it is why
 * project-binding-release-gate.ts's runtime report requires the real caller
 * (a future server action) to be shown deriving the value independently,
 * never merely re-reading it off the ticket.
 */
function evaluateCallerDerivesExecutionProjectFromTicket(): { detected: boolean; detail: string } {
  const protocol = freshProtocol()
  const ticket = protocol.issue(ORG_A, 0)
  const selfReferentialExecutionProjectId = ticket.scope.projectId // BUG: read back off the ticket itself
  protocol.bindForExecution(ticket.ticketId, ORG_A, selfReferentialExecutionProjectId, 'q-self-referential', 1)
  const outcome = protocol.completeForExecution(ticket.ticketId, ORG_A, selfReferentialExecutionProjectId, 2)
  return outcome.kind === 'charged'
    ? {
        detected: true,
        detail:
          'a caller that derives executionProjectId from the ticket itself always satisfies the mismatch check trivially — the protocol cannot distinguish this from a genuine, independently-verified match. Closing this requires the SERVER ACTION to derive executionProjectId from the request/evidence it is actually about to read, never from the ticket it is validating against',
      }
    : { detected: false, detail: `unexpected outcome "${outcome.kind}" for a self-referential (trivially matching) executionProjectId` }
}

function checkExecutionCrossProjectSameOrganizationRejected(): ProjectBindingCaseResult {
  const caseId = 'execution-cross-project-same-organization-rejected'
  const controls = [
    controlExpectsViolations(
      'nc-bind-ignores-execution-project',
      'a protocol whose bindForExecution() ignores the executionProjectId argument must be caught accepting a cross-project execution within the same organization',
      () => evaluateBindRejectsForeignProject('bind-ignores-execution-project', ORG_A_OTHER_PROJECT.projectId),
    ),
    runNegativeControl(
      'nc-legacy-signature-bypasses-project-gate',
      'the legacy bind()/complete() signatures (no executionProjectId parameter) must be shown to charge unconditionally regardless of the project the work actually executed against',
      evaluateLegacySignatureBypassesProjectGate,
    ),
    runNegativeControl(
      'nc-caller-derives-execution-project-from-ticket-not-request',
      'a call site that derives executionProjectId from the ticket\'s own scope (instead of independently, from the request/evidence) must be shown to make the mismatch check permanently vacuous',
      evaluateCallerDerivesExecutionProjectFromTicket,
    ),
  ]
  const violations = evaluateBindRejectsForeignProject(undefined, ORG_A_OTHER_PROJECT.projectId)
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: 'a ticket whose execution is asserted against a sibling project of the same organization is rejected by bindForExecution, zero charge' },
    controls,
  )
}

function checkExecutionCrossOrganizationRejected(): ProjectBindingCaseResult {
  const caseId = 'execution-cross-organization-rejected'
  const violations = evaluateBindRejectsForeignProject(undefined, ORG_B.projectId)
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, [])
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: 'a ticket whose execution is asserted against a project belonging to a different organization entirely is rejected by bindForExecution, zero charge' },
    [],
  )
}

/* -------------------------------------------------------------------------- */
/* bind-and-complete-different-project-mismatch-rejected (Fase 2 case 4)      */
/* -------------------------------------------------------------------------- */

function evaluateCompleteRejectsForeignProject(defect: TicketProtocolDefect | undefined, foreignProjectId: string): string[] {
  const protocol = freshProtocol(defect)
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bindForExecution(ticket.ticketId, ORG_A, ORG_A.projectId, 'q-bind-complete-mismatch', 1) // correct at bind time
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const violations: string[] = []
  try {
    protocol.completeForExecution(ticket.ticketId, ORG_A, foreignProjectId, 2)
    violations.push('completeForExecution() with a foreign executionProjectId did NOT throw')
  } catch (error) {
    if (!(error instanceof TicketExecutionProjectMismatchError)) violations.push(`rejected for the wrong reason: ${describeErr(error)}`)
  }
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  violations.push(...evaluateQuotaOracle(before, after, protocol.allCharges(), { additionalCharges: 0 }))
  const inspected = protocol.inspect(ticket.ticketId)
  if (inspected?.status !== 'reserved') {
    violations.push(`ticket status is "${inspected?.status}" after a rejected cross-project complete, expected "reserved" — it must remain completable once the correct project is asserted`)
  }
  return violations
}

function checkBindAndCompleteDifferentProjectMismatchRejected(): ProjectBindingCaseResult {
  const caseId = 'bind-and-complete-different-project-mismatch-rejected'
  const controls = [
    controlExpectsViolations(
      'nc-complete-ignores-execution-project',
      'a protocol whose completeForExecution() ignores the executionProjectId argument must be caught charging a ticket bound correctly but completed against a different project',
      () => evaluateCompleteRejectsForeignProject('complete-ignores-execution-project', ORG_A_OTHER_PROJECT.projectId),
    ),
  ]
  const violations = evaluateCompleteRejectsForeignProject(undefined, ORG_A_OTHER_PROJECT.projectId)
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: 'a ticket bound correctly against its own project, then completed against a sibling project, is rejected at complete with zero charge and remains reserved' },
    controls,
  )
}

/* -------------------------------------------------------------------------- */
/* bind-and-abort-different-project-mismatch-rejected (Fase 2 case 5)         */
/* -------------------------------------------------------------------------- */

function evaluateAbortRejectsForeignProject(defect: TicketProtocolDefect | undefined, foreignProjectId: string): string[] {
  const protocol = freshProtocol(defect)
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bindForExecution(ticket.ticketId, ORG_A, ORG_A.projectId, 'q-abort-mismatch', 1)
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const violations: string[] = []
  try {
    protocol.abortForExecution(ticket.ticketId, ORG_A, foreignProjectId, 2)
    violations.push('abortForExecution() with a foreign executionProjectId did NOT throw')
  } catch (error) {
    if (!(error instanceof TicketExecutionProjectMismatchError)) violations.push(`rejected for the wrong reason: ${describeErr(error)}`)
  }
  const inspected = protocol.inspect(ticket.ticketId)
  if (inspected?.status !== 'reserved') {
    violations.push(`ticket status is "${inspected?.status}" after a rejected cross-project abort, expected "reserved" to remain unchanged — an abort presented from the wrong project must not release someone else's reservation`)
  }
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  violations.push(...evaluateQuotaOracle(before, after, protocol.allCharges(), { additionalCharges: 0 }))
  return violations
}

function checkBindAndAbortDifferentProjectMismatchRejected(): ProjectBindingCaseResult {
  const caseId = 'bind-and-abort-different-project-mismatch-rejected'
  const controls = [
    controlExpectsViolations(
      'nc-abort-ignores-execution-project',
      'a protocol whose abortForExecution() ignores the executionProjectId argument must be caught releasing a reservation presented from a different project',
      () => evaluateAbortRejectsForeignProject('abort-ignores-execution-project', ORG_A_OTHER_PROJECT.projectId),
    ),
  ]
  const violations = evaluateAbortRejectsForeignProject(undefined, ORG_A_OTHER_PROJECT.projectId)
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: 'abortForExecution() presented with a sibling project is rejected, the reservation survives unchanged, zero charge' },
    controls,
  )
}

/* -------------------------------------------------------------------------- */
/* inspect-from-foreign-project-rejected (Fase 2 case 6)                      */
/* -------------------------------------------------------------------------- */

function evaluateInspectRejectsForeignProject(defect: TicketProtocolDefect | undefined, foreignProjectId: string): string[] {
  const protocol = freshProtocol(defect)
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bindForExecution(ticket.ticketId, ORG_A, ORG_A.projectId, 'q-inspect-mismatch', 1)
  const violations: string[] = []
  try {
    protocol.inspectForExecution(ticket.ticketId, foreignProjectId)
    violations.push('inspectForExecution() with a foreign executionProjectId did NOT throw')
  } catch (error) {
    if (!(error instanceof TicketExecutionProjectMismatchError)) violations.push(`rejected for the wrong reason: ${describeErr(error)}`)
  }
  if (protocol.allCharges().length !== 0) violations.push('a read-only inspectForExecution() attempt somehow produced a charge')
  return violations
}

function checkInspectFromForeignProjectRejected(): ProjectBindingCaseResult {
  const caseId = 'inspect-from-foreign-project-rejected'
  const controls = [
    controlExpectsViolations(
      'nc-inspect-ignores-execution-project',
      'a protocol whose inspectForExecution() ignores the executionProjectId argument must be caught leaking ticket state to a caller asserting the wrong project',
      () => evaluateInspectRejectsForeignProject('inspect-ignores-execution-project', ORG_A_OTHER_PROJECT.projectId),
    ),
  ]
  const violations = evaluateInspectRejectsForeignProject(undefined, ORG_A_OTHER_PROJECT.projectId)
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, controls)
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: 'inspectForExecution() presented with a sibling project throws instead of returning ticket state — read access is scoped exactly like every mutating verb' },
    controls,
  )
}

/* -------------------------------------------------------------------------- */
/* retry-after-complete-from-foreign-project-rejected (Fase 2 case 7)         */
/* -------------------------------------------------------------------------- */

function checkRetryAfterCompleteFromForeignProjectRejected(): ProjectBindingCaseResult {
  const caseId = 'retry-after-complete-from-foreign-project-rejected'
  const protocol = freshProtocol()
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bindForExecution(ticket.ticketId, ORG_A, ORG_A.projectId, 'q-retry-mismatch', 1)
  protocol.completeForExecution(ticket.ticketId, ORG_A, ORG_A.projectId, 2)
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const outcome = protocol.retryForExecution(ticket.ticketId, ORG_A, ORG_A_OTHER_PROJECT.projectId, 'q-retry-mismatch', 3)
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  const violations = evaluateQuotaOracle(before, after, protocol.allCharges(), { additionalCharges: 0 })
  if (outcome.kind !== 'rejected' || outcome.reason !== 'execution_project_mismatch') {
    violations.push(`retryForExecution() with a foreign executionProjectId returned ${JSON.stringify(outcome)}, expected {kind:"rejected", reason:"execution_project_mismatch"}`)
  }
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, [])
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: 'a completed ticket, retried from a sibling project, is rejected with execution_project_mismatch and zero additional charge' },
    [],
  )
}

/* -------------------------------------------------------------------------- */
/* same-query-text-new-project-charges-independently (Fase 2 case 8)          */
/* -------------------------------------------------------------------------- */

function checkSameQueryTextNewProjectChargesIndependently(): ProjectBindingCaseResult {
  const caseId = 'same-query-text-new-project-charges-independently'
  const protocol = freshProtocol()
  const ticketA = protocol.issue(ORG_A, 0)
  protocol.bindForExecution(ticketA.ticketId, ORG_A, ORG_A.projectId, 'same-query-cross-project', 1)
  const outcomeA = protocol.completeForExecution(ticketA.ticketId, ORG_A, ORG_A.projectId, 2)

  const scopeB = ORG_A_OTHER_PROJECT // same organization, a legitimately different project asking the identical question
  const ticketB = protocol.issue(scopeB, 3)
  protocol.bindForExecution(ticketB.ticketId, scopeB, scopeB.projectId, 'same-query-cross-project', 4)
  const before = protocol.snapshotLedger(scopeB.organizationId)
  const outcomeB = protocol.completeForExecution(ticketB.ticketId, scopeB, scopeB.projectId, 5)
  const after = protocol.snapshotLedger(scopeB.organizationId)

  const violations = evaluateQuotaOracle(before, after, protocol.allCharges(), {
    additionalCharges: 1,
    chargeableTicketId: ticketB.ticketId,
    expectedIdempotencyKey: ticketB.idempotencyKey,
    expectedChargeProjectId: scopeB.projectId,
  })
  if (outcomeA.kind !== 'charged') violations.push(`project A's ticket did not charge: "${outcomeA.kind}"`)
  if (outcomeB.kind !== 'charged') violations.push(`project B's ticket (same query text, different project) returned "${outcomeB.kind}", expected "charged"`)
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, [])
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: 'two independently-issued tickets for the same query text, in two different projects of the same organization, each charge their own unit, each correctly attributed' },
    [],
  )
}

/* -------------------------------------------------------------------------- */
/* concurrent-cross-project-attempts-charge-correct-project-once (Fase 2 case 9)*/
/* -------------------------------------------------------------------------- */

function checkConcurrentCrossProjectAttemptsChargeCorrectProjectOnce(): ProjectBindingCaseResult {
  const caseId = 'concurrent-cross-project-attempts-charge-correct-project-once'
  // Same "one synchronous window" simulation idempotency-harness.ts's own
  // concurrency cases use — see ticket-protocol.ts's ConcurrencyAttempt doc
  // comment. Here the healthy model's own sequential .map()-style processing
  // (simulateConcurrentAttempts under no defect) is reproduced directly via
  // two ordered completeForExecution calls, since no NEW race-condition
  // defect is introduced for this dimension; what is under test is whether
  // project ATTRIBUTION survives a last-unit race, not the race itself.
  const protocol = createReferenceTicketProtocol({ quotas: { [ORG_A.organizationId]: 1 }, ticketTtl: DEFAULT_TTL })
  const ticketA = protocol.issue(ORG_A, 0)
  const ticketB = protocol.issue(ORG_A_OTHER_PROJECT, 0)
  protocol.bindForExecution(ticketA.ticketId, ORG_A, ORG_A.projectId, 'q-concurrency-project-a', 1)
  protocol.bindForExecution(ticketB.ticketId, ORG_A_OTHER_PROJECT, ORG_A_OTHER_PROJECT.projectId, 'q-concurrency-project-b', 1)
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  const outcomeA = protocol.completeForExecution(ticketA.ticketId, ORG_A, ORG_A.projectId, 2)
  const outcomeB = protocol.completeForExecution(ticketB.ticketId, ORG_A_OTHER_PROJECT, ORG_A_OTHER_PROJECT.projectId, 2)
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  const allCharges = protocol.allCharges()

  const violations = evaluateQuotaOracle(before, after, allCharges, { additionalCharges: 1 })
  const charged = [outcomeA, outcomeB].filter((o) => o.kind === 'charged')
  const exhausted = [outcomeA, outcomeB].filter((o) => o.kind === 'quota_exceeded')
  if (charged.length !== 1 || exhausted.length !== 1) {
    violations.push(`two tickets from two distinct projects racing for the last unit produced ${charged.length} charged + ${exhausted.length} quota_exceeded, expected exactly 1 + 1`)
  } else {
    const winningTicketId = charged[0]!.ticketId
    const expectedProjectId = winningTicketId === ticketA.ticketId ? ORG_A.projectId : ORG_A_OTHER_PROJECT.projectId
    const chargeRow = allCharges.find((c) => c.ticketId === winningTicketId)
    if (!chargeRow || chargeRow.projectId !== expectedProjectId) {
      violations.push(`the winning ticket's charge was attributed to project "${chargeRow?.projectId}", expected "${expectedProjectId}" — a last-unit race must never swap which project a charge lands under`)
    }
  }
  if (violations.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: violations.join(' | ') }, [])
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: 'two tickets from two distinct projects of the same organization, racing for the last unit of shared quota, produce exactly one charge attributed to the project that actually won' },
    [],
  )
}

/* -------------------------------------------------------------------------- */
/* charge-stored-under-correct-project (Fase 2 case 10)                       */
/* -------------------------------------------------------------------------- */

function evaluateChargeProjectAttribution(defect?: TicketProtocolDefect): { narrow: string[]; extended: string[] } {
  const protocol = freshProtocol(defect)
  const ticket = protocol.issue(ORG_A, 0)
  protocol.bindForExecution(ticket.ticketId, ORG_A, ORG_A.projectId, 'q-charge-attribution', 1)
  const before = protocol.snapshotLedger(ORG_A.organizationId)
  protocol.completeForExecution(ticket.ticketId, ORG_A, ORG_A.projectId, 2)
  const after = protocol.snapshotLedger(ORG_A.organizationId)
  const allCharges = protocol.allCharges()
  // "narrow" is deliberately what a check that only ever verifies
  // organizationId + a charge count would compute — no expectedChargeProjectId.
  const narrow = evaluateQuotaOracle(before, after, allCharges, {
    additionalCharges: 1,
    chargeableTicketId: ticket.ticketId,
    expectedIdempotencyKey: ticket.idempotencyKey,
  })
  const extended = evaluateQuotaOracle(before, after, allCharges, {
    additionalCharges: 1,
    chargeableTicketId: ticket.ticketId,
    expectedIdempotencyKey: ticket.idempotencyKey,
    expectedChargeProjectId: ORG_A.projectId,
  })
  return { narrow, extended }
}

function checkChargeStoredUnderCorrectProject(): ProjectBindingCaseResult {
  const caseId = 'charge-stored-under-correct-project'
  const controls = [
    // Fase 4 control #7 — "cargo correcto en organización pero proyecto
    // incorrecto": the check itself passed (executionProjectId matched at
    // bind/complete time), but the STORAGE layer drifted the charge to a
    // sibling project anyway. Only the EXTENDED oracle can see this.
    controlExpectsViolations(
      'nc-charge-project-drifts-same-organization',
      'a storage layer that attributes a charge to a sibling project of the SAME organization, despite the execution-project check having already passed, must be caught by the extended oracle',
      () => evaluateChargeProjectAttribution('charge-attributed-to-wrong-project-same-org').extended,
    ),
    // Fase 4 control #8 — "test que sólo revisa organization_id": the SAME
    // mutation above must be shown INVISIBLE to a narrower oracle that never
    // asked about projectId — proving Fase 3's "no basta con... una unidad
    // total cobrada" requirement is load-bearing, not decorative.
    controlExpectsVerdict(
      'nc-oracle-checking-only-organization-insufficient',
      'a check that only verifies organizationId and a charge count (never projectId) must be shown insufficient — it reports zero violations even when the charge silently drifted to a sibling project of the same organization',
      () => evaluateChargeProjectAttribution('charge-attributed-to-wrong-project-same-org').narrow.length === 0,
      true,
    ),
  ]
  const { extended } = evaluateChargeProjectAttribution()
  if (extended.length > 0) return withControls({ caseId, ok: false, outcome: 'system-error', detail: extended.join(' | ') }, controls)
  return withControls(
    { caseId, ok: true, outcome: 'pass', detail: 'the stored charge for a correctly-matched execution is attributed to the ticket\'s own project, proven by the extended oracle (ticket.project_id == execution.project_id == charge.project_id)' },
    controls,
  )
}

/* -------------------------------------------------------------------------- */
/* Fase 5 — observability: project mismatch is distinguishable, no secrets    */
/* -------------------------------------------------------------------------- */

/** The stable, category-safe code a `replay_rejected` event would carry for
 *  THIS failure mode — an opaque code, never a sentence, matching the
 *  discipline every other `reasonCode` in ticket-protocol.ts's
 *  `OperationOutcome` already follows (e.g. "query_mismatch", "scope_mismatch"). */
export const PROJECT_MISMATCH_REASON_CODE = 'execution_project_mismatch'

function buildProjectMismatchRejectionEvent() {
  return {
    eventName: 'replay_rejected' as const,
    timestamp: '2026-08-05T00:00:00.000Z',
    organizationId: ORG_A.organizationId,
    projectId: ORG_A.projectId,
    requestId: 'req-project-binding-1',
    ticketId: 'ticket-1',
    reasonCode: PROJECT_MISMATCH_REASON_CODE,
  }
}

/**
 * Fase 5. No new event name and no allowlist change is needed: `projectId`
 * is already a COMMON field on every event (observability-contract.ts), and
 * `reasonCode` already accepts any short, opaque code on `replay_rejected` —
 * this proves a project-mismatch rejection is distinguishable using the
 * EXISTING contract, reusing it rather than opening a parallel one. What
 * this DOES prove: the representable event never smuggles in the query, its
 * hash, the ticket's idempotency key material, evidence, or a secret.
 */
export function evaluateProjectMismatchObservabilitySafe(): string[] {
  const violations: string[] = []
  const clean = validateObservabilityEvent(buildProjectMismatchRejectionEvent())
  if (!clean.ok) violations.push(...clean.violations)
  const withForbiddenField = validateObservabilityEvent({ ...buildProjectMismatchRejectionEvent(), query: 'texto completo de la consulta' })
  if (withForbiddenField.ok) violations.push('an event carrying the raw query text alongside a project-mismatch rejection was accepted by the shared observability contract')
  return violations
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

const CASES: Record<string, () => ProjectBindingCaseResult> = {
  'ticket-and-execution-same-project-charges-once': checkTicketAndExecutionSameProjectChargesOnce,
  'execution-cross-project-same-organization-rejected': checkExecutionCrossProjectSameOrganizationRejected,
  'execution-cross-organization-rejected': checkExecutionCrossOrganizationRejected,
  'bind-and-complete-different-project-mismatch-rejected': checkBindAndCompleteDifferentProjectMismatchRejected,
  'bind-and-abort-different-project-mismatch-rejected': checkBindAndAbortDifferentProjectMismatchRejected,
  'inspect-from-foreign-project-rejected': checkInspectFromForeignProjectRejected,
  'retry-after-complete-from-foreign-project-rejected': checkRetryAfterCompleteFromForeignProjectRejected,
  'same-query-text-new-project-charges-independently': checkSameQueryTextNewProjectChargesIndependently,
  'concurrent-cross-project-attempts-charge-correct-project-once': checkConcurrentCrossProjectAttemptsChargeCorrectProjectOnce,
  'charge-stored-under-correct-project': checkChargeStoredUnderCorrectProject,
}

export class ProjectBindingHarnessError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ProjectBindingHarnessError'
  }
}

function assertProjectBindingCasesMatchMatrix(): void {
  const matrixIds = new Set(PROJECT_BINDING_MATRIX.map((e) => e.caseId))
  const caseIds = new Set(Object.keys(CASES))
  for (const id of matrixIds) if (!caseIds.has(id)) throw new ProjectBindingHarnessError(`matrix entry "${id}" has no implemented case`)
  for (const id of caseIds) if (!matrixIds.has(id)) throw new ProjectBindingHarnessError(`implemented case "${id}" has no matrix entry`)
}

export interface ProjectBindingEvalSummary {
  harnessVersion: string
  matrixVersion: string
  totalCases: number
  passed: number
  failed: number
  negativeControlsRun: number
  negativeControlsUndetected: number
  tautologicalCases: string[]
  /** Fase 5 — true iff evaluateProjectMismatchObservabilitySafe() found zero violations. */
  observabilitySafe: boolean
  observabilityViolations: string[]
}

export interface ProjectBindingEvalRun {
  summary: ProjectBindingEvalSummary
  results: ProjectBindingCaseResult[]
}

/** Deterministic — no Date.now()/Math.random() anywhere in the reference
 *  model or the cases above; two calls produce byte-identical output. */
export function runProjectBindingEvalHarness(): ProjectBindingEvalRun {
  validateProjectBindingMatrix(PROJECT_BINDING_MATRIX)
  assertProjectBindingCasesMatchMatrix()

  const results = PROJECT_BINDING_MATRIX.map((entry) => CASES[entry.caseId]!())
  const negativeControlsRun = results.reduce((n, r) => n + r.negativeControls.length, 0)
  const negativeControlsUndetected = results.reduce((n, r) => n + r.negativeControls.filter((c) => !c.detected).length, 0)
  const tautologicalCases = results.filter((r) => r.detail.startsWith('TAUTOLOGICAL')).map((r) => r.caseId)
  const observabilityViolations = evaluateProjectMismatchObservabilitySafe()

  const summary: ProjectBindingEvalSummary = {
    harnessVersion: PROJECT_BINDING_HARNESS_VERSION,
    matrixVersion: PROJECT_BINDING_MATRIX_VERSION,
    totalCases: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    negativeControlsRun,
    negativeControlsUndetected,
    tautologicalCases,
    observabilitySafe: observabilityViolations.length === 0,
    observabilityViolations,
  }

  return { summary, results }
}

export function projectBindingEvalFailureReasons(summary: ProjectBindingEvalSummary): string[] {
  const reasons: string[] = []
  if (summary.failed > 0) reasons.push(`${summary.failed}/${summary.totalCases} project-binding cases failed`)
  if (summary.negativeControlsUndetected > 0) reasons.push(`${summary.negativeControlsUndetected} negative control(s) failed to detect their mutation`)
  if (summary.tautologicalCases.length > 0) reasons.push(`tautological case(s): ${summary.tautologicalCases.join(', ')}`)
  if (!summary.observabilitySafe) reasons.push(`observability not safe: ${summary.observabilityViolations.join(' | ')}`)
  return reasons
}
