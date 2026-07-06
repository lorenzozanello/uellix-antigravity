// lib/pipeline/outcomes.ts
import { db } from '@/db/client';
import { outcomes, projects, stakeholderGroups } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/permissions';
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger';
import { z } from 'zod';

const outcomeInputSchema = z.object({
  stakeholderGroupId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeType: z.string().optional(),
  materialityNotes: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  materialityScore: z.number().int().min(1).max(5).optional(),
  materialityRationale: z.string().min(1).optional(),
}).refine(
  (data) => (data.materialityScore === undefined) === (data.materialityRationale === undefined),
  { message: 'materialityScore and materialityRationale must both be provided together', path: ['materialityScore'] },
);

type OutcomeInput = z.infer<typeof outcomeInputSchema>;

async function verifyProjectAccess(projectId: string) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');

  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!project) throw new Error('Project not found');
  if (project.organizationId !== ctx.organization.id) {
    throw new Error('Project does not belong to your organization');
  }
  return ctx;
}

/** List outcomes for a project */
export async function listOutcomesForProject(projectId: string) {
  await verifyProjectAccess(projectId);
  return db
    .select()
    .from(outcomes)
    .where(eq(outcomes.projectId, projectId));
}

/** Create an outcome */
export async function createOutcomeForProject(
  projectId: string,
  input: OutcomeInput,
) {
  const ctx = await verifyProjectAccess(projectId);
  if (!hasRole(ctx.membership.role, 'impact_manager') &&
      !hasRole(ctx.membership.role, 'analyst') &&
      !hasRole(ctx.membership.role, 'organization_admin') &&
      !hasRole(ctx.membership.role, 'super_admin')) {
    throw new Error('Insufficient permissions to create outcome');
  }
  const parsed = outcomeInputSchema.parse(input);

  const group = await db
    .select()
    .from(stakeholderGroups)
    .where(and(eq(stakeholderGroups.id, parsed.stakeholderGroupId), eq(stakeholderGroups.projectId, projectId)))
    .limit(1);
  if (group.length === 0) throw new Error('Stakeholder group does not belong to this project');

  const result = await db
    .insert(outcomes)
    .values({
      projectId,
      stakeholderGroupId: parsed.stakeholderGroupId,
      title: parsed.title,
      description: parsed.description,
      outcomeType: parsed.outcomeType,
      materialityNotes: parsed.materialityNotes,
      materialityScore: parsed.materialityScore ?? null,
      materialityRationale: parsed.materialityRationale ?? null,
      status: parsed.status ?? 'active',
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
    entityType: 'outcome',
    entityId: created.id,
    action: AUDIT_ACTIONS.ORGANIZATION_CREATED,
    afterJson: created,
  });
  return created;
}

/** Get a single outcome by its ID (must belong to the project) */
export async function getOutcomeByIdForProject(projectId: string, outcomeId: string) {
  await verifyProjectAccess(projectId);
  const outcome = await db
    .select()
    .from(outcomes)
    .where(and(eq(outcomes.id, outcomeId), eq(outcomes.projectId, projectId)))
    .then((rows) => rows[0] ?? null);
  return outcome;
}

const setMaterialitySchema = z.object({
  materialityScore: z.number().int().min(1).max(5).nullable(),
  materialityRationale: z.string().min(1).optional(),
}).refine(
  (data) => data.materialityScore === null || (data.materialityRationale !== undefined && data.materialityRationale.length > 0),
  { message: 'materialityRationale is required when materialityScore is set', path: ['materialityRationale'] },
);
type SetMaterialityInput = z.infer<typeof setMaterialitySchema>;

/** Assign or clear an outcome's materiality score + rationale. The only edit path `outcomes` has today — deliberately scoped to just these two fields. */
export async function setOutcomeMateriality(projectId: string, outcomeId: string, input: SetMaterialityInput) {
  const ctx = await verifyProjectAccess(projectId);
  if (!hasRole(ctx.membership.role, 'analyst')) {
    throw new Error('Insufficient permissions to set outcome materiality');
  }
  const parsed = setMaterialitySchema.parse(input);

  const before = await db
    .select()
    .from(outcomes)
    .where(and(eq(outcomes.id, outcomeId), eq(outcomes.projectId, projectId)))
    .then((rows) => rows[0] ?? null);
  if (!before) throw new Error('Outcome not found for project');

  // Captured into local primitives before the update runs. With a real
  // Drizzle client this doesn't strictly matter (an UPDATE never mutates a
  // JS object returned by an earlier SELECT), but it avoids relying on that
  // guarantee — see the Fase 2b lesson where a test mock that mutates
  // objects by reference made this exact ordering matter for correctness.
  const previousScore = before.materialityScore
  const previousRationale = before.materialityRationale

  // Clearing the score always clears the rationale too, regardless of what
  // the caller passed for it — the atomic pair can never be broken from
  // this single write path.
  const finalScore = parsed.materialityScore
  const finalRationale = finalScore === null ? null : parsed.materialityRationale ?? null

  await db
    .update(outcomes)
    .set({ materialityScore: finalScore, materialityRationale: finalRationale, updatedAt: new Date() })
    .where(and(eq(outcomes.id, outcomeId), eq(outcomes.projectId, projectId)))

  const after = await db
    .select()
    .from(outcomes)
    .where(and(eq(outcomes.id, outcomeId), eq(outcomes.projectId, projectId)))
    .then((rows) => rows[0] ?? null)

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'outcome',
    entityId: outcomeId,
    action: AUDIT_ACTIONS.OUTCOME_MATERIALITY_UPDATED,
    beforeJson: { materialityScore: previousScore, materialityRationale: previousRationale },
    afterJson: { materialityScore: after?.materialityScore ?? null, materialityRationale: after?.materialityRationale ?? null },
  })

  return after
}

// Alias exports for test compatibility
export const listOutcomes = listOutcomesForProject;
export const createOutcome = createOutcomeForProject;
export const getOutcome = getOutcomeByIdForProject;
