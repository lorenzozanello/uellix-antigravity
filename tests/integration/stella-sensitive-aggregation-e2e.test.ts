// tests/integration/stella-sensitive-aggregation-e2e.test.ts
//
// Etapa A2.3.1 (STL-A231-020, DR-002/DR-003) — end-to-end against the real
// local stack (real Postgres, real Drizzle writes, real RLS-bypassing
// service-role reads where needed), covering the exact two cases the gate
// requires:
//   1. A verified declaration of group size 10 for a real outcome lets its
//      sensitive text pass assertContextHasNoForbiddenData.
//   2. A declaration of group size 9 is rejected at VERIFICATION time (never
//      becomes usable), so the same text stays blocked.
//
// Etapa A2.3.2 (STL-A232-024) adds a third scripted flow: a verified
// declaration gets superseded, and the guardrail only ever honors the new
// (eventually-verified) declaration — never the superseded one, and not the
// superseding one either until IT is independently verified (supersede never
// inherits verified status, by design).
//
// No Gemini call, no Stella activation — this only proves the deterministic
// declaration -> guardrail path end-to-end, using the REAL services (not
// mocks) from lib/stella/aggregation/*.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '@/db/client'
import { organizations, projects, outcomes, stakeholderGroups, stellaSensitiveAggregationDeclarations } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { deleteOrganizationsWithoutAuditTrail } from './cleanup'
import {
  createSensitiveAggregationDeclaration,
  verifySensitiveAggregationDeclaration,
  supersedeSensitiveAggregationDeclaration,
} from '@/lib/stella/aggregation/declaration-service'
import { assertContextHasNoForbiddenData } from '@/lib/stella/context/context-guardrails'
import { StellaContextGuardrailError } from '@/lib/stella/errors'
import type { StellaProjectContext } from '@/lib/stella/context/types'

describe('Sensitive-aggregation declaration → guardrail, end-to-end (Etapa A2.3.1)', () => {
  let orgId: string
  let projectId: string
  let stakeholderGroupId: string
  let userId: string

  beforeAll(async () => {
    orgId = randomUUID()
    await db.insert(organizations).values({ id: orgId, name: 'SSAD E2E Org', slug: `ssad-e2e-org-${Date.now()}` })

    // Reuse an existing user row rather than creating a new auth user for a
    // suite that doesn't need RLS-authenticated clients — declaredBy/
    // verifiedBy only need a valid FK to `users`.
    const rows = (await db.execute('select id from public.users limit 1')) as unknown as { id: string }[]
    userId = rows[0].id

    projectId = randomUUID()
    await db.insert(projects).values({ id: projectId, organizationId: orgId, name: 'SSAD E2E Project', status: 'draft', createdBy: userId })

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

  function contextWithOutcome(outcomeId: string, outcomeName: string): StellaProjectContext {
    return {
      projectId,
      organizationId: orgId,
      narrativeSummary: 'A short, normal narrative.',
      outcomesSnapshot: [{ id: outcomeId, name: outcomeName, description: '', stakeholderGroups: [] }],
      indicatorsSnapshot: [],
      stakeholderCount: 1,
      evidenceMetadata: [],
      evidenceTotal: 0,
      proxySummary: [],
      filterSetsSummary: [],
      calculationSnapshot: null,
      reportSections: [],
      projectCreatedAt: '2026-01-01T00:00:00Z',
      lastUpdatedAt: '2026-01-01T00:00:00Z',
    }
  }

  it('a verified declaration with groupSize 10 unblocks the exact outcome it was declared for', async () => {
    const outcomeId = randomUUID()
    await db.insert(outcomes).values({
      id: outcomeId,
      projectId,
      stakeholderGroupId,
      title: 'Outcome served 10 niños',
      createdBy: userId,
    })

    const created = await createSensitiveAggregationDeclaration(
      {
        organizationId: orgId,
        projectId,
        entityType: 'outcome',
        entityId: outcomeId,
        sensitiveCategory: 'minors',
        groupSize: 10,
        dimensions: [],
        countSourceType: 'indicator_measurement',
        declaredByUserId: userId,
      },
      'organization_admin',
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const verified = await verifySensitiveAggregationDeclaration(
      { declarationId: created.id, organizationId: orgId, verifiedByUserId: userId },
      'organization_admin',
    )
    expect(verified.ok).toBe(true)

    const context = contextWithOutcome(outcomeId, 'Outcome served 10 niños')
    await expect(assertContextHasNoForbiddenData(context)).resolves.toBeUndefined()

    await db.delete(outcomes).where(eq(outcomes.id, outcomeId))
  })

  it('a declaration with groupSize 9 fails verification and the outcome stays blocked', async () => {
    const outcomeId = randomUUID()
    await db.insert(outcomes).values({
      id: outcomeId,
      projectId,
      stakeholderGroupId,
      title: 'Outcome served 9 niños',
      createdBy: userId,
    })

    const created = await createSensitiveAggregationDeclaration(
      {
        organizationId: orgId,
        projectId,
        entityType: 'outcome',
        entityId: outcomeId,
        sensitiveCategory: 'minors',
        groupSize: 9,
        dimensions: [],
        countSourceType: 'indicator_measurement',
        declaredByUserId: userId,
      },
      'organization_admin',
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const verified = await verifySensitiveAggregationDeclaration(
      { declarationId: created.id, organizationId: orgId, verifiedByUserId: userId },
      'organization_admin',
    )
    expect(verified).toEqual({ ok: false, error: 'GROUP_SIZE_BELOW_THRESHOLD' })

    const context = contextWithOutcome(outcomeId, 'Outcome served 9 niños')
    await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)

    await db.delete(outcomes).where(eq(outcomes.id, outcomeId))
  })

  it('a valid declaration for a DIFFERENT outcome does not unblock this outcome (scoped to the exact entity)', async () => {
    const declaredOutcomeId = randomUUID()
    const otherOutcomeId = randomUUID()
    await db.insert(outcomes).values([
      { id: declaredOutcomeId, projectId, stakeholderGroupId, title: 'Declared outcome, served 50 niños', createdBy: userId },
      { id: otherOutcomeId, projectId, stakeholderGroupId, title: 'Undeclared outcome, served 50 niños', createdBy: userId },
    ])

    const created = await createSensitiveAggregationDeclaration(
      {
        organizationId: orgId,
        projectId,
        entityType: 'outcome',
        entityId: declaredOutcomeId,
        sensitiveCategory: 'minors',
        groupSize: 50,
        dimensions: [],
        countSourceType: 'indicator_measurement',
        declaredByUserId: userId,
      },
      'organization_admin',
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await verifySensitiveAggregationDeclaration({ declarationId: created.id, organizationId: orgId, verifiedByUserId: userId }, 'organization_admin')

    // The declared outcome passes...
    await expect(assertContextHasNoForbiddenData(contextWithOutcome(declaredOutcomeId, 'Declared outcome, served 50 niños'))).resolves.toBeUndefined()
    // ...but the SAME text on a different, undeclared outcome still blocks.
    await expect(assertContextHasNoForbiddenData(contextWithOutcome(otherOutcomeId, 'Undeclared outcome, served 50 niños'))).rejects.toThrow(StellaContextGuardrailError)

    await db.delete(outcomes).where(eq(outcomes.projectId, projectId))
  })

  it('supersede flow: verified → superseded (pending successor) re-blocks, then verifying the successor unblocks — the guardrail never honors the superseded declaration', async () => {
    const outcomeId = randomUUID()
    await db.insert(outcomes).values({
      id: outcomeId,
      projectId,
      stakeholderGroupId,
      title: 'Outcome served 60 niños',
      createdBy: userId,
    })
    const context = contextWithOutcome(outcomeId, 'Outcome served 60 niños')

    const created = await createSensitiveAggregationDeclaration(
      { organizationId: orgId, projectId, entityType: 'outcome', entityId: outcomeId, sensitiveCategory: 'minors', groupSize: 60, dimensions: [], countSourceType: 'indicator_measurement', declaredByUserId: userId },
      'organization_admin',
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const verified = await verifySensitiveAggregationDeclaration({ declarationId: created.id, organizationId: orgId, verifiedByUserId: userId }, 'organization_admin')
    expect(verified.ok).toBe(true)

    // Step 1: the original verified declaration unblocks the outcome.
    await expect(assertContextHasNoForbiddenData(context)).resolves.toBeUndefined()

    // Step 2: an admin supersedes it (e.g. re-verifying the same headcount
    // via a different count source). Deliberately keeps groupSize == 60,
    // matching the text's literal "60 niños" mention — the declared-vs-
    // mentioned cross-check in assessSensitiveData (STL-A23-014) would
    // otherwise reject ANY declaration whose groupSize disagrees with what
    // the text names, which is a separate, correct anti-smuggling control,
    // not what this test is proving. The previous row is marked
    // 'superseded' and the new row starts 'pending' — NEITHER satisfies the
    // guardrail's "verified" requirement, so the outcome is blocked again
    // until someone verifies the new declaration.
    const superseded = await supersedeSensitiveAggregationDeclaration(
      created.id,
      { organizationId: orgId, projectId, entityType: 'outcome', entityId: outcomeId, sensitiveCategory: 'minors', groupSize: 60, dimensions: [], countSourceType: 'indicator_measurement', declaredByUserId: userId },
      'organization_admin',
    )
    expect(superseded.ok).toBe(true)
    if (!superseded.ok) return

    await expect(assertContextHasNoForbiddenData(context)).rejects.toThrow(StellaContextGuardrailError)

    // Step 3: verifying the NEW declaration is what unblocks the outcome —
    // the guardrail is now honoring the successor, never the superseded row.
    const verifiedSuccessor = await verifySensitiveAggregationDeclaration(
      { declarationId: superseded.id, organizationId: orgId, verifiedByUserId: userId },
      'organization_admin',
    )
    expect(verifiedSuccessor.ok).toBe(true)

    await expect(assertContextHasNoForbiddenData(context)).resolves.toBeUndefined()

    // The old, superseded declaration cannot be re-verified to bypass this.
    const reVerifyOld = await verifySensitiveAggregationDeclaration(
      { declarationId: created.id, organizationId: orgId, verifiedByUserId: userId },
      'organization_admin',
    )
    expect(reVerifyOld).toEqual({ ok: false, error: 'ALREADY_SUPERSEDED' })

    await db.delete(outcomes).where(eq(outcomes.id, outcomeId))
  })
})
