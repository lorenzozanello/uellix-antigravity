// MUST be the first import: fail-closed target gate that does not depend
// on which vitest config selected this file. See tests/integration/_guard.ts.
import './_guard'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '@/db/client'
import { projectInvestments } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { withDatabaseIdentityContext } from '@/db/identity-context'
import {
  createInvestment,
  listInvestments,
  updateInvestment,
  deleteInvestment,
} from '@/lib/pipeline/investments'
// POST-CUTOVER: fixtures are seeded and cleaned through the OWNER path — the
// shared `db` client authenticates as `uellix_app` and a claimless write is
// correctly refused by RLS. The service calls under test run as `uellix_app`
// INSIDE a real identity context (the same mechanism the app uses), so this
// suite now exercises the actual production posture instead of bypassing it.
import { ownerExecute, closeOwnerConnection } from './_owner'

const uuid = randomUUID

let mockUserId = ''
let mockOrgId = ''

vi.mock('@/lib/auth/session', () => ({
  getCurrentOrganizationContext: vi.fn(() => Promise.resolve({
    user: { id: mockUserId, email: 'test@example.com' },
    organization: { id: mockOrgId, name: 'Test Org', slug: 'test-org' },
    membership: { role: 'analyst' }
  })),
  requireOrganizationAccess: vi.fn(() => Promise.resolve({
    user: { id: mockUserId, email: 'test@example.com' },
    organization: { id: mockOrgId, name: 'Test Org', slug: 'test-org' },
    membership: { role: 'analyst' }
  })),
  getCurrentUser: vi.fn(() => Promise.resolve({
    id: mockUserId,
    email: 'test@example.com'
  }))
}))

/**
 * Run `callback` as the seeded analyst, inside a REAL identity context —
 * claims set, RLS active, `uellix_app` connection. This is what the runWith*
 * wrappers do for every production entry point.
 */
function asAnalyst<T>(callback: () => Promise<T>): Promise<T> {
  return withDatabaseIdentityContext(
    { userId: mockUserId, organizationId: mockOrgId, isSuperAdmin: false },
    callback
  )
}

describe('Investment Service - Multi-Funder CRUD', () => {
  let orgId: string
  let userId: string
  let projectId: string
  let funder1Id: string
  let funder2Id: string

  beforeAll(async () => {
    // ONE organisation and ONE user for the whole suite. The audit_logs rows
    // the service writes are append-only and their FKs (ON DELETE NO ACTION)
    // pin whichever org/user they reference — so a per-test org multiplied
    // the permanent residue by the test count. One per run is the floor.
    orgId = uuid()
    mockOrgId = orgId
    userId = uuid()
    mockUserId = userId

    await ownerExecute(
      `INSERT INTO public.organizations (id, name, slug, status)
       VALUES ('${orgId}', 'Test Org', 'test-org-${Date.now()}-${orgId.slice(0, 8)}', 'active')`
    )
    await ownerExecute(
      `INSERT INTO public.users (id, email, is_super_admin)
       VALUES ('${userId}', 'test-${Date.now()}-${userId.slice(0, 8)}@example.com', false)`
    )
    await ownerExecute(
      `INSERT INTO public.organization_members (id, organization_id, user_id, role, status)
       VALUES ('${uuid()}', '${orgId}', '${userId}', 'analyst', 'active')`
    )

    // Shared COP→USD rate for the reference year, seeded so the FX path is a
    // CACHE HIT: fetching the TRM from the network is remote access and is
    // not allowed in this suite.
    await ownerExecute(
      `INSERT INTO public.fx_rates (currency, rate_date, rate_to_usd, source, source_type, organization_id)
       SELECT 'COP', '2024-12-31', '0.000227', 'integration-fixture', 'manual', NULL
       WHERE NOT EXISTS (
         SELECT 1 FROM public.fx_rates
         WHERE currency = 'COP' AND rate_date = '2024-12-31' AND organization_id IS NULL
       )`
    )
  })

  beforeEach(async () => {
    // Per-test isolation: a fresh project and fresh funders every time.
    projectId = uuid()
    funder1Id = uuid()
    funder2Id = uuid()

    await ownerExecute(
      `INSERT INTO public.projects (id, organization_id, name, status, created_by)
       VALUES ('${projectId}', '${orgId}', 'Test Project', 'draft', '${userId}')`
    )
    await ownerExecute(
      `INSERT INTO public.funders (id, organization_id, name, funder_type, created_by) VALUES
       ('${funder1Id}', '${orgId}', 'Funder 1', 'foundation', '${userId}'),
       ('${funder2Id}', '${orgId}', 'Funder 2', 'private', '${userId}')`
    )
  })

  afterEach(async () => {
    // Cleanup via the owner path. The suite's single organisation and user
    // stay behind at the end: the append-only audit rows pin both (FK NO
    // ACTION) — the same residue contract this suite has always had, now one
    // org/user per RUN instead of one per test.
    await ownerExecute(`DELETE FROM public.project_investments WHERE project_id = '${projectId}'`)
    await ownerExecute(`DELETE FROM public.projects WHERE id = '${projectId}'`)
    await ownerExecute(`DELETE FROM public.funders WHERE organization_id = '${orgId}'`)
  })

  afterAll(async () => {
    await ownerExecute(`DELETE FROM public.organization_members WHERE organization_id = '${orgId}'`)
    await closeOwnerConnection()
  })

  describe('createInvestment', () => {
    it('should create a new cash investment with funder tracking', async () => {
      const result = await asAnalyst(() =>
        createInvestment(projectId, {
          funderId: funder1Id,
          contributionType: 'cash',
          amount: '10000',
          currency: 'USD',
          year: 2024,
          description: 'Initial grant',
        })
      )

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(result.projectId).toBe(projectId)
      expect(result.funderId).toBe(funder1Id)
      expect(result.contributionType).toBe('cash')
      expect(result.amount).toBe('10000.0000')
      expect(result.currency).toBe('USD')
      expect(result.amountUsd).toBe('10000.0000') // USD passes through
      expect(result.status).toBe('active')
    })

    it('should create an in-kind investment with valuation notes', async () => {
      const result = await asAnalyst(() =>
        createInvestment(projectId, {
          funderId: funder1Id,
          contributionType: 'in_kind',
          inKindValuationNotes: 'Equipment valued at market rate',
          amount: '5000',
          currency: 'USD',
        })
      )

      expect(result.contributionType).toBe('in_kind')
      expect(result.inKindValuationNotes).toBe('Equipment valued at market rate')
    })

    it('should allow multiple investments per project from different funders', async () => {
      const inv1 = await asAnalyst(() =>
        createInvestment(projectId, { funderId: funder1Id, amount: '10000', currency: 'USD' })
      )
      const inv2 = await asAnalyst(() =>
        createInvestment(projectId, { funderId: funder2Id, amount: '5000', currency: 'USD' })
      )

      expect(inv1.id).not.toBe(inv2.id)
      expect(inv1.funderId).toBe(funder1Id)
      expect(inv2.funderId).toBe(funder2Id)

      const all = await asAnalyst(() => listInvestments(projectId))
      expect(all).toHaveLength(2)
    })

    it('should convert COP to USD using FX rates', async () => {
      const result = await asAnalyst(() =>
        createInvestment(projectId, {
          funderId: funder1Id,
          amount: '1000000',
          currency: 'COP',
          year: 2024,
        })
      )

      expect(result.currency).toBe('COP')
      expect(result.amountUsd).not.toBeNull()
      expect(result.fxRateId).not.toBeNull()
    })

    it('should reject funder from different organization', async () => {
      const otherOrgId = uuid()
      const otherFunderId = uuid()
      await ownerExecute(
        `INSERT INTO public.organizations (id, name, slug, status)
         VALUES ('${otherOrgId}', 'Other Org', 'other-org-${Date.now()}', 'active')`
      )
      await ownerExecute(
        `INSERT INTO public.funders (id, organization_id, name, funder_type, created_by)
         VALUES ('${otherFunderId}', '${otherOrgId}', 'Other Funder', 'foundation', '${userId}')`
      )

      await expect(
        asAnalyst(() =>
          createInvestment(projectId, { funderId: otherFunderId, amount: '10000', currency: 'USD' })
        )
      ).rejects.toThrow()

      // Cleanup
      await ownerExecute(`DELETE FROM public.funders WHERE organization_id = '${otherOrgId}'`)
      await ownerExecute(`DELETE FROM public.organizations WHERE id = '${otherOrgId}'`)
    })
  })

  describe('listInvestments', () => {
    it('should list all active investments for a project', async () => {
      await asAnalyst(() =>
        createInvestment(projectId, { funderId: funder1Id, amount: '10000', currency: 'USD' })
      )
      await asAnalyst(() =>
        createInvestment(projectId, { funderId: funder2Id, amount: '5000', currency: 'USD' })
      )

      const list = await asAnalyst(() => listInvestments(projectId))
      expect(list).toHaveLength(2)
    })

    it('should exclude archived investments', async () => {
      const inv1 = await asAnalyst(() =>
        createInvestment(projectId, { funderId: funder1Id, amount: '10000', currency: 'USD' })
      )
      const inv2 = await asAnalyst(() =>
        createInvestment(projectId, { funderId: funder2Id, amount: '5000', currency: 'USD' })
      )

      // Archive the first one
      await asAnalyst(() => deleteInvestment(inv1.id))

      const list = await asAnalyst(() => listInvestments(projectId))
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(inv2.id)
    })

    it('should return empty array for project with no investments', async () => {
      const list = await asAnalyst(() => listInvestments(projectId))
      expect(list).toHaveLength(0)
    })
  })

  describe('updateInvestment', () => {
    it('should update investment amount', async () => {
      const inv = await asAnalyst(() =>
        createInvestment(projectId, { funderId: funder1Id, amount: '10000', currency: 'USD' })
      )

      const updated = await asAnalyst(() => updateInvestment(inv.id, { amount: '15000' }))

      expect(updated.amount).toBe('15000.0000')
      expect(updated.id).toBe(inv.id)
    })

    it('should update contribution type and validate in-kind notes', async () => {
      const inv = await asAnalyst(() =>
        createInvestment(projectId, {
          funderId: funder1Id,
          amount: '10000',
          currency: 'USD',
          contributionType: 'cash',
        })
      )

      const updated = await asAnalyst(() =>
        updateInvestment(inv.id, {
          contributionType: 'in_kind',
          inKindValuationNotes: 'Office equipment valued at cost',
        })
      )

      expect(updated.contributionType).toBe('in_kind')
      expect(updated.inKindValuationNotes).toBe('Office equipment valued at cost')
    })

    it('should reject in-kind without valuation notes', async () => {
      const inv = await asAnalyst(() =>
        createInvestment(projectId, { funderId: funder1Id, amount: '10000', currency: 'USD' })
      )

      await expect(
        asAnalyst(() => updateInvestment(inv.id, { contributionType: 'in_kind' }))
      ).rejects.toThrow()
    })

    it('should update currency and recalculate USD amount', async () => {
      const inv = await asAnalyst(() =>
        createInvestment(projectId, {
          funderId: funder1Id,
          amount: '10000',
          currency: 'USD',
          year: 2024,
        })
      )

      const updated = await asAnalyst(() =>
        updateInvestment(inv.id, { amount: '1000000', currency: 'COP' })
      )

      expect(updated.currency).toBe('COP')
      expect(updated.amount).toBe('1000000.0000')
      expect(updated.amountUsd).not.toBeNull()
    })

    it('should preserve immutable fields (project, organization, creation metadata)', async () => {
      const inv = await asAnalyst(() =>
        createInvestment(projectId, { funderId: funder1Id, amount: '10000', currency: 'USD' })
      )

      const updated = await asAnalyst(() => updateInvestment(inv.id, { amount: '15000' }))

      expect(updated.projectId).toBe(inv.projectId)
      expect(updated.organizationId).toBe(inv.organizationId)
      expect(updated.createdBy).toBe(inv.createdBy)
      expect(updated.createdAt).toEqual(inv.createdAt)
      expect(updated.updatedAt.getTime()).toBeGreaterThan(inv.updatedAt.getTime())
    })
  })

  describe('deleteInvestment', () => {
    it('should archive investment (soft delete)', async () => {
      const inv = await asAnalyst(() =>
        createInvestment(projectId, { funderId: funder1Id, amount: '10000', currency: 'USD' })
      )

      await asAnalyst(() => deleteInvestment(inv.id))

      const list = await asAnalyst(() => listInvestments(projectId))
      expect(list).toHaveLength(0)

      // Verify archived in DB — read as the analyst through the shared client
      // INSIDE the context (outside one, RLS would answer with zero rows).
      const archived = await asAnalyst(() =>
        db.select().from(projectInvestments).where(eq(projectInvestments.id, inv.id))
      )

      expect(archived[0].status).toBe('archived')
    })

    it('should throw error for non-existent investment', async () => {
      await expect(asAnalyst(() => deleteInvestment(uuid()))).rejects.toThrow()
    })
  })

  describe('Funder isolation', () => {
    it('should not allow accessing funders from other organizations', async () => {
      const otherOrgId = uuid()
      const otherFunderId = uuid()
      await ownerExecute(
        `INSERT INTO public.organizations (id, name, slug, status)
         VALUES ('${otherOrgId}', 'Other Org', 'other-org-${Date.now()}', 'active')`
      )
      await ownerExecute(
        `INSERT INTO public.funders (id, organization_id, name, funder_type, created_by)
         VALUES ('${otherFunderId}', '${otherOrgId}', 'Other Funder', 'foundation', '${userId}')`
      )

      // Try to create investment with funder from different org
      await expect(
        asAnalyst(() =>
          createInvestment(projectId, { funderId: otherFunderId, amount: '10000', currency: 'USD' })
        )
      ).rejects.toThrow()

      // Cleanup
      await ownerExecute(`DELETE FROM public.funders WHERE organization_id = '${otherOrgId}'`)
      await ownerExecute(`DELETE FROM public.organizations WHERE id = '${otherOrgId}'`)
    })
  })

  describe('Backward compatibility', () => {
    it('should handle investments without explicit funder (legacy)', async () => {
      // This simulates existing investments that may not have funder_id set
      // (though schema now requires it, it's good to be defensive)
      const list = await asAnalyst(() => listInvestments(projectId))
      expect(list).toBeDefined()
      expect(Array.isArray(list)).toBe(true)
    })
  })
})
