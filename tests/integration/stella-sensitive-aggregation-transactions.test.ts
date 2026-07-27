// tests/integration/stella-sensitive-aggregation-transactions.test.ts
//
// Etapa A2.3.2 (STL-A232-018/019, DR-002/DR-003) — transactional and
// concurrency guarantees of the sensitive-aggregation declaration services,
// against the REAL local Postgres (no mocks): supersede rollback on
// failure, double-revoke/double-verify serialization via row locks, and the
// partial unique index as the concurrent-create backstop.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '@/db/client'
import { organizations, projects, outcomes, stakeholderGroups, stellaSensitiveAggregationDeclarations } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { deleteOrganizationsWithoutAuditTrail } from './cleanup'
import {
  createSensitiveAggregationDeclaration,
  verifySensitiveAggregationDeclaration,
  revokeSensitiveAggregationDeclaration,
  supersedeSensitiveAggregationDeclaration,
} from '@/lib/stella/aggregation/declaration-service'

describe('Sensitive-aggregation declarations — transactions and concurrency (Etapa A2.3.2)', () => {
  let orgId: string
  let projectId: string
  let stakeholderGroupId: string
  let userId: string

  beforeAll(async () => {
    orgId = randomUUID()
    await db.insert(organizations).values({ id: orgId, name: 'SSAD TX Org', slug: `ssad-tx-org-${Date.now()}` })

    const rows = (await db.execute('select id from public.users limit 1')) as unknown as { id: string }[]
    userId = rows[0].id

    projectId = randomUUID()
    await db.insert(projects).values({ id: projectId, organizationId: orgId, name: 'SSAD TX Project', status: 'draft', createdBy: userId })

    stakeholderGroupId = randomUUID()
    await db.insert(stakeholderGroups).values({ id: stakeholderGroupId, projectId, name: 'Test cohort', type: 'community' })
  })

  afterAll(async () => {
    await db.delete(stellaSensitiveAggregationDeclarations).where(eq(stellaSensitiveAggregationDeclarations.projectId, projectId))
    await db.delete(outcomes).where(eq(outcomes.projectId, projectId))
    await db.delete(stakeholderGroups).where(eq(stakeholderGroups.projectId, projectId))
    await db.delete(projects).where(eq(projects.id, projectId))
    await deleteOrganizationsWithoutAuditTrail([orgId])
  })

  async function makeOutcome(title: string) {
    const id = randomUUID()
    await db.insert(outcomes).values({ id, projectId, stakeholderGroupId, title, createdBy: userId })
    return id
  }

  async function declareAndVerify(entityId: string, groupSize: number, category: 'minors' | 'health' = 'minors') {
    const created = await createSensitiveAggregationDeclaration(
      {
        organizationId: orgId,
        projectId,
        entityType: 'outcome',
        entityId,
        sensitiveCategory: category,
        groupSize,
        dimensions: [],
        countSourceType: 'indicator_measurement',
        declaredByUserId: userId,
      },
      'organization_admin',
    )
    if (!created.ok) throw new Error(`setup failed: ${created.error}`)
    const verified = await verifySensitiveAggregationDeclaration({ declarationId: created.id, organizationId: orgId, verifiedByUserId: userId }, 'organization_admin')
    if (!verified.ok) throw new Error(`setup verify failed: ${verified.error}`)
    return created.id
  }

  async function fetchRow(id: string) {
    const [row] = await db.select().from(stellaSensitiveAggregationDeclarations).where(eq(stellaSensitiveAggregationDeclarations.id, id))
    return row
  }

  describe('Supersede — successful transaction', () => {
    it('marks the previous declaration superseded, creates a new pending one, and links both', async () => {
      const outcomeId = await makeOutcome('Supersede success outcome')
      const previousId = await declareAndVerify(outcomeId, 50)

      const result = await supersedeSensitiveAggregationDeclaration(
        previousId,
        {
          organizationId: orgId,
          projectId,
          entityType: 'outcome',
          entityId: outcomeId,
          sensitiveCategory: 'minors',
          groupSize: 80,
          dimensions: [],
          countSourceType: 'indicator_measurement',
          declaredByUserId: userId,
        },
        'organization_admin',
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const previousRow = await fetchRow(previousId)
      const newRow = await fetchRow(result.id)
      expect(previousRow.verificationStatus).toBe('superseded')
      expect(previousRow.supersededByDeclarationId).toBe(result.id)
      expect(newRow.verificationStatus).toBe('pending') // supersede never inherits verified status
      expect(newRow.supersedesDeclarationId).toBe(previousId)
    })
  })

  describe('Supersede — rollback on failure', () => {
    it('rolls back completely when the new declaration would violate the unique-active-declaration index: previous stays verified, no orphaned new row', async () => {
      const outcomeA = await makeOutcome('Rollback outcome A')
      const outcomeB = await makeOutcome('Rollback outcome B')

      const previousId = await declareAndVerify(outcomeA, 50)
      // An unrelated ACTIVE declaration already occupies (outcomeB, minors) —
      // superseding `previousId` (outcomeA) with new input that targets
      // outcomeB/minors must collide with THIS row's unique index entry.
      const occupiedId = await declareAndVerify(outcomeB, 60)

      const beforeCount = (await db.select().from(stellaSensitiveAggregationDeclarations).where(eq(stellaSensitiveAggregationDeclarations.projectId, projectId))).length

      const result = await supersedeSensitiveAggregationDeclaration(
        previousId,
        {
          organizationId: orgId,
          projectId,
          entityType: 'outcome',
          entityId: outcomeB, // collides with `occupiedId`'s active declaration
          sensitiveCategory: 'minors',
          groupSize: 90,
          dimensions: [],
          countSourceType: 'indicator_measurement',
          declaredByUserId: userId,
        },
        'organization_admin',
      )

      expect(result).toEqual({ ok: false, error: 'ACTIVE_DECLARATION_EXISTS' })

      // Rollback proof: `previousId` is STILL verified (never touched), and
      // no new row was created (row count unchanged) — the failed INSERT
      // rolled back the whole transaction, including the UPDATE that would
      // have marked `previousId` as superseded.
      const previousRow = await fetchRow(previousId)
      expect(previousRow.verificationStatus).toBe('verified')
      expect(previousRow.supersededByDeclarationId).toBeNull()

      const occupiedRow = await fetchRow(occupiedId)
      expect(occupiedRow.verificationStatus).toBe('verified') // untouched

      const afterCount = (await db.select().from(stellaSensitiveAggregationDeclarations).where(eq(stellaSensitiveAggregationDeclarations.projectId, projectId))).length
      expect(afterCount).toBe(beforeCount) // no orphaned row left behind
    })

    it('rolls back completely when the new declaration references a nonexistent entity', async () => {
      const outcomeId = await makeOutcome('Rollback entity-not-found outcome')
      const previousId = await declareAndVerify(outcomeId, 50)

      const result = await supersedeSensitiveAggregationDeclaration(
        previousId,
        {
          organizationId: orgId,
          projectId,
          entityType: 'outcome',
          entityId: randomUUID(), // does not exist
          sensitiveCategory: 'minors',
          groupSize: 90,
          dimensions: [],
          countSourceType: 'indicator_measurement',
          declaredByUserId: userId,
        },
        'organization_admin',
      )

      expect(result).toEqual({ ok: false, error: 'ENTITY_NOT_FOUND' })

      const previousRow = await fetchRow(previousId)
      expect(previousRow.verificationStatus).toBe('verified')
      expect(previousRow.supersededByDeclarationId).toBeNull()
    })
  })

  describe('Supersede — rejects an inactive previous declaration', () => {
    it('rejects superseding an already-revoked declaration', async () => {
      const outcomeId = await makeOutcome('Supersede-revoked outcome')
      const previousId = await declareAndVerify(outcomeId, 50)
      await revokeSensitiveAggregationDeclaration({ declarationId: previousId, organizationId: orgId, revokedByUserId: userId, reason: 'test' }, 'organization_admin')

      const result = await supersedeSensitiveAggregationDeclaration(
        previousId,
        {
          organizationId: orgId,
          projectId,
          entityType: 'outcome',
          entityId: outcomeId,
          sensitiveCategory: 'health',
          groupSize: 50,
          dimensions: [],
          countSourceType: 'indicator_measurement',
          declaredByUserId: userId,
        },
        'organization_admin',
      )
      expect(result).toEqual({ ok: false, error: 'PREVIOUS_ALREADY_REVOKED' })
    })

    it('rejects superseding an already-superseded declaration', async () => {
      const outcomeId = await makeOutcome('Supersede-superseded outcome')
      const previousId = await declareAndVerify(outcomeId, 50)
      const first = await supersedeSensitiveAggregationDeclaration(
        previousId,
        { organizationId: orgId, projectId, entityType: 'outcome', entityId: outcomeId, sensitiveCategory: 'minors', groupSize: 60, dimensions: [], countSourceType: 'indicator_measurement', declaredByUserId: userId },
        'organization_admin',
      )
      expect(first.ok).toBe(true)

      const second = await supersedeSensitiveAggregationDeclaration(
        previousId, // superseding the SAME (now-superseded) row again
        { organizationId: orgId, projectId, entityType: 'outcome', entityId: outcomeId, sensitiveCategory: 'minors', groupSize: 70, dimensions: [], countSourceType: 'indicator_measurement', declaredByUserId: userId },
        'organization_admin',
      )
      expect(second).toEqual({ ok: false, error: 'PREVIOUS_ALREADY_SUPERSEDED' })
    })
  })

  describe('Double revocation — controlled', () => {
    it('a second revoke returns ALREADY_REVOKED without changing the row further', async () => {
      const outcomeId = await makeOutcome('Double-revoke outcome')
      const declId = await declareAndVerify(outcomeId, 50)

      const first = await revokeSensitiveAggregationDeclaration({ declarationId: declId, organizationId: orgId, revokedByUserId: userId, reason: 'first' }, 'organization_admin')
      expect(first).toEqual({ ok: true })

      const rowAfterFirst = await fetchRow(declId)

      const second = await revokeSensitiveAggregationDeclaration({ declarationId: declId, organizationId: orgId, revokedByUserId: userId, reason: 'second' }, 'organization_admin')
      expect(second).toEqual({ ok: false, error: 'ALREADY_REVOKED' })

      const rowAfterSecond = await fetchRow(declId)
      expect(rowAfterSecond.revocationReason).toBe(rowAfterFirst.revocationReason) // untouched by the rejected second call
    })
  })

  describe('Concurrency — real Postgres row locking', () => {
    it('two concurrent verifications of the SAME pending declaration: exactly one succeeds, the other sees ALREADY_VERIFIED', async () => {
      const outcomeId = await makeOutcome('Concurrent double-verify outcome')
      const created = await createSensitiveAggregationDeclaration(
        { organizationId: orgId, projectId, entityType: 'outcome', entityId: outcomeId, sensitiveCategory: 'minors', groupSize: 50, dimensions: [], countSourceType: 'indicator_measurement', declaredByUserId: userId },
        'organization_admin',
      )
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const [resultA, resultB] = await Promise.all([
        verifySensitiveAggregationDeclaration({ declarationId: created.id, organizationId: orgId, verifiedByUserId: userId }, 'organization_admin'),
        verifySensitiveAggregationDeclaration({ declarationId: created.id, organizationId: orgId, verifiedByUserId: userId }, 'organization_admin'),
      ])

      const outcomes_ = [resultA, resultB]
      const succeeded = outcomes_.filter((r) => r.ok)
      const alreadyVerified = outcomes_.filter((r) => !r.ok && r.error === 'ALREADY_VERIFIED')
      expect(succeeded).toHaveLength(1)
      expect(alreadyVerified).toHaveLength(1)

      const finalRow = await fetchRow(created.id)
      expect(finalRow.verificationStatus).toBe('verified')
    })

    it('verify racing revoke on the same pending declaration: no corrupted state, final status is always revoked', async () => {
      const outcomeId = await makeOutcome('Concurrent verify-vs-revoke outcome')
      const created = await createSensitiveAggregationDeclaration(
        { organizationId: orgId, projectId, entityType: 'outcome', entityId: outcomeId, sensitiveCategory: 'minors', groupSize: 50, dimensions: [], countSourceType: 'indicator_measurement', declaredByUserId: userId },
        'organization_admin',
      )
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const [verifyResult, revokeResult] = await Promise.all([
        verifySensitiveAggregationDeclaration({ declarationId: created.id, organizationId: orgId, verifiedByUserId: userId }, 'organization_admin'),
        revokeSensitiveAggregationDeclaration({ declarationId: created.id, organizationId: orgId, revokedByUserId: userId, reason: 'race' }, 'organization_admin'),
      ])

      // revoke is valid from BOTH 'pending' and 'verified' — it always
      // succeeds regardless of race order. verify only succeeds if it wins
      // the lock before the row is revoked.
      expect(revokeResult).toEqual({ ok: true })
      expect(verifyResult.ok === true || (verifyResult.ok === false && verifyResult.error === 'ALREADY_REVOKED')).toBe(true)

      const finalRow = await fetchRow(created.id)
      expect(finalRow.verificationStatus).toBe('revoked') // whichever order, revoke always wins the final state
    })

    it('two concurrent CREATE calls for the same entity+category: exactly one succeeds, the other gets ACTIVE_DECLARATION_EXISTS (unique-index backstop, no row lock possible since no row exists yet)', async () => {
      const outcomeId = await makeOutcome('Concurrent double-create outcome')

      const [resultA, resultB] = await Promise.all([
        createSensitiveAggregationDeclaration(
          { organizationId: orgId, projectId, entityType: 'outcome', entityId: outcomeId, sensitiveCategory: 'minors', groupSize: 30, dimensions: [], countSourceType: 'indicator_measurement', declaredByUserId: userId },
          'organization_admin',
        ),
        createSensitiveAggregationDeclaration(
          { organizationId: orgId, projectId, entityType: 'outcome', entityId: outcomeId, sensitiveCategory: 'minors', groupSize: 40, dimensions: [], countSourceType: 'indicator_measurement', declaredByUserId: userId },
          'organization_admin',
        ),
      ])

      const results = [resultA, resultB]
      const succeeded = results.filter((r) => r.ok)
      const collided = results.filter((r) => !r.ok && r.error === 'ACTIVE_DECLARATION_EXISTS')
      expect(succeeded).toHaveLength(1)
      expect(collided).toHaveLength(1)

      const activeRows = await db
        .select()
        .from(stellaSensitiveAggregationDeclarations)
        .where(eq(stellaSensitiveAggregationDeclarations.entityId, outcomeId))
      const activeCount = activeRows.filter((r) => r.verificationStatus === 'pending' || r.verificationStatus === 'verified').length
      expect(activeCount).toBe(1) // never two active declarations for the same entity+category
    })

    it('supersede racing revoke on the SAME verified declaration: exactly one succeeds, final state is consistent either way', async () => {
      const outcomeId = await makeOutcome('Concurrent supersede-vs-revoke outcome')
      const previousId = await declareAndVerify(outcomeId, 50)

      const [supersedeResult, revokeResult] = await Promise.all([
        supersedeSensitiveAggregationDeclaration(
          previousId,
          { organizationId: orgId, projectId, entityType: 'outcome', entityId: outcomeId, sensitiveCategory: 'minors', groupSize: 80, dimensions: [], countSourceType: 'indicator_measurement', declaredByUserId: userId },
          'organization_admin',
        ),
        revokeSensitiveAggregationDeclaration({ declarationId: previousId, organizationId: orgId, revokedByUserId: userId, reason: 'race' }, 'organization_admin'),
      ])

      const succeeded = [supersedeResult.ok, revokeResult.ok].filter(Boolean)
      expect(succeeded).toHaveLength(1) // never both — the FOR UPDATE lock serializes them

      const previousRow = await fetchRow(previousId)
      if (supersedeResult.ok) {
        // supersede won the lock first: revoke must see the row as already superseded, not verified.
        expect(revokeResult).toEqual({ ok: false, error: 'ALREADY_SUPERSEDED' })
        expect(previousRow.verificationStatus).toBe('superseded')
        expect(previousRow.supersededByDeclarationId).toBe(supersedeResult.id)
      } else {
        // revoke won the lock first: supersede must see the row as already revoked, not verified.
        expect(revokeResult).toEqual({ ok: true })
        expect(supersedeResult).toEqual({ ok: false, error: 'PREVIOUS_ALREADY_REVOKED' })
        expect(previousRow.verificationStatus).toBe('revoked')
        expect(previousRow.supersededByDeclarationId).toBeNull()
      }
    })

    it('two concurrent supersede calls on the SAME previous declaration: exactly one succeeds, the other sees PREVIOUS_ALREADY_SUPERSEDED, no orphaned active row', async () => {
      const outcomeId = await makeOutcome('Concurrent double-supersede outcome')
      const previousId = await declareAndVerify(outcomeId, 50)

      const [resultA, resultB] = await Promise.all([
        supersedeSensitiveAggregationDeclaration(
          previousId,
          { organizationId: orgId, projectId, entityType: 'outcome', entityId: outcomeId, sensitiveCategory: 'minors', groupSize: 80, dimensions: [], countSourceType: 'indicator_measurement', declaredByUserId: userId },
          'organization_admin',
        ),
        supersedeSensitiveAggregationDeclaration(
          previousId,
          { organizationId: orgId, projectId, entityType: 'outcome', entityId: outcomeId, sensitiveCategory: 'minors', groupSize: 90, dimensions: [], countSourceType: 'indicator_measurement', declaredByUserId: userId },
          'organization_admin',
        ),
      ])

      const results = [resultA, resultB]
      const succeeded = results.filter((r) => r.ok)
      const rejected = results.filter((r) => !r.ok && r.error === 'PREVIOUS_ALREADY_SUPERSEDED')
      expect(succeeded).toHaveLength(1)
      expect(rejected).toHaveLength(1)

      const previousRow = await fetchRow(previousId)
      expect(previousRow.verificationStatus).toBe('superseded')
      const winner = succeeded[0]
      if (winner.ok) expect(previousRow.supersededByDeclarationId).toBe(winner.id)

      const rows = await db.select().from(stellaSensitiveAggregationDeclarations).where(eq(stellaSensitiveAggregationDeclarations.entityId, outcomeId))
      const activeCount = rows.filter((r) => r.verificationStatus === 'pending' || r.verificationStatus === 'verified').length
      expect(activeCount).toBe(1) // exactly one new declaration created — the loser never inserted a row
    })
  })
})
