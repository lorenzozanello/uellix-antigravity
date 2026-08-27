/* eslint-disable @typescript-eslint/no-explicit-any */
// R2-CL2 — deterministic, no-database reproduction of the approval/edit race.
// The test double models the database boundary's two relevant guarantees:
// a transaction serializes FOR UPDATE owners, while a non-transactional write
// can still commit against the latest row after having read an older one.
import { beforeEach, describe, expect, it, vi } from 'vitest'

type ProxyRow = {
  id: string
  organizationId: string | null
  reviewStatus: 'suggested' | 'pending_review' | 'approved' | 'rejected' | 'archived'
  value: string
  currency: string
  unit: string
  referenceYear: number
  valueUsd: string | null
  fxRateId: string | null
}

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolvePromise = res
  })
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
  }
}

async function advanceMicrotasks(turns = 8) {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve()
  }
}

const mocks = vi.hoisted(() => {
  function createDeferred<T = void>() {
    let resolvePromise!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>((res) => {
      resolvePromise = res
    })
    return {
      promise,
      resolve: (value?: T) => resolvePromise(value as T),
    }
  }

  const state = {
    current: null as any,
    pauseApprovalCommit: false,
    approvalCommitEntered: null as ReturnType<typeof createDeferred> | null,
    releaseApprovalCommit: null as ReturnType<typeof createDeferred> | null,
    transactionTail: Promise.resolve(),
  }
  const apply = (values: Record<string, unknown>) => {
    if (!state.current) return []
    Object.assign(state.current, values)
    return [state.current]
  }
  const db: any = {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const query: any = {
          where: vi.fn(() => query),
          for: vi.fn(() => query),
          then: (callback: (rows: any[]) => unknown) => Promise.resolve(callback(state.current ? [state.current] : [])),
        }
        return query
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            if (state.pauseApprovalCommit && values.reviewStatus === 'approved') {
              state.approvalCommitEntered?.resolve()
              await state.releaseApprovalCommit?.promise
            }
            return apply(values)
          }),
        })),
      })),
    })),
  }
  db.transaction = vi.fn(async (callback: (tx: typeof db) => Promise<unknown>) => {
    const previous = state.transactionTail
    const release = createDeferred()
    state.transactionTail = release.promise
    await previous
    try {
      return await callback(db)
    } finally {
      release.resolve()
    }
  })
  return { state, database: db }
})

const state = mocks.state as {
  current: ProxyRow | null
  pauseApprovalCommit: boolean
  approvalCommitEntered: ReturnType<typeof deferred> | null
  releaseApprovalCommit: ReturnType<typeof deferred> | null
  transactionTail: Promise<void>
}
const database = mocks.database

vi.mock('@/db/client', () => ({ db: mocks.database }))
vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: vi.fn(),
  requireAdminAccess: vi.fn(),
  getCurrentOrganizationContext: vi.fn(),
}))
vi.mock('@/lib/auth/permissions', () => ({ canApproveProxy: vi.fn() }))
vi.mock('@/lib/audit/logger', () => ({
  logAuditAction: vi.fn(),
  AUDIT_ACTIONS: {
    FINANCIAL_PROXY_REVIEW_STATUS_CHANGED: 'financial_proxy_review_status_changed',
    FINANCIAL_PROXY_UPDATED: 'financial_proxy_updated',
    ORGANIZATION_UPDATED: 'organization_updated',
  },
}))

import { requireAdminAccess, requireOrganizationAccess } from '@/lib/auth/session'
import { canApproveProxy } from '@/lib/auth/permissions'
import {
  updateFinancialProxyReviewStatus,
  updateOrganizationFinancialProxy,
} from '@/lib/pipeline/proxies'
import { updateGlobalProxyReviewStatus } from '@/lib/admin/proxies'

const PROXY_ID = '550e8400-e29b-41d4-a716-446655440099'
const ORGANIZATION = { id: 'org-race' }

function seedProxy(overrides: Partial<ProxyRow> = {}) {
  state.current = {
    id: PROXY_ID,
    organizationId: ORGANIZATION.id,
    reviewStatus: 'suggested',
    value: '100',
    currency: 'USD',
    unit: 'person',
    referenceYear: 2025,
    valueUsd: null,
    fxRateId: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.pauseApprovalCommit = false
  state.approvalCommitEntered = null
  state.releaseApprovalCommit = null
  state.transactionTail = Promise.resolve()
  seedProxy()
  vi.mocked(requireOrganizationAccess).mockResolvedValue({
    organization: ORGANIZATION,
    user: { id: 'reviewer-race' },
    membership: { role: 'organization_admin' },
  } as any)
  vi.mocked(requireAdminAccess).mockResolvedValue({ id: 'super-admin-race', isSuperAdmin: true } as any)
  vi.mocked(canApproveProxy).mockReturnValue(true)
})

describe('R2-CL2 — concurrency-safe proxy approval lifecycle', () => {
  it('keeps V2 pending and invalidated when a material edit wins over a stale approval read', async () => {
    // Break caught: an approval that is not guarded by the same row lock as a
    // material edit writes V1-derived approval fields over the current V2 row.
    state.pauseApprovalCommit = true
    state.approvalCommitEntered = deferred()
    state.releaseApprovalCommit = deferred()

    const approval = updateFinancialProxyReviewStatus(PROXY_ID, 'approved')
    await state.approvalCommitEntered.promise

    const edit = updateOrganizationFinancialProxy(PROXY_ID, { value: '200' })
    // R1 reaches and commits the material write while approval is paused. In
    // R2 the edit waits behind the approval's row lock; either serialization
    // order is safe once both operations use the same transaction discipline.
    await advanceMicrotasks()
    state.releaseApprovalCommit.resolve()
    await Promise.all([approval, edit])

    expect(state.current).toMatchObject({
      value: '200',
      reviewStatus: 'pending_review',
      valueUsd: null,
      fxRateId: null,
    })
  })

  it('makes system/admin approval derive from the current row after a locked material writer commits', async () => {
    // Break caught: an admin approval path that bypasses the row lock can read
    // V1 and approve V2 with the stale V1 USD value after another writer wins.
    seedProxy({ organizationId: null })
    state.pauseApprovalCommit = true
    state.approvalCommitEntered = deferred()
    state.releaseApprovalCommit = deferred()

    const approval = updateGlobalProxyReviewStatus(PROXY_ID, 'approved')
    await state.approvalCommitEntered.promise

    const materialWriter = database.transaction(async (tx: typeof database) => {
      await tx.select().from({}).where({}).for('update').then((rows: ProxyRow[]) => rows[0])
      await tx.update({}).set({
        value: '200',
        reviewStatus: 'pending_review',
        valueUsd: null,
        fxRateId: null,
      }).where({}).returning()
    })
    await advanceMicrotasks()
    state.releaseApprovalCommit.resolve()
    await Promise.all([approval, materialWriter])

    expect(state.current).toMatchObject({
      value: '200',
      reviewStatus: 'pending_review',
      valueUsd: null,
      fxRateId: null,
    })
  })
})
