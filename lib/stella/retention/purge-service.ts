// lib/stella/retention/purge-service.ts
// Etapa A2.4 (DR-004 aprobado) — batch preview/apply/resume of
// response_json redaction. This is the ONLY executable purge path in the
// system (see policy.ts's header) — it never deletes a stella_interactions
// row, never selects responseJson's actual value, and never records what
// was purged beyond a count.
//
// Concurrency model: each batch runs inside its own db.transaction with
// `SELECT ... FOR UPDATE` on the candidate rows. Two purges racing on the
// same organization serialize naturally at the row-lock level — the second
// transaction blocks until the first commits, then re-evaluates its own
// WHERE clause (responsePurgedAt IS NULL) against the now-committed data
// under READ COMMITTED, so it correctly excludes rows the first transaction
// just purged. Same principle already proven for
// lib/stella/aggregation/declaration-service.ts's supersede/verify/revoke
// transactions (Etapa A2.3.2) — reused here, not reinvented.
//
// Idempotency: `executeStellaRetentionPurge` requires a caller-supplied
// idempotencyKey. The FIRST call with a given key creates the run and
// processes it; a SECOND call with the SAME key hits the UNIQUE constraint
// on stella_retention_purge_runs.idempotencyKey and returns the EXISTING
// run's result instead of starting a new one — no double-processing, no
// silent overwrite.

import { randomUUID } from 'crypto'
import { db } from '@/db/client'
import { stellaInteractions, stellaRetentionPurgeRuns } from '@/db/schema'
import { and, asc, eq, isNull, lte, or, gt, inArray } from 'drizzle-orm'
import { CURRENT_STELLA_RETENTION_POLICY } from './policy'
import { evaluateRetentionEligibility, computeRetentionCutoff } from './eligibility'
import { getEffectiveRetentionSettings } from './settings-service'
import { getActiveHoldStatusForInteractions } from './hold-service'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'

const PURGE_ROLES: ReadonlySet<string> = new Set(['organization_admin'])

export const MIN_PURGE_BATCH_SIZE = 50
export const MAX_PURGE_BATCH_SIZE = 2000
export const DEFAULT_PURGE_BATCH_SIZE = 500

function clampBatchSize(size?: number): number {
  if (typeof size !== 'number' || !Number.isInteger(size)) return DEFAULT_PURGE_BATCH_SIZE
  return Math.min(Math.max(size, MIN_PURGE_BATCH_SIZE), MAX_PURGE_BATCH_SIZE)
}

export type PurgeRunMode = 'dry_run' | 'apply'
export type PurgeRunStatus = 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled'

export interface PurgeRunSummary {
  id: string
  organizationId: string
  policyVersion: string
  mode: PurgeRunMode
  status: PurgeRunStatus
  cutoffAt: Date
  batchSize: number
  recordsScanned: number
  recordsEligible: number
  recordsPurged: number
  recordsSkippedHold: number
  recordsFailed: number
  errorCode: string | null
}

function toSummary(row: typeof stellaRetentionPurgeRuns.$inferSelect): PurgeRunSummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    policyVersion: row.policyVersion,
    mode: row.mode as PurgeRunMode,
    status: row.status as PurgeRunStatus,
    cutoffAt: row.cutoffAt,
    batchSize: row.batchSize,
    recordsScanned: row.recordsScanned,
    recordsEligible: row.recordsEligible,
    recordsPurged: row.recordsPurged,
    recordsSkippedHold: row.recordsSkippedHold,
    recordsFailed: row.recordsFailed,
    errorCode: row.errorCode,
  }
}

interface Candidate {
  id: string
  projectId: string
  createdAt: Date
}

/**
 * Runs batches until the organization has no more candidate rows below
 * `cutoffAt` — a "candidate" is any row with `responsePurgedAt IS NULL AND
 * createdAt <= cutoffAt`; the eligibility function is still called per row
 * (belt-and-suspenders — see eligibility.ts's header) using the SAME
 * cutoff-derived `now`/`months` for the whole run.
 *
 * `mutate: false` (dry-run) never issues an UPDATE. `mutate: true` (apply)
 * redacts eligible rows inside the SAME per-batch transaction that also
 * persists the run's updated counters — one commit per batch, never a
 * separate "update counts" step that could fall out of sync with the actual
 * redaction if the process were interrupted between them.
 */
async function runBatchLoop(params: {
  runId: string
  organizationId: string
  cutoffAt: Date
  /** The wall-clock time the cutoff was computed from — reused per-row in the eligibility double-check below (see eligibility.ts's header on why the SQL filter and this check must agree). */
  now: Date
  months: number
  batchSize: number
  mutate: boolean
  startCursor: { createdAt: Date; id: string } | null
}): Promise<void> {
  let cursor = params.startCursor

  for (;;) {
    const cursorCondition = cursor
      ? or(gt(stellaInteractions.createdAt, cursor.createdAt), and(eq(stellaInteractions.createdAt, cursor.createdAt), gt(stellaInteractions.id, cursor.id)))
      : undefined

    const baseCondition = and(eq(stellaInteractions.organizationId, params.organizationId), isNull(stellaInteractions.responsePurgedAt), lte(stellaInteractions.createdAt, params.cutoffAt))

    const whereCondition = cursorCondition ? and(baseCondition, cursorCondition) : baseCondition

    const batchResult = await db.transaction(async (tx) => {
      const rows: Candidate[] = await tx
        .select({ id: stellaInteractions.id, projectId: stellaInteractions.projectId, createdAt: stellaInteractions.createdAt })
        .from(stellaInteractions)
        .where(whereCondition)
        .orderBy(asc(stellaInteractions.createdAt), asc(stellaInteractions.id))
        .limit(params.batchSize)
        .for('update')

      if (rows.length === 0) return { done: true, scanned: 0, eligible: 0, purged: 0, skippedHold: 0, lastCursor: cursor }

      const holdStatusByInteraction = await getActiveHoldStatusForInteractions({
        organizationId: params.organizationId,
        interactions: rows.map((r) => ({ id: r.id, projectId: r.projectId })),
      })

      let eligible = 0
      let purged = 0
      let skippedHold = 0
      const eligibleIds: string[] = []

      for (const row of rows) {
        const holdStatus = holdStatusByInteraction.get(row.id) ?? 'none'
        const verdict = evaluateRetentionEligibility({
          category: 'interaction_response_content',
          createdAt: row.createdAt,
          purgedAt: null,
          organizationRetentionMonths: params.months,
          holdStatus,
          now: params.now,
        })
        if (verdict.eligible) {
          eligible++
          eligibleIds.push(row.id)
        } else if (verdict.reason === 'active_hold') {
          skippedHold++
        }
      }

      if (params.mutate && eligibleIds.length > 0) {
        await tx
          .update(stellaInteractions)
          .set({ responseJson: null, responsePurgedAt: new Date(), responsePurgeRunId: params.runId })
          .where(inArray(stellaInteractions.id, eligibleIds))
        purged = eligibleIds.length
      }

      const last = rows[rows.length - 1]
      const newCursor = { createdAt: last.createdAt, id: last.id }

      const [current] = await tx.select().from(stellaRetentionPurgeRuns).where(eq(stellaRetentionPurgeRuns.id, params.runId)).for('update').limit(1)
      await tx
        .update(stellaRetentionPurgeRuns)
        .set({
          recordsScanned: current.recordsScanned + rows.length,
          recordsEligible: current.recordsEligible + eligible,
          recordsPurged: current.recordsPurged + purged,
          recordsSkippedHold: current.recordsSkippedHold + skippedHold,
          cursorCreatedAt: newCursor.createdAt,
          cursorId: newCursor.id,
          status: 'running',
        })
        .where(eq(stellaRetentionPurgeRuns.id, params.runId))

      return { done: rows.length < params.batchSize, scanned: rows.length, eligible, purged, skippedHold, lastCursor: newCursor }
    })

    if (batchResult.done) break
    cursor = batchResult.lastCursor
  }
}

export type PurgePreviewError = 'FORBIDDEN_ROLE'
export type PurgePreviewResult = { ok: true; run: PurgeRunSummary } | { ok: false; error: PurgePreviewError }

/** Dry-run: never mutates a row, never returns response_json content. Its own run row still records counts, cutoff, and the policy version used. */
export async function previewStellaRetentionPurge(
  organizationId: string,
  requestedByUserId: string,
  actorRole: string,
  options?: { batchSize?: number; now?: Date },
): Promise<PurgePreviewResult> {
  if (!PURGE_ROLES.has(actorRole)) return { ok: false, error: 'FORBIDDEN_ROLE' }

  const now = options?.now ?? new Date()
  const settings = await getEffectiveRetentionSettings(organizationId)
  const cutoffAt = computeRetentionCutoff(settings.responseRetentionMonths, now)
  const batchSize = clampBatchSize(options?.batchSize)

  const [run] = await db
    .insert(stellaRetentionPurgeRuns)
    .values({
      organizationId,
      policyVersion: CURRENT_STELLA_RETENTION_POLICY.policyVersion,
      mode: 'dry_run',
      status: 'running',
      startedAt: now,
      requestedBy: requestedByUserId,
      cutoffAt,
      batchSize,
      idempotencyKey: `dry_run:${organizationId}:${randomUUID()}`,
    })
    .returning()

  await runBatchLoop({ runId: run.id, organizationId, cutoffAt, now, months: settings.responseRetentionMonths, batchSize, mutate: false, startCursor: null })

  const [completed] = await db
    .update(stellaRetentionPurgeRuns)
    .set({ status: 'completed', completedAt: new Date() })
    .where(eq(stellaRetentionPurgeRuns.id, run.id))
    .returning()

  return { ok: true, run: toSummary(completed) }
}

export type PurgeApplyError = 'FORBIDDEN_ROLE' | 'PREVIEW_NOT_FOUND' | 'PREVIEW_ORGANIZATION_MISMATCH' | 'POLICY_CHANGED_SINCE_PREVIEW'
export type PurgeApplyResult = { ok: true; run: PurgeRunSummary; alreadyExisted: boolean } | { ok: false; error: PurgeApplyError }

export interface ExecutePurgeOptions {
  idempotencyKey: string
  /** A recent previewStellaRetentionPurge() run id — its policyVersion must match the CURRENT policy, or apply is rejected and a new dry-run is required. */
  previewRunId?: string
  batchSize?: number
  now?: Date
}

/** Redacts response_json for every eligible row. Requires a caller-supplied idempotencyKey; calling twice with the SAME key returns the first call's (already-completed) result instead of purging twice. */
export async function executeStellaRetentionPurge(
  organizationId: string,
  requestedByUserId: string,
  actorRole: string,
  options: ExecutePurgeOptions,
): Promise<PurgeApplyResult> {
  if (!PURGE_ROLES.has(actorRole)) return { ok: false, error: 'FORBIDDEN_ROLE' }

  if (options.previewRunId) {
    const [preview] = await db.select().from(stellaRetentionPurgeRuns).where(eq(stellaRetentionPurgeRuns.id, options.previewRunId)).limit(1)
    if (!preview) return { ok: false, error: 'PREVIEW_NOT_FOUND' }
    if (preview.organizationId !== organizationId) return { ok: false, error: 'PREVIEW_ORGANIZATION_MISMATCH' }
    if (preview.policyVersion !== CURRENT_STELLA_RETENTION_POLICY.policyVersion) return { ok: false, error: 'POLICY_CHANGED_SINCE_PREVIEW' }
  }

  const now = options.now ?? new Date()
  const settings = await getEffectiveRetentionSettings(organizationId)
  const cutoffAt = computeRetentionCutoff(settings.responseRetentionMonths, now)
  const batchSize = clampBatchSize(options.batchSize)

  let run: typeof stellaRetentionPurgeRuns.$inferSelect
  const alreadyExisted = false
  try {
    ;[run] = await db
      .insert(stellaRetentionPurgeRuns)
      .values({
        organizationId,
        policyVersion: CURRENT_STELLA_RETENTION_POLICY.policyVersion,
        mode: 'apply',
        status: 'running',
        startedAt: now,
        requestedBy: requestedByUserId,
        cutoffAt,
        batchSize,
        idempotencyKey: options.idempotencyKey,
      })
      .returning()
  } catch (error) {
    const cause = (error as { cause?: { code?: string } })?.cause
    const code = (error as { code?: string })?.code ?? cause?.code
    if (code !== '23505') throw error
    // Same idempotency key already used — return the EXISTING run, never start a second one.
    const [existing] = await db.select().from(stellaRetentionPurgeRuns).where(eq(stellaRetentionPurgeRuns.idempotencyKey, options.idempotencyKey)).limit(1)
    if (!existing) throw error
    return { ok: true, run: toSummary(existing), alreadyExisted: true }
  }

  await logAuditAction({
    organizationId,
    actorUserId: requestedByUserId,
    entityType: 'stella_retention_purge_run',
    entityId: run.id,
    action: AUDIT_ACTIONS.STELLA_RETENTION_PURGE_RUN_STARTED,
    afterJson: { policyVersion: run.policyVersion, cutoffAt: cutoffAt.toISOString() },
  })

  try {
    await runBatchLoop({ runId: run.id, organizationId, cutoffAt, now, months: settings.responseRetentionMonths, batchSize, mutate: true, startCursor: null })
    const [completed] = await db.update(stellaRetentionPurgeRuns).set({ status: 'completed', completedAt: new Date() }).where(eq(stellaRetentionPurgeRuns.id, run.id)).returning()

    await logAuditAction({
      organizationId,
      actorUserId: requestedByUserId,
      entityType: 'stella_retention_purge_run',
      entityId: run.id,
      action: AUDIT_ACTIONS.STELLA_RETENTION_PURGE_RUN_COMPLETED,
      afterJson: { recordsPurged: completed.recordsPurged, recordsScanned: completed.recordsScanned, recordsSkippedHold: completed.recordsSkippedHold },
    })

    return { ok: true, run: toSummary(completed), alreadyExisted }
  } catch (error) {
    const errorCode = error instanceof Error ? error.message.slice(0, 60) : 'UNKNOWN_ERROR'
    await db.update(stellaRetentionPurgeRuns).set({ status: 'failed', errorCode }).where(eq(stellaRetentionPurgeRuns.id, run.id))
    throw error
  }
}

export type PurgeResumeError = 'FORBIDDEN_ROLE' | 'RUN_NOT_FOUND' | 'RUN_ORGANIZATION_MISMATCH' | 'RUN_NOT_RESUMABLE'
export type PurgeResumeResult = { ok: true; run: PurgeRunSummary } | { ok: false; error: PurgeResumeError }

/** Continues an interrupted 'apply' run from its persisted cursor — never restarts from the beginning, never recomputes a new cutoffAt (uses the ORIGINAL run's cutoff/policy, not "now"). */
export async function resumeStellaRetentionPurge(
  runId: string,
  organizationId: string,
  actorRole: string,
  now: Date = new Date(),
): Promise<PurgeResumeResult> {
  if (!PURGE_ROLES.has(actorRole)) return { ok: false, error: 'FORBIDDEN_ROLE' }

  const [run] = await db.select().from(stellaRetentionPurgeRuns).where(eq(stellaRetentionPurgeRuns.id, runId)).limit(1)
  if (!run) return { ok: false, error: 'RUN_NOT_FOUND' }
  if (run.organizationId !== organizationId) return { ok: false, error: 'RUN_ORGANIZATION_MISMATCH' }
  if (run.mode !== 'apply') return { ok: false, error: 'RUN_NOT_RESUMABLE' }
  if (run.status !== 'running' && run.status !== 'failed') return { ok: false, error: 'RUN_NOT_RESUMABLE' }

  await db.update(stellaRetentionPurgeRuns).set({ status: 'running', errorCode: null }).where(eq(stellaRetentionPurgeRuns.id, run.id))

  const settings = await getEffectiveRetentionSettings(organizationId)
  const startCursor = run.cursorCreatedAt && run.cursorId ? { createdAt: run.cursorCreatedAt, id: run.cursorId } : null

  try {
    await runBatchLoop({ runId: run.id, organizationId, cutoffAt: run.cutoffAt, now, months: settings.responseRetentionMonths, batchSize: run.batchSize, mutate: true, startCursor })
    const [completed] = await db.update(stellaRetentionPurgeRuns).set({ status: 'completed', completedAt: new Date() }).where(eq(stellaRetentionPurgeRuns.id, run.id)).returning()
    return { ok: true, run: toSummary(completed) }
  } catch (error) {
    const errorCode = error instanceof Error ? error.message.slice(0, 60) : 'UNKNOWN_ERROR'
    await db.update(stellaRetentionPurgeRuns).set({ status: 'failed', errorCode }).where(eq(stellaRetentionPurgeRuns.id, run.id))
    throw error
  }
}

export async function getPurgeRunStatus(runId: string, organizationId: string): Promise<PurgeRunSummary | null> {
  const [run] = await db.select().from(stellaRetentionPurgeRuns).where(and(eq(stellaRetentionPurgeRuns.id, runId), eq(stellaRetentionPurgeRuns.organizationId, organizationId))).limit(1)
  return run ? toSummary(run) : null
}
