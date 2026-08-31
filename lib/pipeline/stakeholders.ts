// lib/pipeline/stakeholders.ts
import { db } from '@/db/client';
import { stakeholderGroups, projects } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/permissions';
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger';
import { z } from 'zod';

const stakeholderInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.string().optional(),
});

type StakeholderInput = z.infer<typeof stakeholderInputSchema>;

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

/** List all stakeholder groups for a project */
export async function listStakeholdersForProject(projectId: string) {
  await verifyProjectAccess(projectId);
  return db
    .select()
    .from(stakeholderGroups)
    .where(eq(stakeholderGroups.projectId, projectId));
}

/** Create a new stakeholder group */
export async function createStakeholderForProject(
  projectId: string,
  input: StakeholderInput,
) {
  const ctx = await verifyProjectAccess(projectId);
  if (!hasRole(ctx.membership.role, 'impact_manager') &&
      !hasRole(ctx.membership.role, 'analyst') &&
      !hasRole(ctx.membership.role, 'organization_admin') &&
      !hasRole(ctx.membership.role, 'super_admin')) {
    throw new Error('Insufficient permissions to create stakeholder');
  }
  const parsed = stakeholderInputSchema.parse(input);
  const result = await db
    .insert(stakeholderGroups)
    .values({
      projectId,
      name: parsed.name,
      description: parsed.description,
      type: parsed.type,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  const created = result[0];
  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'stakeholder_group',
    entityId: created.id,
    action: AUDIT_ACTIONS.ORGANIZATION_CREATED,
    afterJson: created,
  });
  return created;
}

/** Get a single stakeholder group by its ID (must belong to the project) */
export async function getStakeholderByIdForProject(projectId: string, stakeholderGroupId: string) {
  await verifyProjectAccess(projectId);
  const group = await db
    .select()
    .from(stakeholderGroups)
    .where(and(eq(stakeholderGroups.id, stakeholderGroupId), eq(stakeholderGroups.projectId, projectId)))
    .then((rows) => rows[0] ?? null);
  return group;
}

/**
 * Archive a stakeholder group (FIBIU-03 / FIBC-045). Excludes it from future
 * work without touching any history that already referenced it — this sets a
 * lifecycle flag, it never deletes or rewrites the row.
 */
export async function archiveStakeholderForProject(projectId: string, stakeholderGroupId: string) {
  const ctx = await verifyProjectAccess(projectId);
  if (!hasRole(ctx.membership.role, 'analyst')) {
    throw new Error('Insufficient permissions to archive stakeholder group');
  }

  const existing = await db
    .select()
    .from(stakeholderGroups)
    .where(and(eq(stakeholderGroups.id, stakeholderGroupId), eq(stakeholderGroups.projectId, projectId)))
    .then((rows) => rows[0] ?? null);
  if (!existing) throw new Error('Stakeholder group not found for project');
  if (existing.status === 'archived') return existing;

  await db
    .update(stakeholderGroups)
    .set({ status: 'archived', archivedBy: ctx.user.id, archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(stakeholderGroups.id, stakeholderGroupId), eq(stakeholderGroups.projectId, projectId)));

  const after = await db
    .select()
    .from(stakeholderGroups)
    .where(and(eq(stakeholderGroups.id, stakeholderGroupId), eq(stakeholderGroups.projectId, projectId)))
    .then((rows) => rows[0] ?? null);

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'stakeholder_group',
    entityId: stakeholderGroupId,
    action: AUDIT_ACTIONS.STAKEHOLDER_GROUP_ARCHIVED,
    beforeJson: { status: existing.status },
    afterJson: { status: after?.status ?? 'archived' },
  });

  return after;
}

// Alias exports for test compatibility
export const listStakeholderGroups = listStakeholdersForProject;
export const createStakeholderGroup = createStakeholderForProject;
export const getStakeholderGroup = getStakeholderByIdForProject;
export const archiveStakeholderGroup = archiveStakeholderForProject;
