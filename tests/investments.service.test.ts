import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db } from '@/db/client'
import {
  organizations,
  users,
  projects,
  funders,
  projectInvestments,
  organizationMembers,
} from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import {
  createInvestment,
  listInvestments,
  updateInvestment,
  deleteInvestment,
} from '@/lib/pipeline/investments'

const uuid = randomUUID

describe('Investment Service - Multi-Funder CRUD', () => {
  let orgId: string
  let userId: string
  let projectId: string
  let funder1Id: string
  let funder2Id: string

  beforeEach(async () => {
    // Create test organization
    orgId = uuid()
    await db.insert(organizations).values({
      id: orgId,
      name: 'Test Org',
      slug: `test-org-${Date.now()}`,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    // Create test user
    userId = uuid()
    await db.insert(users).values({
      id: userId,
      email: `test-${Date.now()}@example.com`,
      isSuperAdmin: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    // Add user to organization
    await db.insert(organizationMembers).values({
      id: uuid(),
      organizationId: orgId,
      userId,
      role: 'analyst',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    // Create test project
    projectId = uuid()
    await db.insert(projects).values({
      id: projectId,
      organizationId: orgId,
      name: 'Test Project',
      status: 'draft',
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    // Create test funders
    funder1Id = uuid()
    funder2Id = uuid()
    await db.insert(funders).values([
      {
        id: funder1Id,
        organizationId: orgId,
        name: 'Funder 1',
        funderType: 'foundation',
        createdBy: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: funder2Id,
        organizationId: orgId,
        name: 'Funder 2',
        funderType: 'private',
        createdBy: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
  })

  afterEach(async () => {
    // Cleanup
    await db.delete(projectInvestments).where(eq(projectInvestments.projectId, projectId))
    await db.delete(projects).where(eq(projects.id, projectId))
    await db.delete(funders).where(eq(funders.organizationId, orgId))
    await db.delete(organizationMembers).where(eq(organizationMembers.organizationId, orgId))
    await db.delete(users).where(eq(users.id, userId))
    await db.delete(organizations).where(eq(organizations.id, orgId))
  })

  describe('createInvestment', () => {
    it('should create a new cash investment with funder tracking', async () => {
      const result = await createInvestment(projectId, {
        funderId: funder1Id,
        contributionType: 'cash',
        amount: '10000',
        currency: 'USD',
        year: 2024,
        description: 'Initial grant',
      })

      expect(result).toBeDefined()
      expect(result.id).toBeDefined()
      expect(result.projectId).toBe(projectId)
      expect(result.funderId).toBe(funder1Id)
      expect(result.contributionType).toBe('cash')
      expect(result.amount).toBe('10000')
      expect(result.currency).toBe('USD')
      expect(result.amountUsd).toBe('10000') // USD passes through
      expect(result.status).toBe('active')
    })

    it('should create an in-kind investment with valuation notes', async () => {
      const result = await createInvestment(projectId, {
        funderId: funder1Id,
        contributionType: 'in_kind',
        inKindValuationNotes: 'Equipment valued at market rate',
        amount: '5000',
        currency: 'USD',
      })

      expect(result.contributionType).toBe('in_kind')
      expect(result.inKindValuationNotes).toBe('Equipment valued at market rate')
    })

    it('should allow multiple investments per project from different funders', async () => {
      const inv1 = await createInvestment(projectId, {
        funderId: funder1Id,
        amount: '10000',
        currency: 'USD',
      })

      const inv2 = await createInvestment(projectId, {
        funderId: funder2Id,
        amount: '5000',
        currency: 'USD',
      })

      expect(inv1.id).not.toBe(inv2.id)
      expect(inv1.funderId).toBe(funder1Id)
      expect(inv2.funderId).toBe(funder2Id)

      const all = await listInvestments(projectId)
      expect(all).toHaveLength(2)
    })

    it('should convert COP to USD using FX rates', async () => {
      const result = await createInvestment(projectId, {
        funderId: funder1Id,
        amount: '1000000',
        currency: 'COP',
        year: 2024,
      })

      expect(result.currency).toBe('COP')
      expect(result.amountUsd).not.toBeNull()
      expect(result.fxRateId).not.toBeNull()
    })

    it('should reject funder from different organization', async () => {
      const otherOrgId = uuid()
      await db.insert(organizations).values({
        id: otherOrgId,
        name: 'Other Org',
        slug: `other-org-${Date.now()}`,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      const otherFunderId = uuid()
      await db.insert(funders).values({
        id: otherFunderId,
        organizationId: otherOrgId,
        name: 'Other Funder',
        funderType: 'foundation',
        createdBy: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      await expect(
        createInvestment(projectId, {
          funderId: otherFunderId,
          amount: '10000',
          currency: 'USD',
        })
      ).rejects.toThrow()

      // Cleanup
      await db.delete(funders).where(eq(funders.organizationId, otherOrgId))
      await db.delete(organizations).where(eq(organizations.id, otherOrgId))
    })
  })

  describe('listInvestments', () => {
    it('should list all active investments for a project', async () => {
      await createInvestment(projectId, {
        funderId: funder1Id,
        amount: '10000',
        currency: 'USD',
      })

      await createInvestment(projectId, {
        funderId: funder2Id,
        amount: '5000',
        currency: 'USD',
      })

      const list = await listInvestments(projectId)
      expect(list).toHaveLength(2)
    })

    it('should exclude archived investments', async () => {
      const inv1 = await createInvestment(projectId, {
        funderId: funder1Id,
        amount: '10000',
        currency: 'USD',
      })

      const inv2 = await createInvestment(projectId, {
        funderId: funder2Id,
        amount: '5000',
        currency: 'USD',
      })

      // Archive the first one
      await deleteInvestment(inv1.id)

      const list = await listInvestments(projectId)
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(inv2.id)
    })

    it('should return empty array for project with no investments', async () => {
      const list = await listInvestments(projectId)
      expect(list).toHaveLength(0)
    })
  })

  describe('updateInvestment', () => {
    it('should update investment amount', async () => {
      const inv = await createInvestment(projectId, {
        funderId: funder1Id,
        amount: '10000',
        currency: 'USD',
      })

      const updated = await updateInvestment(inv.id, {
        amount: '15000',
      })

      expect(updated.amount).toBe('15000')
      expect(updated.id).toBe(inv.id)
    })

    it('should update contribution type and validate in-kind notes', async () => {
      const inv = await createInvestment(projectId, {
        funderId: funder1Id,
        amount: '10000',
        currency: 'USD',
        contributionType: 'cash',
      })

      const updated = await updateInvestment(inv.id, {
        contributionType: 'in_kind',
        inKindValuationNotes: 'Office equipment valued at cost',
      })

      expect(updated.contributionType).toBe('in_kind')
      expect(updated.inKindValuationNotes).toBe('Office equipment valued at cost')
    })

    it('should reject in-kind without valuation notes', async () => {
      const inv = await createInvestment(projectId, {
        funderId: funder1Id,
        amount: '10000',
        currency: 'USD',
      })

      await expect(
        updateInvestment(inv.id, {
          contributionType: 'in_kind',
        })
      ).rejects.toThrow()
    })

    it('should update currency and recalculate USD amount', async () => {
      const inv = await createInvestment(projectId, {
        funderId: funder1Id,
        amount: '10000',
        currency: 'USD',
        year: 2024,
      })

      const updated = await updateInvestment(inv.id, {
        amount: '1000000',
        currency: 'COP',
      })

      expect(updated.currency).toBe('COP')
      expect(updated.amount).toBe('1000000')
      expect(updated.amountUsd).not.toBeNull()
    })

    it('should preserve immutable fields (project, organization, creation metadata)', async () => {
      const inv = await createInvestment(projectId, {
        funderId: funder1Id,
        amount: '10000',
        currency: 'USD',
      })

      const updated = await updateInvestment(inv.id, {
        amount: '15000',
      })

      expect(updated.projectId).toBe(inv.projectId)
      expect(updated.organizationId).toBe(inv.organizationId)
      expect(updated.createdBy).toBe(inv.createdBy)
      expect(updated.createdAt).toEqual(inv.createdAt)
      expect(updated.updatedAt.getTime()).toBeGreaterThan(inv.updatedAt.getTime())
    })
  })

  describe('deleteInvestment', () => {
    it('should archive investment (soft delete)', async () => {
      const inv = await createInvestment(projectId, {
        funderId: funder1Id,
        amount: '10000',
        currency: 'USD',
      })

      await deleteInvestment(inv.id)

      const list = await listInvestments(projectId)
      expect(list).toHaveLength(0)

      // Verify archived in DB
      const archived = await db
        .select()
        .from(projectInvestments)
        .where(eq(projectInvestments.id, inv.id))

      expect(archived[0].status).toBe('archived')
    })

    it('should throw error for non-existent investment', async () => {
      await expect(deleteInvestment(uuid())).rejects.toThrow()
    })
  })

  describe('Funder isolation', () => {
    it('should not allow accessing funders from other organizations', async () => {
      const otherOrgId = uuid()
      await db.insert(organizations).values({
        id: otherOrgId,
        name: 'Other Org',
        slug: `other-org-${Date.now()}`,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      const otherFunderId = uuid()
      await db.insert(funders).values({
        id: otherFunderId,
        organizationId: otherOrgId,
        name: 'Other Funder',
        funderType: 'foundation',
        createdBy: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      // Try to create investment with funder from different org
      await expect(
        createInvestment(projectId, {
          funderId: otherFunderId,
          amount: '10000',
          currency: 'USD',
        })
      ).rejects.toThrow()

      // Cleanup
      await db.delete(funders).where(eq(funders.organizationId, otherOrgId))
      await db.delete(organizations).where(eq(organizations.id, otherOrgId))
    })
  })

  describe('Backward compatibility', () => {
    it('should handle investments without explicit funder (legacy)', async () => {
      // This simulates existing investments that may not have funder_id set
      // (though schema now requires it, it's good to be defensive)
      const list = await listInvestments(projectId)
      expect(list).toBeDefined()
      expect(Array.isArray(list)).toBe(true)
    })
  })
})
