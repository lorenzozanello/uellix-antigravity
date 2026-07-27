// lib/stella/retention/__tests__/hold-service.test.ts
// Etapa A2.4 (DR-004 aprobado) — no real DB, no real auth. Role check (exact
// match, no super_admin bypass), fixed-vocabulary validation, scope
// validation (project/interaction must belong to the organization), and
// transactional audit (logAuditAction called with the SAME tx client used
// for the write — see purge/aggregation-declaration precedent).

import { describe, it, expect, vi, beforeEach } from 'vitest'

function makeInsertChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.values = vi.fn().mockReturnValue(chain)
  chain.returning = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  return chain
}
function makeSelectChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.for = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  // Some queries terminate at .where() without .limit() (e.g. the
  // project/interaction-level hold batch lookups in hold-service.ts) — make
  // the chain itself awaitable so `await ....where(...)` resolves correctly.
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(resolvedValue).then(resolve, reject)
  return chain
}
function makeUpdateChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.set = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  return chain
}

const mockInsert = vi.fn()
const mockSelect = vi.fn()
const mockUpdate = vi.fn()
const txClient = {
  insert: (...args: unknown[]) => mockInsert(...args),
  select: (...args: unknown[]) => mockSelect(...args),
  update: (...args: unknown[]) => mockUpdate(...args),
}
const mockTransaction = vi.fn().mockImplementation((cb: (tx: typeof txClient) => unknown) => cb(txClient))
vi.mock('@/db/client', () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}))

const mockLogAuditAction = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/audit/logger')>()
  return { ...original, logAuditAction: (...args: unknown[]) => mockLogAuditAction(...args) }
})

import {
  createRetentionHold,
  releaseRetentionHold,
  getActiveHoldStatusForInteractions,
} from '../hold-service'

describe('createRetentionHold', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a non-organization_admin role before touching the database', async () => {
    const result = await createRetentionHold(
      { organizationId: 'org-1', holdType: 'legal_hold', reasonCode: 'pending_legal_review', createdByUserId: 'user-1' },
      'analyst',
    )
    expect(result).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('rejects an invalid hold type', async () => {
    const result = await createRetentionHold(
      { organizationId: 'org-1', holdType: 'made_up_type' as never, reasonCode: 'pending_legal_review', createdByUserId: 'user-1' },
      'organization_admin',
    )
    expect(result).toEqual({ ok: false, error: 'INVALID_HOLD_TYPE' })
  })

  it('rejects an invalid reason code', async () => {
    const result = await createRetentionHold(
      { organizationId: 'org-1', holdType: 'legal_hold', reasonCode: 'made_up_reason' as never, createdByUserId: 'user-1' },
      'organization_admin',
    )
    expect(result).toEqual({ ok: false, error: 'INVALID_REASON_CODE' })
  })

  it('rejects a project that does not belong to the organization', async () => {
    mockSelect.mockReturnValueOnce(makeSelectChain([{ id: 'proj-1', organizationId: 'org-OTHER' }]))
    const result = await createRetentionHold(
      { organizationId: 'org-1', projectId: 'proj-1', holdType: 'legal_hold', reasonCode: 'pending_legal_review', createdByUserId: 'user-1' },
      'organization_admin',
    )
    expect(result).toEqual({ ok: false, error: 'PROJECT_ORGANIZATION_MISMATCH' })
  })

  it('rejects a nonexistent project', async () => {
    mockSelect.mockReturnValueOnce(makeSelectChain([]))
    const result = await createRetentionHold(
      { organizationId: 'org-1', projectId: 'proj-missing', holdType: 'legal_hold', reasonCode: 'pending_legal_review', createdByUserId: 'user-1' },
      'organization_admin',
    )
    expect(result).toEqual({ ok: false, error: 'PROJECT_NOT_FOUND' })
  })

  it('rejects an interaction whose organization does not match', async () => {
    mockSelect.mockReturnValueOnce(makeSelectChain([{ id: 'int-1', organizationId: 'org-OTHER', projectId: 'proj-1' }]))
    const result = await createRetentionHold(
      { organizationId: 'org-1', interactionId: 'int-1', holdType: 'legal_hold', reasonCode: 'pending_legal_review', createdByUserId: 'user-1' },
      'organization_admin',
    )
    expect(result).toEqual({ ok: false, error: 'INTERACTION_SCOPE_MISMATCH' })
  })

  it('rejects an interaction whose project does not match the given projectId', async () => {
    mockSelect
      .mockReturnValueOnce(makeSelectChain([{ id: 'proj-1', organizationId: 'org-1' }])) // project check
      .mockReturnValueOnce(makeSelectChain([{ id: 'int-1', organizationId: 'org-1', projectId: 'proj-OTHER' }])) // interaction check
    const result = await createRetentionHold(
      { organizationId: 'org-1', projectId: 'proj-1', interactionId: 'int-1', holdType: 'legal_hold', reasonCode: 'pending_legal_review', createdByUserId: 'user-1' },
      'organization_admin',
    )
    expect(result).toEqual({ ok: false, error: 'INTERACTION_SCOPE_MISMATCH' })
  })

  it('creates an organization-wide hold (no project/interaction) and logs a transactional, content-free audit entry', async () => {
    mockInsert.mockReturnValueOnce(makeInsertChain([{ id: 'hold-1' }]))
    const result = await createRetentionHold(
      { organizationId: 'org-1', holdType: 'legal_hold', reasonCode: 'pending_legal_review', createdByUserId: 'user-1' },
      'organization_admin',
    )
    expect(result).toEqual({ ok: true, id: 'hold-1' })
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(mockLogAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'hold-1', afterJson: expect.objectContaining({ scope: 'organization' }) }),
      txClient,
    )
  })
})

describe('releaseRetentionHold', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a non-organization_admin role', async () => {
    const result = await releaseRetentionHold({ holdId: 'hold-1', organizationId: 'org-1', releasedByUserId: 'user-1' }, 'viewer')
    expect(result).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
  })

  it('returns NOT_FOUND for a hold in a different organization', async () => {
    mockSelect.mockReturnValueOnce(makeSelectChain([{ id: 'hold-1', organizationId: 'org-OTHER', status: 'active' }]))
    const result = await releaseRetentionHold({ holdId: 'hold-1', organizationId: 'org-1', releasedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('returns ALREADY_RELEASED for a hold that is not active', async () => {
    mockSelect.mockReturnValueOnce(makeSelectChain([{ id: 'hold-1', organizationId: 'org-1', status: 'released' }]))
    const result = await releaseRetentionHold({ holdId: 'hold-1', organizationId: 'org-1', releasedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'ALREADY_RELEASED' })
  })

  it('releases an active hold and logs a transactional audit entry', async () => {
    mockSelect.mockReturnValueOnce(makeSelectChain([{ id: 'hold-1', organizationId: 'org-1', status: 'active' }]))
    mockUpdate.mockReturnValueOnce(makeUpdateChain(undefined))
    const result = await releaseRetentionHold({ holdId: 'hold-1', organizationId: 'org-1', releasedByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: true })
    expect(mockLogAuditAction).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'hold-1' }), txClient)
  })
})

describe('getActiveHoldStatusForInteractions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns an empty map without querying when given zero interactions', async () => {
    const result = await getActiveHoldStatusForInteractions({ organizationId: 'org-1', interactions: [] })
    expect(result.size).toBe(0)
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('defaults every interaction to "none" when no hold matches', async () => {
    mockSelect
      .mockReturnValueOnce(makeSelectChain([])) // org-wide check
      .mockReturnValueOnce(makeSelectChain([])) // project-level check
      .mockReturnValueOnce(makeSelectChain([])) // interaction-level check
    const result = await getActiveHoldStatusForInteractions({
      organizationId: 'org-1',
      interactions: [{ id: 'int-1', projectId: 'proj-1' }],
    })
    expect(result.get('int-1')).toBe('none')
  })

  it('an organization-wide hold marks EVERY interaction in the batch as active, without further queries', async () => {
    mockSelect.mockReturnValueOnce(makeSelectChain([{ id: 'hold-org' }])) // org-wide check finds one
    const result = await getActiveHoldStatusForInteractions({
      organizationId: 'org-1',
      interactions: [{ id: 'int-1', projectId: 'proj-1' }, { id: 'int-2', projectId: 'proj-2' }],
    })
    expect(result.get('int-1')).toBe('active')
    expect(result.get('int-2')).toBe('active')
    expect(mockSelect).toHaveBeenCalledTimes(1) // short-circuits — no project/interaction-level queries needed
  })

  it('a project-level hold marks only interactions in that project as active', async () => {
    mockSelect
      .mockReturnValueOnce(makeSelectChain([])) // org-wide: none
      .mockReturnValueOnce(makeSelectChain([{ projectId: 'proj-1' }])) // project-level: proj-1 held
      .mockReturnValueOnce(makeSelectChain([])) // interaction-level: none
    const result = await getActiveHoldStatusForInteractions({
      organizationId: 'org-1',
      interactions: [{ id: 'int-1', projectId: 'proj-1' }, { id: 'int-2', projectId: 'proj-2' }],
    })
    expect(result.get('int-1')).toBe('active')
    expect(result.get('int-2')).toBe('none')
  })

  it('an interaction-level hold marks only that exact interaction as active', async () => {
    mockSelect
      .mockReturnValueOnce(makeSelectChain([])) // org-wide: none
      .mockReturnValueOnce(makeSelectChain([])) // project-level: none
      .mockReturnValueOnce(makeSelectChain([{ interactionId: 'int-2' }])) // interaction-level
    const result = await getActiveHoldStatusForInteractions({
      organizationId: 'org-1',
      interactions: [{ id: 'int-1', projectId: 'proj-1' }, { id: 'int-2', projectId: 'proj-2' }],
    })
    expect(result.get('int-1')).toBe('none')
    expect(result.get('int-2')).toBe('active')
  })
})
