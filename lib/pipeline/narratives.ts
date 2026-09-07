// lib/pipeline/narratives.ts
import { db } from '@/db/client';
import { impactNarratives, projects, methodologicalAssumptions, assumptionObjectLinks, sroiCalculationLineItems, sroiRunReviews } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/permissions';
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger';
import { createDomainObjectVersion } from '@/lib/pipeline/domain-object-versions';
import { z } from 'zod';

// Zod schema for upsert input
const narrativeInputSchema = z.object({
  version: z.string().min(1),
  narrativeText: z.string().optional(),
  theoryOfChangeSummary: z.string().optional(),
  assumptions: z.string().optional(),
  status: z.enum(['draft', 'active', 'completed', 'archived']).optional(),
});

type NarrativeInput = z.infer<typeof narrativeInputSchema>;

/** Verify that the project belongs to the current organization */
async function verifyProjectAccess(projectId: string) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');

    const project = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);

  if (!project) throw new Error('Project not found');
  if (project.organizationId !== ctx.organization.id) {
    throw new Error('Project does not belong to your organization');
  }
  return ctx;
}

/** Get the narrative for a project (read‑only) */
export async function getNarrativeForProject(projectId: string) {
  await verifyProjectAccess(projectId);
    const narrative = await db
      .select()
      .from(impactNarratives)
      .where(eq(impactNarratives.projectId, projectId))
      .then((rows) => rows[0] ?? null);
  return narrative;
}

/** Upsert (create or update) a narrative for a project */
export async function upsertNarrativeForProject(
  projectId: string,
  input: NarrativeInput,
) {
  const ctx = await verifyProjectAccess(projectId);

  // Permission check – only admins, impact managers, analysts may write
  if (!hasRole(ctx.membership.role, 'impact_manager') &&
      !hasRole(ctx.membership.role, 'analyst') &&
      !hasRole(ctx.membership.role, 'organization_admin') &&
      !hasRole(ctx.membership.role, 'super_admin')) {
    throw new Error('Insufficient permissions to upsert narrative');
  }

  const parsed = narrativeInputSchema.parse(input);

  // Upsert logic – try to find existing, then update or insert
  const existing = await db
    .select()
    .from(impactNarratives)
    .where(eq(impactNarratives.projectId, projectId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (existing) {
    const before = { ...existing };
    await db
      .update(impactNarratives)
      .set({
        ...parsed,
        updatedAt: new Date(),
      })
      .where(eq(impactNarratives.id, existing.id));
    await logAuditAction({
      organizationId: ctx.organization.id,
      projectId,
      actorUserId: ctx.user.id,
      entityType: 'impact_narrative',
      entityId: existing.id,
      action: AUDIT_ACTIONS.IMPACT_NARRATIVE_UPDATED,
      contentModifying: true,
      beforeJson: before,
      afterJson: { ...existing, ...parsed },
    });
    return { ...existing, ...parsed };
  } else {
    const result = await db
      .insert(impactNarratives)
      .values({
        projectId,
        version: parsed.version,
        narrativeText: parsed.narrativeText,
        theoryOfChangeSummary: parsed.theoryOfChangeSummary,
        assumptions: parsed.assumptions,
        status: parsed.status ?? 'draft',
        createdBy: ctx.user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    const created = result[0];
    await logAuditAction({
      organizationId: ctx.organization.id,
      projectId,
      actorUserId: ctx.user.id,
      entityType: 'impact_narrative',
      entityId: created.id,
      action: AUDIT_ACTIONS.IMPACT_NARRATIVE_CREATED,
      afterJson: created,
    });
    return created;
  }
}

// ─── FIBIU-15 — structured methodological assumptions ──────────────────────
// FIBC-019, FIBDB-012/013/047. docs/ops/wave2/W2_B4_AUTHORITY_v1.0.0.json
// (HPO-ODS-W2-12). Legacy free text above (impactNarratives.assumptions) is
// NEVER auto-converted into these structured objects (NPDD-03, NEG-15-1) —
// this section shares the file only because both concern "assumptions" in
// the project narrative, not because one feeds the other.

const ASSUMPTION_BASIS_TYPE_VALUES = ['evidence_or_external_source', 'derived', 'documented_human_judgement'] as const
export type AssumptionBasisType = (typeof ASSUMPTION_BASIS_TYPE_VALUES)[number]

const ASSUMPTION_MATERIALITY_FLAG_VALUES = ['material', 'non_material'] as const
export type AssumptionMaterialityFlag = (typeof ASSUMPTION_MATERIALITY_FLAG_VALUES)[number]

export const ASSUMPTION_AFFECTED_OBJECT_TYPE_VALUES = [
  'outcome', 'theory_of_change_node', 'theory_of_change_link', 'sroi_calculation_run', 'indicator', 'project',
] as const
export type AssumptionAffectedObjectType = (typeof ASSUMPTION_AFFECTED_OBJECT_TYPE_VALUES)[number]

// FIBDB-047: provenance_reference NOT NULL only when basisType is
// 'evidence_or_external_source'. documented_human_judgement/derived persist
// with it unset — no fictitious external source is ever demanded
// (FIBC-019 documented_human_judgement_contract).
export const MethodologicalAssumptionSchema = z.object({
  formulation: z.string().min(1),
  rationale: z.string().min(1),
  basisType: z.enum(ASSUMPTION_BASIS_TYPE_VALUES),
  provenanceReference: z.string().min(1).optional(),
  materialityFlag: z.enum(ASSUMPTION_MATERIALITY_FLAG_VALUES),
}).refine(
  (data) => data.basisType !== 'evidence_or_external_source' || (data.provenanceReference !== undefined && data.provenanceReference.length > 0),
  { message: 'provenanceReference is required when basisType is evidence_or_external_source', path: ['provenanceReference'] },
)
export type MethodologicalAssumptionInput = z.infer<typeof MethodologicalAssumptionSchema>

async function authorizeAssumption(projectId: string) {
  const ctx = await verifyProjectAccess(projectId)
  if (!hasRole(ctx.membership.role, 'analyst')) throw new Error('Insufficient role')
  return ctx
}

/**
 * FIBIU-15 (FIBC-019) — create a first-class structured methodological
 * assumption: formulation, rationale, basis/provenance where it exists,
 * basis type, materiality flag, actor, timestamp and version identity
 * (the created domainObjectVersions row below is version 1). "Affected
 * objects/decisions" — the ninth contracted minimum field — is recorded
 * separately via linkAssumptionToObject/assumption_object_links, never as a
 * column here, matching the certified two-table split (FIBDB-012/013).
 */
export async function recordMethodologicalAssumption(
  projectId: string,
  input: MethodologicalAssumptionInput,
) {
  const ctx = await authorizeAssumption(projectId)
  const validated = MethodologicalAssumptionSchema.parse(input)

  const [created] = await db.insert(methodologicalAssumptions).values({
    organizationId: ctx.organization.id,
    projectId,
    formulation: validated.formulation,
    rationale: validated.rationale,
    basisType: validated.basisType,
    provenanceReference: validated.basisType === 'evidence_or_external_source' ? (validated.provenanceReference ?? null) : null,
    materialityFlag: validated.materialityFlag,
    createdBy: ctx.user.id,
  }).returning()

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'methodological_assumption',
    entityId: created.id,
    action: AUDIT_ACTIONS.METHODOLOGICAL_ASSUMPTION_CREATED,
    afterJson: created as unknown as Record<string, unknown>,
  })

  await createDomainObjectVersion({
    organizationId: ctx.organization.id,
    objectType: 'methodological_assumption',
    objectId: created.id,
    payload: created as unknown as Record<string, unknown>,
    actorId: ctx.user.id,
  })

  return created
}

/**
 * FIBIU-15 — a material modification updates the assumption's PERMANENT row
 * (id never changes) and preserves the PRIOR content as a new
 * domainObjectVersions entry before applying the change, so the prior
 * version remains independently readable as history (versioning_contract).
 * Refused — never silently re-pointed — when the assumption is linked (via
 * assumption_object_links, directly or through a linked outcome's own
 * line items) to a calculation run that already carries an APPROVED review:
 * FIBC-019 requires a NEW RUN instead.
 */
export async function updateMethodologicalAssumption(
  projectId: string,
  assumptionId: string,
  input: MethodologicalAssumptionInput,
) {
  const ctx = await authorizeAssumption(projectId)
  const validated = MethodologicalAssumptionSchema.parse(input)

  const existingRows = await db
    .select()
    .from(methodologicalAssumptions)
    .where(and(eq(methodologicalAssumptions.id, assumptionId), eq(methodologicalAssumptions.projectId, projectId)))
  if (existingRows.length === 0) throw new Error('Assumption not found for project')
  const existing = existingRows[0]

  const links = await db.select().from(assumptionObjectLinks).where(eq(assumptionObjectLinks.assumptionId, assumptionId))
  const linkedOutcomeIds = links.filter((l) => l.affectedObjectType === 'outcome').map((l) => l.affectedObjectId)
  const linkedRunIds = links.filter((l) => l.affectedObjectType === 'sroi_calculation_run').map((l) => l.affectedObjectId)
  if (linkedOutcomeIds.length > 0 || linkedRunIds.length > 0) {
    const runIdsFromOutcomes = linkedOutcomeIds.length > 0
      ? (await db.select({ runId: sroiCalculationLineItems.runId }).from(sroiCalculationLineItems).where(inArray(sroiCalculationLineItems.outcomeId, linkedOutcomeIds))).map((r) => r.runId)
      : []
    const candidateRunIds = [...new Set([...linkedRunIds, ...runIdsFromOutcomes])]
    if (candidateRunIds.length > 0) {
      const approved = await db
        .select({ id: sroiRunReviews.id, runId: sroiRunReviews.calculationRunId })
        .from(sroiRunReviews)
        .where(and(inArray(sroiRunReviews.calculationRunId, candidateRunIds), eq(sroiRunReviews.status, 'approved')))
      if (approved.length > 0) {
        throw new Error(
          `Cannot modify methodological assumption ${assumptionId}: it affects the inputs of approved calculation run ${approved[0].runId}. ` +
          'Start a new run instead of modifying an assumption an approved run already relied on.',
        )
      }
    }
  }

  const updatedRows = await db
    .update(methodologicalAssumptions)
    .set({
      formulation: validated.formulation,
      rationale: validated.rationale,
      basisType: validated.basisType,
      provenanceReference: validated.basisType === 'evidence_or_external_source' ? (validated.provenanceReference ?? null) : null,
      materialityFlag: validated.materialityFlag,
      updatedBy: ctx.user.id,
      updatedAt: new Date(),
    })
    .where(eq(methodologicalAssumptions.id, assumptionId))
    .returning()
  if (updatedRows.length === 0) {
    throw new Error('Assumption update affected no row (refused by row-level security) — nothing was recorded')
  }
  const updated = updatedRows[0]

  // The PRIOR content becomes the new history row — this call must record
  // `existing`, not `updated`: getLatestDomainObjectVersion for this
  // objectId must return the version that was superseded, not the one that
  // superseded it.
  await createDomainObjectVersion({
    organizationId: ctx.organization.id,
    objectType: 'methodological_assumption',
    objectId: assumptionId,
    payload: existing as unknown as Record<string, unknown>,
    actorId: ctx.user.id,
  })

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'methodological_assumption',
    entityId: assumptionId,
    action: AUDIT_ACTIONS.METHODOLOGICAL_ASSUMPTION_SUPERSEDED,
    contentModifying: true,
    beforeJson: existing as unknown as Record<string, unknown>,
    afterJson: updated as unknown as Record<string, unknown>,
  })

  return updated
}

/**
 * FIBIU-15 (FIBDB-013) — record what an assumption affects. A material
 * assumption with zero rows here is UNRESOLVED for
 * getSroiCalculationReadiness's ASSUMPTION_UNRESOLVED gate. NOT reusable for
 * any other purpose (FIBDB-054 discretion sweep, FIB §17).
 */
export async function linkAssumptionToObject(
  projectId: string,
  assumptionId: string,
  affectedObjectType: AssumptionAffectedObjectType,
  affectedObjectId: string,
) {
  const ctx = await authorizeAssumption(projectId)
  const assumptionRows = await db
    .select()
    .from(methodologicalAssumptions)
    .where(and(eq(methodologicalAssumptions.id, assumptionId), eq(methodologicalAssumptions.projectId, projectId)))
  if (assumptionRows.length === 0) throw new Error('Assumption not found for project')

  const [created] = await db.insert(assumptionObjectLinks).values({
    organizationId: ctx.organization.id,
    assumptionId,
    affectedObjectType,
    affectedObjectId,
    createdBy: ctx.user.id,
  }).returning()

  return created
}

/** Round-trip read: every assumption for a project, with its affected-object links resolvable in both directions (POS-15-1). */
export async function listMethodologicalAssumptionsForProject(projectId: string) {
  const ctx = await verifyProjectAccess(projectId)
  const rows = await db.select().from(methodologicalAssumptions).where(eq(methodologicalAssumptions.projectId, projectId))
  if (rows.length === 0) return []
  const links = await db
    .select()
    .from(assumptionObjectLinks)
    .where(and(eq(assumptionObjectLinks.organizationId, ctx.organization.id), inArray(assumptionObjectLinks.assumptionId, rows.map((r) => r.id))))
  return rows.map((assumption) => ({
    ...assumption,
    links: links.filter((l) => l.assumptionId === assumption.id),
  }))
}

/**
 * FIBIU-15 — every material assumption for a project whose "affected
 * objects/decisions" minimum field is UNRESOLVED (zero assumption_object_links
 * rows). Used by getSroiCalculationReadiness's ASSUMPTION_UNRESOLVED gate
 * (NEG-15-2): the returned rows identify WHICH assumption blocks, never a
 * bare boolean.
 *
 * Auth-free core, factored out so a caller that has ALREADY authorized the
 * project (e.g. getSroiCalculationReadiness, which resolves its own ctx via
 * requireOrganizationAccess) never triggers a second, independent
 * getCurrentOrganizationContext() lookup — the two auth helpers are backed
 * by different session accessors and are not interchangeable in every
 * runtime/test context. listUnresolvedMaterialAssumptions below is the
 * authorized public entry point for every other caller.
 */
export async function queryUnresolvedMaterialAssumptions(organizationId: string, projectId: string) {
  const rows = await db
    .select()
    .from(methodologicalAssumptions)
    .where(and(eq(methodologicalAssumptions.projectId, projectId), eq(methodologicalAssumptions.materialityFlag, 'material')))
  if (rows.length === 0) return []
  const links = await db
    .select({ assumptionId: assumptionObjectLinks.assumptionId })
    .from(assumptionObjectLinks)
    .where(and(eq(assumptionObjectLinks.organizationId, organizationId), inArray(assumptionObjectLinks.assumptionId, rows.map((r) => r.id))))
  const linkedIds = new Set(links.map((l) => l.assumptionId))
  return rows.filter((r) => !linkedIds.has(r.id))
}

export async function listUnresolvedMaterialAssumptions(projectId: string) {
  const ctx = await verifyProjectAccess(projectId)
  return queryUnresolvedMaterialAssumptions(ctx.organization.id, projectId)
}
