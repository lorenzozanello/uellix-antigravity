// lib/pipeline/indicators.ts
import { db } from '@/db/client';
import { indicators, projects, outcomes } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/permissions';
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger';
import { createDomainObjectVersion } from '@/lib/pipeline/domain-object-versions';
import { z } from 'zod';

const indicatorInputSchema = z.object({
  outcomeId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  indicatorType: z.string().optional(),
  unit: z.string().optional(),
  baselineValue: z.string().optional(),
  targetValue: z.string().optional(),
  actualValue: z.string().optional(),
  dataSource: z.string().optional(),
  measurementPeriod: z.string().optional(),
  confidenceLevel: z.string().optional(),
});

type IndicatorInput = z.infer<typeof indicatorInputSchema>;

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

/** List indicators for a project */
export async function listIndicatorsForProject(projectId: string) {
  await verifyProjectAccess(projectId);
  return db
    .select()
    .from(indicators)
    .where(eq(indicators.projectId, projectId));
}

/** Create an indicator */
export async function createIndicatorForProject(
  projectId: string,
  input: IndicatorInput,
) {
  const ctx = await verifyProjectAccess(projectId);
  if (!hasRole(ctx.membership.role, 'impact_manager') &&
      !hasRole(ctx.membership.role, 'analyst') &&
      !hasRole(ctx.membership.role, 'organization_admin') &&
      !hasRole(ctx.membership.role, 'super_admin')) {
    throw new Error('Insufficient permissions to create indicator');
  }
  const parsed = indicatorInputSchema.parse(input);

  const outcome = await db
    .select()
    .from(outcomes)
    .where(and(eq(outcomes.id, parsed.outcomeId), eq(outcomes.projectId, projectId)))
    .limit(1);
  if (outcome.length === 0) throw new Error('Outcome does not belong to this project');

  const result = await db
    .insert(indicators)
    .values({
      projectId,
      outcomeId: parsed.outcomeId,
      name: parsed.name,
      description: parsed.description,
      indicatorType: parsed.indicatorType,
      unit: parsed.unit,
      baselineValue: parsed.baselineValue,
      targetValue: parsed.targetValue,
      actualValue: parsed.actualValue,
      dataSource: parsed.dataSource,
      measurementPeriod: parsed.measurementPeriod,
      confidenceLevel: parsed.confidenceLevel,
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
    entityType: 'indicator',
    entityId: created.id,
    action: AUDIT_ACTIONS.INDICATOR_CREATED,
    afterJson: created,
  });
  // FIBIU-03 (FIBC-002/FIBC-045) — first version of this object's lineage.
  await createDomainObjectVersion({
    organizationId: ctx.organization.id,
    objectType: 'indicator',
    objectId: created.id,
    payload: created as unknown as Record<string, unknown>,
    actorId: ctx.user.id,
  });
  return created;
}

/** Get a single indicator by its ID (must belong to the project) */
export async function getIndicatorByIdForProject(projectId: string, indicatorId: string) {
  await verifyProjectAccess(projectId);
  const indicator = await db
    .select()
    .from(indicators)
    .where(and(eq(indicators.id, indicatorId), eq(indicators.projectId, projectId)))
    .then((rows) => rows[0] ?? null);
  return indicator;
}

/**
 * Archive an indicator (FIBIU-03 / FIBC-045). Excludes it from future work
 * without touching any history that already referenced it — this sets a
 * lifecycle flag, it never deletes or rewrites the row.
 */
export async function archiveIndicatorForProject(projectId: string, indicatorId: string) {
  const ctx = await verifyProjectAccess(projectId);
  if (!hasRole(ctx.membership.role, 'analyst')) {
    throw new Error('Insufficient permissions to archive indicator');
  }

  const existing = await db
    .select()
    .from(indicators)
    .where(and(eq(indicators.id, indicatorId), eq(indicators.projectId, projectId)))
    .then((rows) => rows[0] ?? null);
  if (!existing) throw new Error('Indicator not found for project');
  if (existing.status === 'archived') return existing;

  await db
    .update(indicators)
    .set({ status: 'archived', archivedBy: ctx.user.id, archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(indicators.id, indicatorId), eq(indicators.projectId, projectId)));

  const after = await db
    .select()
    .from(indicators)
    .where(and(eq(indicators.id, indicatorId), eq(indicators.projectId, projectId)))
    .then((rows) => rows[0] ?? null);

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'indicator',
    entityId: indicatorId,
    action: AUDIT_ACTIONS.INDICATOR_ARCHIVED,
    beforeJson: { status: existing.status },
    afterJson: { status: after?.status ?? 'archived' },
  });

  // HPO-DEC-2 (W1-05-RM2, FORM_ALPHA): archive preserves BOTH the
  // operational status/archivedBy/archivedAt projection above AND the
  // governed append-only lineage — one does not replace the other.
  if (after) {
    await createDomainObjectVersion({
      organizationId: ctx.organization.id,
      objectType: 'indicator',
      objectId: indicatorId,
      payload: after as unknown as Record<string, unknown>,
      actorId: ctx.user.id,
    });
  }

  return after;
}

// Alias exports for test compatibility
export const listIndicators = listIndicatorsForProject;
export const createIndicator = createIndicatorForProject;
export const getIndicator = getIndicatorByIdForProject;
export const archiveIndicator = archiveIndicatorForProject;
