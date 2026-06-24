// lib/pipeline/narratives.ts
import { db } from '@/db/client';
import { impactNarratives, projects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/permissions';
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger';
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
      action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
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
      action: AUDIT_ACTIONS.ORGANIZATION_CREATED,
      afterJson: created,
    });
    return created;
  }
}
