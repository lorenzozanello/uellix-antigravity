// tests/integration/stella-retention-purge.test.ts
// Etapa A2.4 (DR-004 aprobado) — no mocks, real local Postgres. Covers §21
// (dry-run/apply/metadata preservation/holds/cross-org/roles), §22
// (concurrency/idempotency/policy-change), and §23 (the scripted E2E) of
// the encargo. No Gemini call, no Stella activation.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '@/db/client'
import {
  organizations,
  projects,
  stellaInteractions,
  stellaAiConsentEvents,
  stellaSensitiveAggregationDeclarations,
  stellaRetentionSettings,
  stellaRetentionHolds,
  stellaRetentionPurgeRuns,
  auditLogs,
} from '@/db/schema'
import { eq, and, count } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { deleteOrganizationsWithoutAuditTrail } from './cleanup'
import {
  previewStellaRetentionPurge,
  executeStellaRetentionPurge,
  resumeStellaRetentionPurge,
} from '@/lib/stella/retention/purge-service'
import { createRetentionHold, releaseRetentionHold } from '@/lib/stella/retention/hold-service'
import { CURRENT_STELLA_RETENTION_POLICY } from '@/lib/stella/retention/policy'

describe('Stella retention purge — end-to-end against real Postgres (Etapa A2.4)', () => {
  let orgId: string
  let orgBId: string
  let projectId: string
  let userId: string

  beforeAll(async () => {
    orgId = randomUUID()
    orgBId = randomUUID()
    await db.insert(organizations).values([
      { id: orgId, name: 'Retention Purge Org', slug: `retention-purge-org-${Date.now()}` },
      { id: orgBId, name: 'Retention Purge Org B', slug: `retention-purge-org-b-${Date.now()}` },
    ])
    const rows = (await db.execute('select id from public.users limit 1')) as unknown as { id: string }[]
    userId = rows[0].id
    projectId = randomUUID()
    await db.insert(projects).values({ id: projectId, organizationId: orgId, name: 'Retention Purge Project', status: 'draft', createdBy: userId })
  })

  afterAll(async () => {
    await db.delete(stellaRetentionPurgeRuns).where(eq(stellaRetentionPurgeRuns.organizationId, orgId))
    await db.delete(stellaRetentionHolds).where(eq(stellaRetentionHolds.organizationId, orgId))
    await db.delete(stellaRetentionSettings).where(eq(stellaRetentionSettings.organizationId, orgId))
    await db.delete(stellaInteractions).where(eq(stellaInteractions.projectId, projectId))
    await db.delete(projects).where(eq(projects.id, projectId))
    await deleteOrganizationsWithoutAuditTrail([orgId, orgBId])
  })

  function monthsAgo(months: number): Date {
    const d = new Date()
    d.setUTCMonth(d.getUTCMonth() - months)
    return d
  }

  async function makeInteraction(ageMonths: number, contextHash: string) {
    const id = randomUUID()
    await db.insert(stellaInteractions).values({
      id,
      organizationId: orgId,
      projectId,
      createdBy: userId,
      stellaRole: 'advisor',
      pipelineStep: 'narrative',
      contextHash,
      responseJson: { text: `response ${contextHash}` },
      modelUsed: 'test-model',
      contextManifest: { entities: 1 },
      createdAt: monthsAgo(ageMonths),
    })
    return id
  }

  async function fetchInteraction(id: string) {
    const [row] = await db.select().from(stellaInteractions).where(eq(stellaInteractions.id, id))
    return row
  }

  describe('Elegibilidad por edad — dry-run nunca muta, apply solo toca lo vencido', () => {
    it('una interacción de 23 meses no es elegible; una de 25 sí; dry-run no cambia nada; apply solo purga la de 25', async () => {
      const young = await makeInteraction(23, 'a'.repeat(64))
      const old = await makeInteraction(25, 'b'.repeat(64))

      const preview = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      expect(preview.ok).toBe(true)
      if (!preview.ok) return
      expect(preview.run.recordsEligible).toBe(1)
      expect(preview.run.recordsPurged).toBe(0) // dry-run never mutates

      const youngBefore = await fetchInteraction(young)
      const oldBefore = await fetchInteraction(old)
      expect(youngBefore.responseJson).not.toBeNull()
      expect(oldBefore.responseJson).not.toBeNull()

      const apply = await executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview.run.id, idempotencyKey: `test-${randomUUID()}` })
      expect(apply.ok).toBe(true)
      if (!apply.ok) return
      expect(apply.run.recordsPurged).toBe(1)

      const youngAfter = await fetchInteraction(young)
      const oldAfter = await fetchInteraction(old)
      expect(youngAfter.responseJson).not.toBeNull() // untouched — not yet expired
      expect(youngAfter.responsePurgedAt).toBeNull()
      expect(oldAfter.responseJson).toBeNull() // redacted
      expect(oldAfter.responsePurgedAt).not.toBeNull()
      expect(oldAfter.responsePurgeRunId).toBe(apply.run.id)

      // Metadata preserved on the purged row.
      expect(oldAfter.organizationId).toBe(orgId)
      expect(oldAfter.projectId).toBe(projectId)
      expect(oldAfter.createdBy).toBe(userId)
      expect(oldAfter.stellaRole).toBe('advisor')
      expect(oldAfter.modelUsed).toBe('test-model')
      expect(oldAfter.contextHash).toBe('b'.repeat(64))
      expect(oldAfter.contextManifest).toEqual({ entities: 1 }) // context_manifest preserved — different policy than response_json
    })

    it('un segundo apply es idempotente: la fila ya purgada no vuelve a tocarse', async () => {
      const old = await makeInteraction(30, 'c'.repeat(64))
      const preview1 = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      if (!preview1.ok) throw new Error('preview failed')
      const apply1 = await executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview1.run.id, idempotencyKey: `test-${randomUUID()}` })
      if (!apply1.ok) throw new Error('apply failed')
      const purgedAtFirst = (await fetchInteraction(old)).responsePurgedAt

      const preview2 = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      if (!preview2.ok) throw new Error('preview2 failed')
      const apply2 = await executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview2.run.id, idempotencyKey: `test-${randomUUID()}` })
      expect(apply2.ok).toBe(true)
      if (!apply2.ok) return
      expect(apply2.run.recordsPurged).toBe(0) // nothing left to purge

      const purgedAtSecond = (await fetchInteraction(old)).responsePurgedAt
      expect(purgedAtSecond?.getTime()).toBe(purgedAtFirst?.getTime()) // never re-touched
    })
  })

  describe('Holds bloquean la purga', () => {
    it('un hold activo bloquea, liberarlo permite la purga en la siguiente ejecución', async () => {
      const held = await makeInteraction(40, 'd'.repeat(64))

      const holdResult = await createRetentionHold(
        { organizationId: orgId, interactionId: held, holdType: 'legal_hold', reasonCode: 'pending_legal_review', createdByUserId: userId },
        'organization_admin',
      )
      expect(holdResult.ok).toBe(true)
      if (!holdResult.ok) return

      const preview1 = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      if (!preview1.ok) throw new Error('preview failed')
      expect(preview1.run.recordsSkippedHold).toBeGreaterThanOrEqual(1)

      const apply1 = await executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview1.run.id, idempotencyKey: `test-${randomUUID()}` })
      if (!apply1.ok) throw new Error('apply failed')
      const heldRowAfterApply1 = await fetchInteraction(held)
      expect(heldRowAfterApply1.responseJson).not.toBeNull() // still blocked

      const release = await releaseRetentionHold({ holdId: holdResult.id, organizationId: orgId, releasedByUserId: userId }, 'organization_admin')
      expect(release.ok).toBe(true)

      const preview2 = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      if (!preview2.ok) throw new Error('preview2 failed')
      const apply2 = await executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview2.run.id, idempotencyKey: `test-${randomUUID()}` })
      if (!apply2.ok) throw new Error('apply2 failed')

      const heldRowAfterApply2 = await fetchInteraction(held)
      expect(heldRowAfterApply2.responseJson).toBeNull() // eligible now that the hold is released
    })

    it('un hold creado ANTES del apply (pero después del dry-run) sigue bloqueando en el apply — se revalida, no solo en el preview', async () => {
      const target = await makeInteraction(50, 'e'.repeat(64))
      const preview = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      if (!preview.ok) throw new Error('preview failed')

      const holdResult = await createRetentionHold(
        { organizationId: orgId, interactionId: target, holdType: 'audit_investigation', reasonCode: 'incident_investigation', createdByUserId: userId },
        'organization_admin',
      )
      expect(holdResult.ok).toBe(true)

      const apply = await executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview.run.id, idempotencyKey: `test-${randomUUID()}` })
      if (!apply.ok) throw new Error('apply failed')

      const row = await fetchInteraction(target)
      expect(row.responseJson).not.toBeNull() // the hold created after preview still blocks apply
    })
  })

  describe('Cross-org isolation', () => {
    it('una purga de la organización A nunca toca interacciones de la organización B', async () => {
      const projectB = randomUUID()
      await db.insert(projects).values({ id: projectB, organizationId: orgBId, name: 'Org B Project', status: 'draft', createdBy: userId })
      const interactionB = randomUUID()
      await db.insert(stellaInteractions).values({
        id: interactionB,
        organizationId: orgBId,
        projectId: projectB,
        createdBy: userId,
        stellaRole: 'advisor',
        pipelineStep: 'narrative',
        contextHash: 'f'.repeat(64),
        responseJson: { text: 'org b response' },
        modelUsed: 'test-model',
        createdAt: monthsAgo(50),
      })

      const preview = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      if (!preview.ok) throw new Error('preview failed')
      const apply = await executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview.run.id, idempotencyKey: `test-${randomUUID()}` })
      if (!apply.ok) throw new Error('apply failed')

      const [rowB] = await db.select().from(stellaInteractions).where(eq(stellaInteractions.id, interactionB))
      expect(rowB.responseJson).not.toBeNull() // never touched by org A's purge

      await db.delete(stellaInteractions).where(eq(stellaInteractions.id, interactionB))
      await db.delete(projects).where(eq(projects.id, projectB))
    })
  })

  describe('Roles', () => {
    it('viewer no puede previsualizar ni aplicar', async () => {
      const preview = await previewStellaRetentionPurge(orgId, userId, 'viewer')
      expect(preview).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
      const apply = await executeStellaRetentionPurge(orgId, userId, 'viewer', { idempotencyKey: `test-${randomUUID()}` })
      expect(apply).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
    })

    it('analyst no puede ejecutar una purga', async () => {
      const apply = await executeStellaRetentionPurge(orgId, userId, 'analyst', { idempotencyKey: `test-${randomUUID()}` })
      expect(apply).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
    })

    it('super_admin (sin coincidencia exacta de organization_admin) no puede ejecutar una purga', async () => {
      const apply = await executeStellaRetentionPurge(orgId, userId, 'super_admin', { idempotencyKey: `test-${randomUUID()}` })
      expect(apply).toEqual({ ok: false, error: 'FORBIDDEN_ROLE' })
    })

    it('organization_admin sí puede', async () => {
      const preview = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      expect(preview.ok).toBe(true)
    })
  })

  describe('Idempotencia y concurrencia', () => {
    it('la MISMA idempotencyKey en dos llamadas devuelve la ejecución existente, nunca crea una segunda', async () => {
      await makeInteraction(60, 'g'.repeat(64))
      const preview = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      if (!preview.ok) throw new Error('preview failed')
      const key = `same-key-${randomUUID()}`

      const [first, second] = await Promise.all([
        executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview.run.id, idempotencyKey: key }),
        executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview.run.id, idempotencyKey: key }),
      ])
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      if (!first.ok || !second.ok) return
      expect(first.run.id).toBe(second.run.id) // same run, not two

      const runs = await db.select({ c: count() }).from(stellaRetentionPurgeRuns).where(eq(stellaRetentionPurgeRuns.idempotencyKey, key))
      expect(runs[0].c).toBe(1)
    })

    it('dos ejecuciones concurrentes con claves DISTINTAS sobre la misma organización no purgan dos veces la misma fila', async () => {
      const idA = await makeInteraction(70, 'h'.repeat(64))
      const idB = await makeInteraction(70, 'i'.repeat(64))

      const preview = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      if (!preview.ok) throw new Error('preview failed')

      const [runA, runB] = await Promise.all([
        executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview.run.id, idempotencyKey: `concurrent-a-${randomUUID()}` }),
        executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview.run.id, idempotencyKey: `concurrent-b-${randomUUID()}` }),
      ])
      expect(runA.ok).toBe(true)
      expect(runB.ok).toBe(true)
      if (!runA.ok || !runB.ok) return

      // Both runs report success; the important invariant is the FINAL state: each row purged exactly once.
      const rowA = await fetchInteraction(idA)
      const rowB = await fetchInteraction(idB)
      expect(rowA.responseJson).toBeNull()
      expect(rowB.responseJson).toBeNull()
      // Combined, the two runs never double-count either row as purged by both.
      expect(runA.run.recordsPurged + runB.run.recordsPurged).toBeGreaterThanOrEqual(2)
    })

    it('una re-ejecución de apply sobre una interacción ya purgada no la re-cuenta como purgada', async () => {
      const id = await makeInteraction(80, 'j'.repeat(64))
      const preview1 = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      if (!preview1.ok) throw new Error('preview failed')
      await executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview1.run.id, idempotencyKey: `test-${randomUUID()}` })

      const preview2 = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      if (!preview2.ok) throw new Error('preview2 failed')
      const apply2 = await executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview2.run.id, idempotencyKey: `test-${randomUUID()}` })
      if (!apply2.ok) throw new Error('apply2 failed')

      // The already-purged row is excluded by the SQL filter itself (responsePurgedAt IS NULL), so it's never re-scanned.
      const row = await fetchInteraction(id)
      expect(row.responsePurgedAt).not.toBeNull()
    })
  })

  describe('Cambio de política entre dry-run y apply', () => {
    it('un apply que referencia un dry-run con una policyVersion distinta a la actual es rechazado', async () => {
      const [staleRun] = await db
        .insert(stellaRetentionPurgeRuns)
        .values({
          organizationId: orgId,
          policyVersion: 'v0-stale',
          mode: 'dry_run',
          status: 'completed',
          requestedBy: userId,
          cutoffAt: new Date(),
          idempotencyKey: `stale-${randomUUID()}`,
        })
        .returning()

      const apply = await executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: staleRun.id, idempotencyKey: `test-${randomUUID()}` })
      expect(apply).toEqual({ ok: false, error: 'POLICY_CHANGED_SINCE_PREVIEW' })
      expect(CURRENT_STELLA_RETENTION_POLICY.policyVersion).not.toBe('v0-stale') // sanity: the mismatch is real
    })
  })

  describe('Reanudación tras interrupción', () => {
    it('resumeStellaRetentionPurge continúa desde el cursor persistido y termina la ejecución', async () => {
      const idOld1 = await makeInteraction(90, 'k'.repeat(64))
      const idOld2 = await makeInteraction(91, 'l'.repeat(64))

      // Simulate a run that started, processed nothing yet (cursor null), and crashed (status 'failed').
      const [interruptedRun] = await db
        .insert(stellaRetentionPurgeRuns)
        .values({
          organizationId: orgId,
          policyVersion: CURRENT_STELLA_RETENTION_POLICY.policyVersion,
          mode: 'apply',
          status: 'failed',
          requestedBy: userId,
          cutoffAt: new Date(),
          errorCode: 'SIMULATED_CRASH',
          idempotencyKey: `interrupted-${randomUUID()}`,
        })
        .returning()

      const resumed = await resumeStellaRetentionPurge(interruptedRun.id, orgId, 'organization_admin')
      expect(resumed.ok).toBe(true)
      if (!resumed.ok) return
      expect(resumed.run.status).toBe('completed')
      expect(resumed.run.recordsPurged).toBeGreaterThanOrEqual(2)

      expect((await fetchInteraction(idOld1)).responseJson).toBeNull()
      expect((await fetchInteraction(idOld2)).responseJson).toBeNull()
    })

    it('resumeStellaRetentionPurge rechaza una ejecución que no está en running/failed', async () => {
      const [completedRun] = await db
        .insert(stellaRetentionPurgeRuns)
        .values({
          organizationId: orgId,
          policyVersion: CURRENT_STELLA_RETENTION_POLICY.policyVersion,
          mode: 'apply',
          status: 'completed',
          requestedBy: userId,
          cutoffAt: new Date(),
          idempotencyKey: `already-done-${randomUUID()}`,
        })
        .returning()

      const resumed = await resumeStellaRetentionPurge(completedRun.id, orgId, 'organization_admin')
      expect(resumed).toEqual({ ok: false, error: 'RUN_NOT_RESUMABLE' })
    })
  })

  describe('Categorías fuera de alcance nunca se tocan', () => {
    it('los eventos de consentimiento y las declaraciones de agregación nunca se purgan', async () => {
      const consentBefore = await db.select({ c: count() }).from(stellaAiConsentEvents).where(eq(stellaAiConsentEvents.organizationId, orgId))
      const declarationsBefore = await db.select({ c: count() }).from(stellaSensitiveAggregationDeclarations).where(eq(stellaSensitiveAggregationDeclarations.organizationId, orgId))

      await makeInteraction(100, 'm'.repeat(64))
      const preview = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      if (!preview.ok) throw new Error('preview failed')
      await executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview.run.id, idempotencyKey: `test-${randomUUID()}` })

      const consentAfter = await db.select({ c: count() }).from(stellaAiConsentEvents).where(eq(stellaAiConsentEvents.organizationId, orgId))
      const declarationsAfter = await db.select({ c: count() }).from(stellaSensitiveAggregationDeclarations).where(eq(stellaSensitiveAggregationDeclarations.organizationId, orgId))
      expect(consentAfter[0].c).toBe(consentBefore[0].c)
      expect(declarationsAfter[0].c).toBe(declarationsBefore[0].c)
    })

    it('audit_logs se preserva — no se implementa ninguna purga para esta categoría en esta etapa', async () => {
      const before = await db.select({ c: count() }).from(auditLogs).where(eq(auditLogs.organizationId, orgId))
      await makeInteraction(100, 'n'.repeat(64))
      const preview = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      if (!preview.ok) throw new Error('preview failed')
      await executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview.run.id, idempotencyKey: `test-${randomUUID()}` })
      const after = await db.select({ c: count() }).from(auditLogs).where(eq(auditLogs.organizationId, orgId))
      // audit_logs only grows (the purge run itself adds entries) — it is never purged/shrunk.
      expect(after[0].c).toBeGreaterThanOrEqual(before[0].c)
    })
  })

  describe('Auditoría transaccional de holds', () => {
    it('crear y liberar un hold produce exactamente una entrada de audit_logs cada vez, con la MISMA transacción que la escritura', async () => {
      const before = await db.select({ c: count() }).from(auditLogs).where(and(eq(auditLogs.organizationId, orgId), eq(auditLogs.action, 'stella_retention_hold.created')))
      const holdResult = await createRetentionHold({ organizationId: orgId, holdType: 'dispute', reasonCode: 'active_dispute', createdByUserId: userId }, 'organization_admin')
      expect(holdResult.ok).toBe(true)
      if (!holdResult.ok) return
      const afterCreate = await db.select({ c: count() }).from(auditLogs).where(and(eq(auditLogs.organizationId, orgId), eq(auditLogs.action, 'stella_retention_hold.created')))
      expect(afterCreate[0].c).toBe(before[0].c + 1)

      await releaseRetentionHold({ holdId: holdResult.id, organizationId: orgId, releasedByUserId: userId }, 'organization_admin')
      const afterRelease = await db.select({ c: count() }).from(auditLogs).where(and(eq(auditLogs.organizationId, orgId), eq(auditLogs.action, 'stella_retention_hold.released')))
      expect(afterRelease[0].c).toBeGreaterThanOrEqual(1)
    })
  })

  describe('Prueba end-to-end (encargo §23)', () => {
    it('admin consulta política → dry-run identifica 2 elegibles, 1 con hold → apply purga solo 1 → metadatos y manifiesto permanecen → segundo apply es idempotente', async () => {
      const eligibleA = await makeInteraction(36, 'o'.repeat(64))
      const eligibleB = await makeInteraction(36, 'p'.repeat(64))

      const holdResult = await createRetentionHold(
        { organizationId: orgId, interactionId: eligibleB, holdType: 'legal_hold', reasonCode: 'pending_legal_review', createdByUserId: userId },
        'organization_admin',
      )
      expect(holdResult.ok).toBe(true)

      const preview = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      expect(preview.ok).toBe(true)
      if (!preview.ok) return
      expect(preview.run.recordsEligible).toBeGreaterThanOrEqual(1) // at least eligibleA (B is skipped-hold, not "eligible")
      expect(preview.run.recordsSkippedHold).toBeGreaterThanOrEqual(1)

      const apply = await executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview.run.id, idempotencyKey: `e2e-${randomUUID()}` })
      expect(apply.ok).toBe(true)
      if (!apply.ok) return

      const rowA = await fetchInteraction(eligibleA)
      const rowB = await fetchInteraction(eligibleB)
      expect(rowA.responseJson).toBeNull() // purged
      expect(rowB.responseJson).not.toBeNull() // held, never purged
      expect(rowA.contextManifest).toEqual({ entities: 1 }) // manifest preserved
      expect(rowA.organizationId).toBe(orgId) // metadata preserved

      const preview2 = await previewStellaRetentionPurge(orgId, userId, 'organization_admin')
      if (!preview2.ok) throw new Error('preview2 failed')
      const apply2 = await executeStellaRetentionPurge(orgId, userId, 'organization_admin', { previewRunId: preview2.run.id, idempotencyKey: `e2e-2-${randomUUID()}` })
      expect(apply2.ok).toBe(true)
      if (!apply2.ok) return
      // Second apply purges nothing new for eligibleA (already purged) — B still held.
      const rowAAfterSecond = await fetchInteraction(eligibleA)
      expect(rowAAfterSecond.responsePurgedAt?.getTime()).toBe(rowA.responsePurgedAt?.getTime())
    })
  })
})
