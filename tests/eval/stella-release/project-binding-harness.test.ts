// tests/eval/stella-release/project-binding-harness.test.ts
// RELEASE line — Train 4.2 (STELLA_RELEASE_PROJECT_BOUND_TICKET_GATE_TRAIN_4_2).
// Offline: no network, no DB, no provider — the reference protocol is a
// deterministic in-memory model.

import { describe, it, expect } from 'vitest'
import { PROJECT_BINDING_MATRIX, validateProjectBindingMatrix } from './project-binding-matrix'
import {
  runProjectBindingEvalHarness,
  projectBindingEvalFailureReasons,
  evaluateProjectMismatchObservabilitySafe,
  PROJECT_MISMATCH_REASON_CODE,
} from './project-binding-harness'
import { createReferenceTicketProtocol, TicketExecutionProjectMismatchError, type TicketScope } from './ticket-protocol'
import { evaluateQuotaOracle } from './idempotency-oracle'

const ORG: TicketScope = { organizationId: 'proj-org-x', projectId: 'proj-project-x-1', actorId: 'proj-actor-x-1' }
const ORG_OTHER_PROJECT: TicketScope = { ...ORG, projectId: 'proj-project-x-2' }

describe('PROJECT_BINDING_MATRIX — shape', () => {
  it('validates cleanly: 10 entries, 10 required categories, no duplicates', () => {
    expect(() => validateProjectBindingMatrix(PROJECT_BINDING_MATRIX)).not.toThrow()
    expect(PROJECT_BINDING_MATRIX.length).toBe(10)
  })

  it('fails closed on a duplicated caseId', () => {
    const broken = [...PROJECT_BINDING_MATRIX, PROJECT_BINDING_MATRIX[0]!]
    expect(() => validateProjectBindingMatrix(broken)).toThrow(/duplicated or missing caseId/)
  })

  it('fails closed on a missing required category', () => {
    const broken = PROJECT_BINDING_MATRIX.filter((e) => e.category !== 'project-attribution-cross-project-same-organization')
    expect(() => validateProjectBindingMatrix(broken)).toThrow(/missing required category/)
  })
})

describe('runProjectBindingEvalHarness — the real, clean run', () => {
  const run = runProjectBindingEvalHarness()

  it('every one of the 10 cases has exactly one matrix entry and vice versa (no drift)', () => {
    const caseIds = new Set(run.results.map((r) => r.caseId))
    const matrixIds = new Set(PROJECT_BINDING_MATRIX.map((e) => e.caseId))
    expect(caseIds).toEqual(matrixIds)
  })

  it('10/10 cases pass, zero tautological, zero undetected negative controls', () => {
    const failing = run.results.filter((r) => !r.ok)
    expect(failing.map((r) => `${r.caseId}: ${r.detail}`)).toEqual([])
    expect(run.summary.tautologicalCases).toEqual([])
    expect(run.summary.negativeControlsUndetected).toBe(0)
  })

  it('ran exactly the 8 Fase-4 negative controls distributed across the matrix (the 9th lives in project-binding-release-gate.test.ts)', () => {
    expect(run.summary.negativeControlsRun).toBe(8)
  })

  it('observability is safe', () => {
    expect(run.summary.observabilitySafe).toBe(true)
    expect(run.summary.observabilityViolations).toEqual([])
  })

  it('projectBindingEvalFailureReasons reports nothing on a clean run', () => {
    expect(projectBindingEvalFailureReasons(run.summary)).toEqual([])
  })

  it('is deterministic — two independent runs produce byte-identical summaries and results', () => {
    const second = runProjectBindingEvalHarness()
    expect(JSON.stringify(second.summary)).toBe(JSON.stringify(run.summary))
    expect(JSON.stringify(second.results)).toBe(JSON.stringify(run.results))
  })

  it('every case carries a non-trivial detail, never a bare boolean', () => {
    for (const result of run.results) expect(result.detail.length).toBeGreaterThan(10)
  })
})

describe('projectBindingEvalFailureReasons — fails closed on a synthetic broken summary', () => {
  it('reports failed cases, undetected controls, tautological cases and unsafe observability independently', () => {
    const reasons = projectBindingEvalFailureReasons({
      harnessVersion: '1.0.0', matrixVersion: '1.0.0', totalCases: 10, passed: 8, failed: 2,
      negativeControlsRun: 8, negativeControlsUndetected: 1, tautologicalCases: ['some-case'],
      observabilitySafe: false, observabilityViolations: ['synthetic violation'],
    })
    expect(reasons).toEqual([
      '2/10 project-binding cases failed',
      '1 negative control(s) failed to detect their mutation',
      'tautological case(s): some-case',
      'observability not safe: synthetic violation',
    ])
  })
})

describe('evaluateProjectMismatchObservabilitySafe — Fase 5', () => {
  it('is clean, and the reason code is a stable, opaque string, never a sentence', () => {
    expect(evaluateProjectMismatchObservabilitySafe()).toEqual([])
    expect(PROJECT_MISMATCH_REASON_CODE).toBe('execution_project_mismatch')
    expect(PROJECT_MISMATCH_REASON_CODE).not.toMatch(/\s/)
  })
})

/* -------------------------------------------------------------------------- */
/* Direct reference-model tests — the *ForExecution verbs Train 4.2 added     */
/* -------------------------------------------------------------------------- */

describe('createReferenceTicketProtocol — *ForExecution verbs, Fase 1/3', () => {
  it('bindForExecution + completeForExecution with the matching project charges once, attributed to that project', () => {
    const protocol = createReferenceTicketProtocol({ quotas: { [ORG.organizationId]: 10 }, ticketTtl: 5 })
    const before = protocol.snapshotLedger(ORG.organizationId)
    const ticket = protocol.issue(ORG, 0)
    protocol.bindForExecution(ticket.ticketId, ORG, ORG.projectId, 'q', 1)
    const outcome = protocol.completeForExecution(ticket.ticketId, ORG, ORG.projectId, 2)
    const after = protocol.snapshotLedger(ORG.organizationId)
    expect(outcome.kind).toBe('charged')
    expect(
      evaluateQuotaOracle(before, after, protocol.allCharges(), {
        additionalCharges: 1,
        chargeableTicketId: ticket.ticketId,
        expectedIdempotencyKey: ticket.idempotencyKey,
        expectedChargeProjectId: ORG.projectId,
      }),
    ).toEqual([])
  })

  it('bindForExecution rejects a foreign project with TicketExecutionProjectMismatchError, zero charge', () => {
    const protocol = createReferenceTicketProtocol({ quotas: { [ORG.organizationId]: 10 }, ticketTtl: 5 })
    const ticket = protocol.issue(ORG, 0)
    expect(() => protocol.bindForExecution(ticket.ticketId, ORG, ORG_OTHER_PROJECT.projectId, 'q', 1)).toThrow(TicketExecutionProjectMismatchError)
    expect(protocol.allCharges()).toEqual([])
  })

  it('completeForExecution rejects a foreign project even when bind was correct, and the ticket remains reserved', () => {
    const protocol = createReferenceTicketProtocol({ quotas: { [ORG.organizationId]: 10 }, ticketTtl: 5 })
    const ticket = protocol.issue(ORG, 0)
    protocol.bindForExecution(ticket.ticketId, ORG, ORG.projectId, 'q', 1)
    expect(() => protocol.completeForExecution(ticket.ticketId, ORG, ORG_OTHER_PROJECT.projectId, 2)).toThrow(TicketExecutionProjectMismatchError)
    expect(protocol.inspect(ticket.ticketId)?.status).toBe('reserved')
    expect(protocol.allCharges()).toEqual([])
  })

  it('abortForExecution rejects a foreign project and does not release the reservation', () => {
    const protocol = createReferenceTicketProtocol({ quotas: { [ORG.organizationId]: 10 }, ticketTtl: 5 })
    const ticket = protocol.issue(ORG, 0)
    protocol.bindForExecution(ticket.ticketId, ORG, ORG.projectId, 'q', 1)
    expect(() => protocol.abortForExecution(ticket.ticketId, ORG, ORG_OTHER_PROJECT.projectId, 2)).toThrow(TicketExecutionProjectMismatchError)
    expect(protocol.inspect(ticket.ticketId)?.status).toBe('reserved')
  })

  it('inspectForExecution rejects a foreign project (throws) rather than leaking ticket state', () => {
    const protocol = createReferenceTicketProtocol({ quotas: { [ORG.organizationId]: 10 }, ticketTtl: 5 })
    const ticket = protocol.issue(ORG, 0)
    protocol.bindForExecution(ticket.ticketId, ORG, ORG.projectId, 'q', 1)
    expect(() => protocol.inspectForExecution(ticket.ticketId, ORG_OTHER_PROJECT.projectId)).toThrow(TicketExecutionProjectMismatchError)
    expect(protocol.inspectForExecution(ticket.ticketId, ORG.projectId)?.status).toBe('reserved')
  })

  it('inspectForExecution on an unknown ticket returns null rather than throwing (no info leak either way)', () => {
    const protocol = createReferenceTicketProtocol({ quotas: { [ORG.organizationId]: 10 }, ticketTtl: 5 })
    expect(protocol.inspectForExecution('never-issued', ORG.projectId)).toBeNull()
  })

  it('retryForExecution rejects a foreign project with a rejected/execution_project_mismatch outcome, never throws', () => {
    const protocol = createReferenceTicketProtocol({ quotas: { [ORG.organizationId]: 10 }, ticketTtl: 5 })
    const ticket = protocol.issue(ORG, 0)
    protocol.bindForExecution(ticket.ticketId, ORG, ORG.projectId, 'q', 1)
    protocol.completeForExecution(ticket.ticketId, ORG, ORG.projectId, 2)
    const outcome = protocol.retryForExecution(ticket.ticketId, ORG, ORG_OTHER_PROJECT.projectId, 'q', 3)
    expect(outcome).toEqual({ kind: 'rejected', ticketId: ticket.ticketId, chargeId: null, reason: 'execution_project_mismatch' })
  })

  it('every legacy verb (issue/bind/complete/abort/retry/expire/inspect) is completely untouched by Train 4.2', () => {
    const protocol = createReferenceTicketProtocol({ quotas: { [ORG.organizationId]: 10 }, ticketTtl: 5 })
    const ticket = protocol.issue(ORG, 0)
    protocol.bind(ticket.ticketId, ORG, 'q', 1)
    const outcome = protocol.complete(ticket.ticketId, ORG, 2)
    expect(outcome.kind).toBe('charged')
    // The legacy complete() still attributes to the ticket's own project —
    // it has no other project to attribute to. This is the exact behaviour
    // tests/e2e/stella-ticket-journey.e2e.test.ts pins as real today.
    expect(protocol.chargesFor(ticket.ticketId)[0]!.projectId).toBe(ORG.projectId)
  })

  it('the drift defect misattributes a charge to a sibling project EVEN THOUGH the execution-project check passed', () => {
    const protocol = createReferenceTicketProtocol({
      quotas: { [ORG.organizationId]: 10 }, ticketTtl: 5, defect: 'charge-attributed-to-wrong-project-same-org',
    })
    const ticket = protocol.issue(ORG, 0)
    protocol.bindForExecution(ticket.ticketId, ORG, ORG.projectId, 'q', 1)
    protocol.completeForExecution(ticket.ticketId, ORG, ORG.projectId, 2) // check passes: ORG.projectId === ORG.projectId
    expect(protocol.chargesFor(ticket.ticketId)[0]!.projectId).not.toBe(ORG.projectId)
  })
})
