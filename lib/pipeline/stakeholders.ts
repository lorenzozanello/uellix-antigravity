// lib/pipeline/stakeholders.ts
import { db } from '@/db/client';
import { stakeholderGroups, projects } from '@/db/schema';
import { eq } from 'drizzle-orm';
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

// Alias exports for test compatibility
export const listStakeholderGroups = listStakeholdersForProject;
export const createStakeholderGroup = createStakeholderForProject;
