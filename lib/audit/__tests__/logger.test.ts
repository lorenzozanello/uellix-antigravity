// lib/audit/__tests__/logger.test.ts
// WS3b U2: unit tests for the audit writer and the Stella audit action
// vocabulary. No real DB — @/db/client is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInsertValues = vi.fn().mockResolvedValue([])
const mockDbInsert = vi.fn().mockReturnValue({ values: mockInsertValues })
vi.mock('@/db/client', () => ({
  db: {
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
}))

import { AUDIT_ACTIONS, logAuditAction, recordAuditCorrection, AuditContractViolationError } from '../logger'

// The governed shape of an AUDIT_ACTIONS value: TWO OR MORE lowercase
// snake_case segments joined by single dots (ODS v1.0.27, F-DY-1). The
// superseded pin /^[a-z_]+\.[a-z_]+$/ admitted exactly two segments — [a-z_]
// cannot cross a dot — so it encoded the vocabulary as it happened to stand
// rather than the convention the repository governs. The sweep over the live
// vocabulary and the accept/reject controls below all bind to THIS constant,
// so a control can never drift away from the pin it is meant to guard.
const AUDIT_ACTION_VALUE_PATTERN = /^[a-z_]+(\.[a-z_]+)+$/

describe('AUDIT_ACTIONS — Stella runtime vocabulary (WS3b)', () => {
  it('defines the three Stella runtime actions with entity.verb naming', () => {
    expect(AUDIT_ACTIONS.STELLA_INVOKED).toBe('stella.invoked')
    expect(AUDIT_ACTIONS.STELLA_DENIED).toBe('stella.denied')
    expect(AUDIT_ACTIONS.STELLA_INTEGRITY_REJECTED).toBe('stella.integrity_rejected')
  })

  it('defines the decision-persistence action (WS3b U4, dormant until G2)', () => {
    expect(AUDIT_ACTIONS.STELLA_DECISION_RECORDED).toBe('stella.decision_recorded')
  })

  it('keeps the pre-existing quota-management action untouched', () => {
    expect(AUDIT_ACTIONS.STELLA_SERVICE_UPDATED).toBe('stella_service.updated')
  })

  it('every action value follows the dot-separated lowercase convention', () => {
    for (const value of Object.values(AUDIT_ACTIONS)) {
      expect(value).toMatch(AUDIT_ACTION_VALUE_PATTERN)
    }
  })

  it.each([
    ['project.created', 'two segments, the shape most governed actions use'],
    ['portfolio.updated', 'two segments on another entity'],
    ['tenancy.organization.selection_refused', 'three segments (S3 refusal)'],
    ['tenancy.membership.revalidation_refused', 'three segments (S3 refusal)'],
  ])('accepts %s — %s', (value) => {
    expect(value).toMatch(AUDIT_ACTION_VALUE_PATTERN)
  })

  // Widening the segment-count axis is indistinguishable from weakening the
  // gate unless the axes that did NOT move are pinned too. These five forms
  // are exactly what a careless widening would let through.
  it.each([
    ['created', 'an unprefixed bare verb — fewer than two segments'],
    ['Project.created', 'an uppercase character — the class is still [a-z_]'],
    ['project..created', 'an empty middle segment'],
    ['.project.created', 'an empty leading segment — still anchored at ^'],
    ['project.created.', 'an empty trailing segment — still anchored at $'],
  ])('rejects %s — %s', (value) => {
    expect(value).not.toMatch(AUDIT_ACTION_VALUE_PATTERN)
  })

  it('has no duplicate action values', () => {
    const values = Object.values(AUDIT_ACTIONS)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('logAuditAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInsertValues.mockResolvedValue([])
    mockDbInsert.mockReturnValue({ values: mockInsertValues })
  })

  it('inserts a row with the given entry fields', async () => {
    await logAuditAction({
      organizationId: 'org-1',
      actorUserId: 'user-1',
      entityType: 'project',
      entityId: 'proj-1',
      action: AUDIT_ACTIONS.STELLA_INVOKED,
      afterJson: { stellaRole: 'advisor', pipelineStep: 'narrative', tokensUsed: 42 },
    })

    expect(mockDbInsert).toHaveBeenCalledTimes(1)
    const payload = mockInsertValues.mock.calls[0][0]
    expect(payload.organizationId).toBe('org-1')
    expect(payload.actorUserId).toBe('user-1')
    expect(payload.entityType).toBe('project')
    expect(payload.entityId).toBe('proj-1')
    expect(payload.action).toBe('stella.invoked')
    expect(payload.afterJson).toEqual({ stellaRole: 'advisor', pipelineStep: 'narrative', tokensUsed: 42 })
  })

  it('fails closed (FIBC-040) instead of silently skipping when required fields are missing', async () => {
    await expect(
      logAuditAction({ entityType: '', entityId: 'x', action: AUDIT_ACTIONS.STELLA_DENIED }),
    ).rejects.toThrow(AuditContractViolationError)

    expect(mockDbInsert).not.toHaveBeenCalled()
  })

  it('propagates DB failures to the caller (callers decide whether to swallow)', async () => {
    mockInsertValues.mockRejectedValue(new Error('db down'))

    await expect(
      logAuditAction({ entityType: 'project', entityId: 'p1', action: AUDIT_ACTIONS.STELLA_DENIED }),
    ).rejects.toThrow('db down')
  })

  it('persists projectId when supplied (FIBDB-036)', async () => {
    await logAuditAction({
      organizationId: 'org-1',
      projectId: 'proj-1',
      actorUserId: 'user-1',
      entityType: 'project',
      entityId: 'proj-1',
      action: AUDIT_ACTIONS.PROJECT_PAUSED,
      afterJson: { status: 'paused' },
    })

    const payload = mockInsertValues.mock.calls[0][0]
    expect(payload.projectId).toBe('proj-1')
  })

  it('leaves projectId undefined when not supplied', async () => {
    await logAuditAction({
      organizationId: 'org-1',
      entityType: 'funder',
      entityId: 'funder-1',
      action: AUDIT_ACTIONS.FUNDER_CREATED,
      afterJson: {},
    })

    const payload = mockInsertValues.mock.calls[0][0]
    expect(payload.projectId).toBeUndefined()
  })

  it('fails closed when contentModifying is set but beforeJson is missing', async () => {
    await expect(
      logAuditAction({
        entityType: 'sroi_run_review',
        entityId: 'review-1',
        action: AUDIT_ACTIONS.SROI_RUN_REVIEW_UPDATED,
        contentModifying: true,
        afterJson: { status: 'approved' },
      }),
    ).rejects.toThrow(AuditContractViolationError)

    expect(mockDbInsert).not.toHaveBeenCalled()
  })

  it('accepts a contentModifying transition once beforeJson is supplied', async () => {
    await logAuditAction({
      entityType: 'sroi_run_review',
      entityId: 'review-1',
      action: AUDIT_ACTIONS.SROI_RUN_REVIEW_UPDATED,
      contentModifying: true,
      beforeJson: { status: 'pending' },
      afterJson: { status: 'approved' },
    })

    expect(mockDbInsert).toHaveBeenCalledTimes(1)
  })
})

describe('recordAuditCorrection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInsertValues.mockResolvedValue([])
    mockDbInsert.mockReturnValue({ values: mockInsertValues })
  })

  it('inserts a NEW row referencing the original event, never an update', async () => {
    await recordAuditCorrection({
      organizationId: 'org-1',
      actorUserId: 'user-1',
      correctedEventId: 'audit-row-original',
      correctedAction: AUDIT_ACTIONS.PROJECT_PAUSED,
      reason: 'Original event used a bare verb with no object correspondence',
    })

    expect(mockDbInsert).toHaveBeenCalledTimes(1)
    const payload = mockInsertValues.mock.calls[0][0]
    expect(payload.entityType).toBe('audit_log_entry')
    expect(payload.entityId).toBe('audit-row-original')
    expect(payload.action).toBe(AUDIT_ACTIONS.AUDIT_CORRECTION_RECORDED)
    expect(payload.afterJson).toEqual(
      expect.objectContaining({
        correctedEventId: 'audit-row-original',
        correctedAction: AUDIT_ACTIONS.PROJECT_PAUSED,
      }),
    )
  })

  it('requires a reason and a correctedEventId', async () => {
    await expect(
      recordAuditCorrection({
        correctedEventId: '',
        reason: 'x',
      } as Parameters<typeof recordAuditCorrection>[0]),
    ).rejects.toThrow(AuditContractViolationError)
  })
})
