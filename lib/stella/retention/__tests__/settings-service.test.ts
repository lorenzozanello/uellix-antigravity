// lib/stella/retention/__tests__/settings-service.test.ts
// Etapa A2.4 (DR-004 aprobado) — no real DB, no real auth.

import { describe, it, expect, vi, beforeEach } from 'vitest'

function makeSelectChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(resolvedValue))
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolvedValue).then(resolve)
  return chain
}
function makeInsertChain() {
  const chain: Record<string, unknown> = {}
  chain.values = vi.fn().mockReturnValue(chain)
  chain.onConflictDoUpdate = vi.fn().mockImplementation(() => Promise.resolve(undefined))
  return chain
}

const mockSelect = vi.fn()
const mockInsert = vi.fn()
vi.mock('@/db/client', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
  },
}))

const mockLogAuditAction = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/audit/logger')>()
  return { ...original, logAuditAction: (...args: unknown[]) => mockLogAuditAction(...args) }
})

import { getEffectiveRetentionSettings, updateOrganizationRetentionSettings, previewRetentionSettingsImpact } from '../settings-service'
import { CURRENT_STELLA_RETENTION_POLICY } from '../policy'

describe('getEffectiveRetentionSettings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the global default when no override row exists', async () => {
    mockSelect.mockReturnValueOnce(makeSelectChain([]))
    const result = await getEffectiveRetentionSettings('org-1')
    expect(result).toEqual({
      organizationId: 'org-1',
      responseRetentionMonths: CURRENT_STELLA_RETENTION_POLICY.defaultResponseRetentionMonths,
      policyVersion: CURRENT_STELLA_RETENTION_POLICY.policyVersion,
      configuredBy: null,
      configuredAt: null,
      isDefault: true,
    })
  })

  it('returns the organization override when a row exists', async () => {
    const configuredAt = new Date('2026-01-01')
    mockSelect.mockReturnValueOnce(makeSelectChain([{ responseRetentionMonths: 12, policyVersion: 'v1', configuredBy: 'user-1', configuredAt }]))
    const result = await getEffectiveRetentionSettings('org-1')
    expect(result).toEqual({
      organizationId: 'org-1',
      responseRetentionMonths: 12,
      policyVersion: 'v1',
      configuredBy: 'user-1',
      configuredAt,
      isDefault: false,
    })
  })
})

describe('updateOrganizationRetentionSettings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a non-organization_admin role before touching the database', async () => {
    const result = await updateOrganizationRetentionSettings({ organizationId: 'org-1', responseRetentionMonths: 12, configuredByUserId: 'user-1' }, 'analyst')
    expect(result).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('rejects 0 months', async () => {
    const result = await updateOrganizationRetentionSettings({ organizationId: 'org-1', responseRetentionMonths: 0, configuredByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'INVALID_MONTHS' })
  })

  it('rejects a negative value', async () => {
    const result = await updateOrganizationRetentionSettings({ organizationId: 'org-1', responseRetentionMonths: -5, configuredByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'INVALID_MONTHS' })
  })

  it('rejects a value beyond the policy maximum', async () => {
    const result = await updateOrganizationRetentionSettings({ organizationId: 'org-1', responseRetentionMonths: 61, configuredByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'INVALID_MONTHS' })
  })

  it('rejects a non-integer value', async () => {
    const result = await updateOrganizationRetentionSettings({ organizationId: 'org-1', responseRetentionMonths: 12.5, configuredByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: false, error: 'INVALID_MONTHS' })
  })

  it('accepts a valid value, upserts, and logs an audit entry', async () => {
    mockInsert.mockReturnValueOnce(makeInsertChain())
    const result = await updateOrganizationRetentionSettings({ organizationId: 'org-1', responseRetentionMonths: 18, configuredByUserId: 'user-1' }, 'organization_admin')
    expect(result).toEqual({ ok: true })
    expect(mockLogAuditAction).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'org-1', afterJson: expect.objectContaining({ responseRetentionMonths: 18 }) }),
    )
  })

  it('accepts the policy boundary values (min and max)', async () => {
    mockInsert.mockReturnValue(makeInsertChain())
    const min = await updateOrganizationRetentionSettings({ organizationId: 'org-1', responseRetentionMonths: CURRENT_STELLA_RETENTION_POLICY.minResponseRetentionMonths, configuredByUserId: 'user-1' }, 'organization_admin')
    const max = await updateOrganizationRetentionSettings({ organizationId: 'org-1', responseRetentionMonths: CURRENT_STELLA_RETENTION_POLICY.maxResponseRetentionMonths, configuredByUserId: 'user-1' }, 'organization_admin')
    expect(min.ok).toBe(true)
    expect(max.ok).toBe(true)
  })
})

describe('previewRetentionSettingsImpact', () => {
  beforeEach(() => vi.clearAllMocks())

  it('never mutates anything — read-only count query', async () => {
    mockSelect.mockReturnValueOnce(makeSelectChain([{ value: 3 }]))
    const result = await previewRetentionSettingsImpact('org-1', 12, new Date('2026-07-26'))
    expect(result).toEqual({ newlyEligibleCount: 3 })
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('returns 0 when the count query yields no row', async () => {
    mockSelect.mockReturnValueOnce(makeSelectChain([]))
    const result = await previewRetentionSettingsImpact('org-1', 12, new Date('2026-07-26'))
    expect(result).toEqual({ newlyEligibleCount: 0 })
  })
})
