// lib/pipeline/indicators.ts
import { db } from '@/db/client';
import { indicators, projects } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/permissions';
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger';
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
    action: AUDIT_ACTIONS.ORGANIZATION_CREATED,
    afterJson: created,
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

// Alias exports for test compatibility
export const listIndicators = listIndicatorsForProject;
export const createIndicator = createIndicatorForProject;
export const getIndicator = getIndicatorByIdForProject;
