// lib/pipeline/methodology-review.ts
// Fase 2 — methodology review matrix generalized across the whole pipeline.
// Pure scoring + checklist templates live at the top; DB-backed service
// functions (authorized, audited) below — mirroring confidence-score.ts, which
// keeps its pure computeConfidenceScore alongside its persistence wrapper.

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db/client'
import {
  projects,
  methodologyReviewMatrix,
  methodologyReviewMatrixItems,
} from '@/db/schema'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'

export type ReviewItemStatus = 'pass' | 'warning' | 'fail' | 'not_applicable'
export type ReviewItemSeverity = 'low' | 'medium' | 'high'

export type ScorableItem = {
  status: ReviewItemStatus
  severity: ReviewItemSeverity
}

// Pipeline steps covered by the generalized methodology review matrix. The
// calculation run keeps its own dedicated review (sroi_run_reviews); this matrix
// fills the gap for every earlier step, which previously had no review surface.
export const PIPELINE_REVIEW_STEPS = [
  'stakeholders',
  'outcomes',
  'indicators',
  'evidence',
  'proxies',
  'narrative',
] as const

export type PipelineReviewStep = (typeof PIPELINE_REVIEW_STEPS)[number]

export type ChecklistItemTemplate = {
  itemKey: string
  label: string
  defaultSeverity: ReviewItemSeverity
}

// Methodology checklist per pipeline step, grounded in SROI / Social Value
// International practice. Items are the fixed baseline a reviewer assesses
// (pass/warning/fail/na); reviewers may still add custom items on top. Labels
// are user-facing Spanish, matching the rest of the product UI. Editing this
// map is the single place to evolve the methodology checklist.
const REVIEW_CHECKLIST_TEMPLATES: Record<PipelineReviewStep, ChecklistItemTemplate[]> = {
  stakeholders: [
    { itemKey: 'stakeholders_identified', label: 'Se identificaron todos los grupos de interés materiales', defaultSeverity: 'high' },
    { itemKey: 'stakeholders_engagement', label: 'Se documentó cómo se involucró a cada grupo de interés', defaultSeverity: 'medium' },
    { itemKey: 'stakeholders_no_omission', label: 'No se omitió ningún grupo afectado significativamente', defaultSeverity: 'high' },
  ],
  outcomes: [
    { itemKey: 'outcomes_linked_stakeholders', label: 'Cada outcome está vinculado a un grupo de interés', defaultSeverity: 'high' },
    { itemKey: 'outcomes_materiality', label: 'La materialidad de cada outcome está justificada', defaultSeverity: 'high' },
    { itemKey: 'outcomes_no_double_count', label: 'No hay doble conteo de outcomes', defaultSeverity: 'high' },
    { itemKey: 'outcomes_chain_plausible', label: 'La cadena de eventos hacia el outcome es plausible', defaultSeverity: 'medium' },
  ],
  indicators: [
    { itemKey: 'indicators_measurable', label: 'Cada outcome material tiene al menos un indicador medible', defaultSeverity: 'high' },
    { itemKey: 'indicators_baseline', label: 'Se capturó la línea base de cada indicador', defaultSeverity: 'medium' },
    { itemKey: 'indicators_target', label: 'Se definió una meta para cada indicador', defaultSeverity: 'low' },
  ],
  evidence: [
    { itemKey: 'evidence_sources_verified', label: 'Las fuentes de evidencia están verificadas (integridad y origen)', defaultSeverity: 'high' },
    { itemKey: 'evidence_confidence_justified', label: 'El nivel de confianza de la evidencia está justificado', defaultSeverity: 'medium' },
    { itemKey: 'evidence_linked', label: 'La evidencia está vinculada a outcomes o indicadores', defaultSeverity: 'medium' },
  ],
  proxies: [
    { itemKey: 'proxies_sourced', label: 'Cada proxy financiero tiene su fuente documentada', defaultSeverity: 'high' },
    { itemKey: 'proxies_reference_year', label: 'El año de referencia de cada proxy está documentado', defaultSeverity: 'medium' },
    { itemKey: 'proxies_appropriate', label: 'El proxy es apropiado para el outcome que valoriza', defaultSeverity: 'high' },
    { itemKey: 'proxies_no_overclaim', label: 'El valor del proxy no sobreestima el outcome', defaultSeverity: 'high' },
  ],
  narrative: [
    { itemKey: 'narrative_causal_assumptions', label: 'Cada enlace causal tiene sus supuestos explícitos', defaultSeverity: 'medium' },
    { itemKey: 'narrative_deadweight', label: 'Se consideró el peso muerto (deadweight)', defaultSeverity: 'high' },
    { itemKey: 'narrative_attribution', label: 'Se consideró la atribución', defaultSeverity: 'high' },
    { itemKey: 'narrative_displacement', label: 'Se consideró el desplazamiento', defaultSeverity: 'medium' },
  ],
}

export function getReviewChecklistTemplate(step: PipelineReviewStep): ChecklistItemTemplate[] {
  return REVIEW_CHECKLIST_TEMPLATES[step]
}

// ---------------------------------------------------------------------------
// Service layer (authorized + audited)
// ---------------------------------------------------------------------------

// Roles allowed to create/modify a methodology review — matches the reviewing
// roles enforced by upsertSroiRunReviewItem and the RLS policy (006_*). Note
// this is NOT a strict hierarchy level: 'reviewer' is a dedicated role that
// ranks below 'analyst' in ROLE_HIERARCHY yet is explicitly a reviewing role,
// while 'analyst' is not — so membership must be checked by set inclusion.
const REVIEW_ROLES = ['super_admin', 'organization_admin', 'impact_manager', 'reviewer']

/** Whether a role may create/modify a methodology review. Single source of truth
 *  for both the service guard and UI visibility. */
export function canReviewMethodology(role: string): boolean {
  return REVIEW_ROLES.includes(role)
}

function isReviewStep(step: string): step is PipelineReviewStep {
  return (PIPELINE_REVIEW_STEPS as readonly string[]).includes(step)
}

async function authorizeProject(projectId: string) {
  const ctx = await requireOrganizationAccess()
  const proj = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)))
  if (proj.length === 0) throw new Error('Project not found or not owned')
  return ctx
}

/**
 * Read the matrix + its items for a step, always alongside the step's checklist
 * template so the UI can render the full checklist even before a review exists
 * (opt-in). `matrix` is null and `items` empty until the first item is saved.
 */
export async function getMethodologyReview(projectId: string, step: PipelineReviewStep) {
  const ctx = await authorizeProject(projectId)
  const template = getReviewChecklistTemplate(step)

  const matrix = await db
    .select()
    .from(methodologyReviewMatrix)
    .where(
      and(
        eq(methodologyReviewMatrix.projectId, projectId),
        eq(methodologyReviewMatrix.organizationId, ctx.organization.id),
        eq(methodologyReviewMatrix.pipelineStep, step)
      )
    )
    .then((rows) => rows[0] ?? null)

  if (!matrix) return { matrix: null, items: [], template }

  const items = await db
    .select()
    .from(methodologyReviewMatrixItems)
    .where(eq(methodologyReviewMatrixItems.matrixId, matrix.id))

  return { matrix, items, template }
}

/** Create the matrix header for a step (opt-in). Idempotent: returns the existing one. */
export async function startMethodologyReview(projectId: string, step: PipelineReviewStep) {
  const ctx = await authorizeProject(projectId)
  if (!canReviewMethodology(ctx.membership.role)) {
    throw new Error('Permission denied: reviewing role required to start a review')
  }
  if (!isReviewStep(step)) throw new Error(`Unsupported pipeline step: ${step}`)

  const existing = await db
    .select()
    .from(methodologyReviewMatrix)
    .where(
      and(
        eq(methodologyReviewMatrix.projectId, projectId),
        eq(methodologyReviewMatrix.organizationId, ctx.organization.id),
        eq(methodologyReviewMatrix.pipelineStep, step)
      )
    )
  if (existing.length > 0) return existing[0]

  const created = await db
    .insert(methodologyReviewMatrix)
    .values({
      organizationId: ctx.organization.id,
      projectId,
      pipelineStep: step,
      status: 'draft',
      readinessScore: null,
      reviewerId: ctx.user.id,
      createdBy: ctx.user.id,
    })
    .returning()

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'methodology_review_matrix',
    entityId: created[0].id,
    action: AUDIT_ACTIONS.METHODOLOGY_REVIEW_STARTED,
    afterJson: created[0] as unknown as Record<string, unknown>,
  })
  return created[0]
}

const ReviewItemInputSchema = z.object({
  itemKey: z.string().min(1).max(255),
  label: z.string().min(1).max(500),
  status: z.enum(['pass', 'warning', 'fail', 'not_applicable']).default('warning'),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  isCustom: z.boolean().default(false),
  notes: z.string().optional(),
})

export type MethodologyReviewItemInput = z.input<typeof ReviewItemInputSchema>

/**
 * Upsert one checklist item (by itemKey within the step's matrix), then
 * recompute and persist the matrix readiness score from all its items.
 * Creates the matrix on first touch so callers don't need a separate start call.
 */
export async function upsertMethodologyReviewItem(
  projectId: string,
  step: PipelineReviewStep,
  input: MethodologyReviewItemInput
) {
  const ctx = await authorizeProject(projectId)
  if (!canReviewMethodology(ctx.membership.role)) {
    throw new Error('Permission denied: reviewing role required to review')
  }
  if (!isReviewStep(step)) throw new Error(`Unsupported pipeline step: ${step}`)

  const validated = ReviewItemInputSchema.parse(input)
  const matrix = await startMethodologyReview(projectId, step)

  const existing = await db
    .select()
    .from(methodologyReviewMatrixItems)
    .where(
      and(
        eq(methodologyReviewMatrixItems.matrixId, matrix.id),
        eq(methodologyReviewMatrixItems.itemKey, validated.itemKey)
      )
    )

  let item
  if (existing.length > 0) {
    item = await db
      .update(methodologyReviewMatrixItems)
      .set({
        label: validated.label,
        status: validated.status,
        severity: validated.severity,
        notes: validated.notes,
        updatedAt: new Date(),
        updatedBy: ctx.user.id,
      })
      .where(eq(methodologyReviewMatrixItems.id, existing[0].id))
      .returning()
      .then((r) => r[0])
  } else {
    item = await db
      .insert(methodologyReviewMatrixItems)
      .values({
        organizationId: ctx.organization.id,
        projectId,
        matrixId: matrix.id,
        itemKey: validated.itemKey,
        label: validated.label,
        status: validated.status,
        severity: validated.severity,
        isCustom: validated.isCustom,
        notes: validated.notes,
        createdBy: ctx.user.id,
      })
      .returning()
      .then((r) => r[0])
  }

  await recomputeMatrixScore(matrix.id, ctx.user.id)

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'methodology_review_matrix_item',
    entityId: item.id,
    action: AUDIT_ACTIONS.METHODOLOGY_REVIEW_ITEM_UPSERTED,
    afterJson: item as unknown as Record<string, unknown>,
  })
  return item
}

/** Recompute readiness_score from all items and persist it on the matrix header. */
async function recomputeMatrixScore(matrixId: string, actorUserId: string): Promise<void> {
  const items = await db
    .select({
      status: methodologyReviewMatrixItems.status,
      severity: methodologyReviewMatrixItems.severity,
    })
    .from(methodologyReviewMatrixItems)
    .where(eq(methodologyReviewMatrixItems.matrixId, matrixId))

  const score = computeReadinessScore(
    items.map((i) => ({
      status: i.status as ReviewItemStatus,
      severity: i.severity as ReviewItemSeverity,
    }))
  )

  await db
    .update(methodologyReviewMatrix)
    .set({ readinessScore: score, updatedAt: new Date(), updatedBy: actorUserId })
    .where(eq(methodologyReviewMatrix.id, matrixId))
}

const ReviewHeaderInputSchema = z.object({
  status: z.enum(['draft', 'reviewed', 'approved', 'flagged']).optional(),
  overallNotes: z.string().optional(),
})

export type MethodologyReviewHeaderInput = z.input<typeof ReviewHeaderInputSchema>

/** Update the matrix header (status / overall notes). */
export async function updateMethodologyReview(
  projectId: string,
  step: PipelineReviewStep,
  input: MethodologyReviewHeaderInput
) {
  const ctx = await authorizeProject(projectId)
  if (!canReviewMethodology(ctx.membership.role)) {
    throw new Error('Permission denied: reviewing role required to review')
  }
  const validated = ReviewHeaderInputSchema.parse(input)
  const matrix = await startMethodologyReview(projectId, step)

  const updated = await db
    .update(methodologyReviewMatrix)
    .set({
      status: validated.status ?? matrix.status,
      overallNotes: validated.overallNotes ?? matrix.overallNotes,
      reviewedAt: new Date(),
      updatedAt: new Date(),
      updatedBy: ctx.user.id,
    })
    .where(eq(methodologyReviewMatrix.id, matrix.id))
    .returning()
    .then((r) => r[0])

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'methodology_review_matrix',
    entityId: matrix.id,
    action: AUDIT_ACTIONS.METHODOLOGY_REVIEW_UPDATED,
    afterJson: updated as unknown as Record<string, unknown>,
  })
  return updated
}

// Severity weights how much an item pulls the score. A high-severity failure
// hurts more than a minor one — methodologically, a critical gap should drag
// readiness down harder than a cosmetic warning.
const SEVERITY_WEIGHT: Record<ReviewItemSeverity, number> = { low: 1, medium: 2, high: 3 }

// Fractional credit each item earns toward readiness by its status.
// not_applicable is excluded entirely (removed from the denominator).
const STATUS_CREDIT: Record<Exclude<ReviewItemStatus, 'not_applicable'>, number> = {
  pass: 1,
  warning: 0.5,
  fail: 0,
}

/**
 * Deterministic 0–100 readiness score rolled up from checklist item statuses,
 * weighted by severity. Returns null when there is nothing to assess (no items,
 * or every item is not_applicable) — an honest "not yet assessed" rather than a
 * misleading 0 or 100.
 */
export function computeReadinessScore(items: ScorableItem[]): number | null {
  const applicable = items.filter((item) => item.status !== 'not_applicable')
  if (applicable.length === 0) return null

  let earned = 0
  let possible = 0
  for (const item of applicable) {
    const weight = SEVERITY_WEIGHT[item.severity]
    earned += weight * STATUS_CREDIT[item.status as Exclude<ReviewItemStatus, 'not_applicable'>]
    possible += weight
  }

  return Math.round((100 * earned) / possible)
}
