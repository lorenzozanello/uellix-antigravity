// lib/pipeline/outcomes.ts
import { db } from '@/db/client';
import { outcomes, projects } from '@/db/schema';
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
});

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
  const result = await db
    .insert(outcomes)
    .values({
      projectId,
      stakeholderGroupId: parsed.stakeholderGroupId,
      title: parsed.title,
      description: parsed.description,
      outcomeType: parsed.outcomeType,
      materialityNotes: parsed.materialityNotes,
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

// Alias exports for test compatibility
export const listOutcomes = listOutcomesForProject;
export const createOutcome = createOutcomeForProject;
export const getOutcome = getOutcomeByIdForProject;
