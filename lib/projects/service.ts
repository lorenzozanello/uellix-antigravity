import { db } from '@/db/client';
import {
  projects,
  portfolios,
  evidenceItems,
  sroiCalculationRuns,
  sroiReports,
  sroiRunReviews,
  stellaInteractions,
  projectInvestments,
  outcomeProxyAssignments,
} from '@/db/schema';
import { eq, and, isNotNull, isNull } from 'drizzle-orm';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger';
import { currentGovernanceRegime } from '@/lib/pipeline/governance-regime';
import { canManagePortfolio } from '@/lib/auth/permissions';
import { z } from 'zod';
import type { Role } from '@/lib/auth/roles';

// Validation schema for project creation
const ProjectInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  thematicArea: z.string().optional(),
  territory: z.string().optional(),
  country: z.string().length(2).optional(),
  startDate: z.string().optional(), // ISO date string; parsing left to DB layer
  endDate: z.string().optional(),
  targetPopulationDescription: z.string().optional(),
  status: z.enum(['draft', 'active', 'completed', 'archived']).default('draft'),
  portfolioId: z.string().uuid().optional(),
});

type ProjectInput = z.input<typeof ProjectInputSchema>;

/** List all projects for the current organization */
export async function listProjectsForCurrentOrganization() {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');
  return db.select().from(projects).where(eq(projects.organizationId, ctx.organization.id));
}

/** List projects belonging to a specific portfolio, scoped to the current org */
export async function listProjectsForPortfolio(portfolioId: string) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.portfolioId, portfolioId), eq(projects.organizationId, ctx.organization.id)));
}

/** Get a project by ID, scoped to the current org */
export async function getProjectByIdForCurrentOrganization(id: string) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) return null;
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.organizationId, ctx.organization.id)));
  return rows[0] ?? null;
}

/** Create a project, checking role and logging audit */
export async function createProjectForCurrentOrganization(input: ProjectInput) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');
  const allowedRoles: Role[] = ['super_admin', 'organization_admin', 'impact_manager', 'analyst'];
  if (!allowedRoles.includes(ctx.membership.role)) {
    throw new Error('Permission denied');
  }
  const data = ProjectInputSchema.parse(input);

  // If a portfolioId is provided, ensure it belongs to the same org
  if (data.portfolioId) {
    const portfolio = await db
      .select()
      .from(portfolios)
      .where(and(eq(portfolios.id, data.portfolioId), eq(portfolios.organizationId, ctx.organization.id)));
    if (portfolio.length === 0) {
      throw new Error('Invalid portfolio reference');
    }
  }

  const [newRecord] = await db
    .insert(projects)
    .values({
      id: crypto.randomUUID(),
      organizationId: ctx.organization.id,
      portfolioId: data.portfolioId ?? null,
      name: data.name,
      description: data.description ?? null,
      thematicArea: data.thematicArea ?? null,
      territory: data.territory ?? null,
      country: data.country ?? null,
      startDate: data.startDate ? new Date(data.startDate) : null,
      endDate: data.endDate ? new Date(data.endDate) : null,
      targetPopulationDescription: data.targetPopulationDescription ?? null,
      status: data.status,
      createdBy: ctx.user.id,
      governanceRegime: currentGovernanceRegime(),
    })
    .returning();

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId: newRecord.id,
    actorUserId: ctx.user.id,
    entityType: 'project',
    entityId: newRecord.id,
    action: AUDIT_ACTIONS.PROJECT_CREATED,
    afterJson: data,
  });

  return newRecord;
}

/** Check if a project has critical data that blocks deletion */
interface DeletionBlockReason {
  blocked: boolean;
  reason?: string;
  details?: string[];
}

export async function validateProjectDeletionEligibility(projectId: string): Promise<DeletionBlockReason> {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');

  const project = await getProjectByIdForCurrentOrganization(projectId);
  if (!project) return { blocked: true, reason: 'Project not found' };

  const blockedReasons: string[] = [];

  // Check for evidence items (except draft)
  const evidenceCount = await db
    .select({ id: evidenceItems.id })
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.projectId, projectId),
        isNotNull(evidenceItems.status),
      ),
    )
    .execute();
  if (evidenceCount.length > 0) {
    blockedReasons.push('El proyecto contiene evidencia registrada.');
  }

  // Check for SROI calculation runs
  const sroiCalcCount = await db
    .select({ id: sroiCalculationRuns.id })
    .from(sroiCalculationRuns)
    .where(eq(sroiCalculationRuns.projectId, projectId))
    .execute();
  if (sroiCalcCount.length > 0) {
    blockedReasons.push('El proyecto tiene cálculos SROI ejecutados.');
  }

  // Check for SROI reports (except draft)
  const sroiReportCount = await db
    .select({ id: sroiReports.id })
    .from(sroiReports)
    .where(
      and(
        eq(sroiReports.projectId, projectId),
        isNotNull(sroiReports.status),
      ),
    )
    .execute();
  if (sroiReportCount.length > 0) {
    blockedReasons.push('El proyecto tiene reportes SROI generados.');
  }

  // Check for Stella reviews (any interaction blocks deletion)
  const stellaReviewCount = await db
    .select({ id: sroiRunReviews.id })
    .from(sroiRunReviews)
    .where(eq(sroiRunReviews.projectId, projectId))
    .execute();
  if (stellaReviewCount.length > 0) {
    blockedReasons.push('El proyecto ha sido revisado por Stella.');
  }

  // Check for Stella interactions
  const stellaIntCount = await db
    .select({ id: stellaInteractions.id })
    .from(stellaInteractions)
    .where(eq(stellaInteractions.projectId, projectId))
    .execute();
  if (stellaIntCount.length > 0) {
    blockedReasons.push('El proyecto tiene interacciones registradas con Stella.');
  }

  // Check for active investments
  const investmentCount = await db
    .select({ id: projectInvestments.id })
    .from(projectInvestments)
    .where(
      and(
        eq(projectInvestments.projectId, projectId),
        eq(projectInvestments.status, 'active'),
      ),
    )
    .execute();
  if (investmentCount.length > 0) {
    blockedReasons.push('El proyecto tiene inversiones activas registradas.');
  }

  // Check for active proxy assignments
  const proxyAssignCount = await db
    .select({ id: outcomeProxyAssignments.id })
    .from(outcomeProxyAssignments)
    .where(
      and(
        eq(outcomeProxyAssignments.projectId, projectId),
        eq(outcomeProxyAssignments.assignmentStatus, 'active'),
      ),
    )
    .execute();
  if (proxyAssignCount.length > 0) {
    blockedReasons.push('El proyecto tiene asignaciones de proxies activas.');
  }

  if (blockedReasons.length > 0) {
    return {
      blocked: true,
      reason: 'El proyecto no puede ser eliminado porque contiene datos críticos.',
      details: blockedReasons,
    };
  }

  return { blocked: false };
}

/** Request project deletion (requires confirmation) */
export async function requestProjectDeletion(
  projectId: string,
  reason: string,
) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');

  const allowedRoles: Role[] = ['super_admin', 'organization_admin'];
  if (!allowedRoles.includes(ctx.membership.role)) {
    throw new Error('Solo administradores pueden solicitar eliminación de proyectos.');
  }

  const eligibility = await validateProjectDeletionEligibility(projectId);
  if (eligibility.blocked) {
    throw new Error(eligibility.details ? eligibility.details.join(' ') : eligibility.reason);
  }

  const project = await getProjectByIdForCurrentOrganization(projectId);
  if (!project) throw new Error('Project not found');

  if (!reason || reason.trim().length === 0) {
    throw new Error('Debe proporcionar un motivo de eliminación.');
  }

  const updated = await db
    .update(projects)
    .set({
      deletionRequestedAt: new Date(),
      deletionRequestedBy: ctx.user.id,
      deletionReason: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)))
    .returning();

  if (updated.length === 0) throw new Error('Failed to update project');

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'project',
    entityId: projectId,
    action: AUDIT_ACTIONS.PROJECT_DELETION_REQUESTED,
    reason,
    afterJson: { deletionRequestedAt: updated[0].deletionRequestedAt, deletionReason: reason },
  });

  return updated[0];
}

/** Approve and execute soft delete (SuperAdmin only) */
export async function approveProjectDeletion(
  projectId: string,
  confirmation: string,
  deleteReason: string,
) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');

  if (ctx.membership.role !== 'super_admin') {
    throw new Error('Solo SuperAdmin puede aprobar eliminaciones de proyectos.');
  }

  if (confirmation !== 'ELIMINAR') {
    throw new Error('Confirmación inválida. Debe escribir "ELIMINAR".');
  }

  const project = await getProjectByIdForCurrentOrganization(projectId);
  if (!project) throw new Error('Project not found');

  if (!project.deletionRequestedAt) {
    throw new Error('No hay solicitud de eliminación activa para este proyecto.');
  }

  const deleted = await db
    .update(projects)
    .set({
      deletedAt: new Date(),
      deletedBy: ctx.user.id,
      deleteReason: deleteReason,
      updatedAt: new Date(),
    })
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)))
    .returning();

  if (deleted.length === 0) throw new Error('Failed to delete project');

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'project',
    entityId: projectId,
    action: AUDIT_ACTIONS.PROJECT_DELETION_APPROVED,
    reason: deleteReason,
    afterJson: { deletedAt: deleted[0].deletedAt, deleteReason: deleteReason },
  });

  return deleted[0];
}

/** Pause a project (move to paused status) */
export async function pauseProject(projectId: string) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');

  const allowedRoles: Role[] = ['super_admin', 'organization_admin', 'impact_manager'];
  if (!allowedRoles.includes(ctx.membership.role)) {
    throw new Error('Permission denied');
  }

  const project = await getProjectByIdForCurrentOrganization(projectId);
  if (!project) throw new Error('Project not found');

  if (!['draft', 'active'].includes(project.status)) {
    throw new Error(`No se puede pausar un proyecto en estado ${project.status}`);
  }

  const updated = await db
    .update(projects)
    .set({
      status: 'paused',
      updatedAt: new Date(),
    })
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)))
    .returning();

  if (updated.length === 0) throw new Error('Failed to pause project');

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'project',
    entityId: projectId,
    action: AUDIT_ACTIONS.PROJECT_PAUSED,
    afterJson: { status: 'paused' },
  });

  return updated[0];
}

/** Resume a paused project */
export async function resumeProject(projectId: string) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');

  const allowedRoles: Role[] = ['super_admin', 'organization_admin', 'impact_manager'];
  if (!allowedRoles.includes(ctx.membership.role)) {
    throw new Error('Permission denied');
  }

  const project = await getProjectByIdForCurrentOrganization(projectId);
  if (!project) throw new Error('Project not found');

  if (project.status !== 'paused') {
    throw new Error('Solo se pueden reanudar proyectos pausados.');
  }

  const updated = await db
    .update(projects)
    .set({
      status: 'active',
      updatedAt: new Date(),
    })
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)))
    .returning();

  if (updated.length === 0) throw new Error('Failed to resume project');

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'project',
    entityId: projectId,
    action: AUDIT_ACTIONS.PROJECT_RESUMED,
    afterJson: { status: 'active' },
  });

  return updated[0];
}

/** Archive a project (read-only, hidden from main dashboard) */
export async function archiveProject(projectId: string) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');

  const allowedRoles: Role[] = ['super_admin', 'organization_admin', 'impact_manager'];
  if (!allowedRoles.includes(ctx.membership.role)) {
    throw new Error('Permission denied');
  }

  const project = await getProjectByIdForCurrentOrganization(projectId);
  if (!project) throw new Error('Project not found');

  if (project.status === 'archived') {
    throw new Error('El proyecto ya está archivado.');
  }

  const updated = await db
    .update(projects)
    .set({
      status: 'archived',
      updatedAt: new Date(),
    })
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)))
    .returning();

  if (updated.length === 0) throw new Error('Failed to archive project');

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'project',
    entityId: projectId,
    action: AUDIT_ACTIONS.PROJECT_ARCHIVED,
    afterJson: { status: 'archived' },
  });

  return updated[0];
}

/** List non-deleted, non-archived projects for current organization */
export async function listActiveProjectsForCurrentOrganization() {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');
  return db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, ctx.organization.id),
        isNull(projects.deletedAt),
        isNull(projects.deletionRequestedAt),
      ),
    );
}

// ---------------------------------------------------------------------------
// Portfolio composition (PORTFOLIO_PF2_EXECUTION_AUTHORITY_v1.0.0.json
// PF2_SEMANTICS_FROZEN). Grouping-only: none of the three writes below touch
// project.status, evidence, or any other Measure object — only
// projects.portfolio_id.
// ---------------------------------------------------------------------------

/**
 * Assign a project to a portfolio. Both must belong to the caller's
 * organization, verified in the same transaction as the write, and the
 * portfolio must not be archived. Only assigns a currently-unassigned
 * project — the WHERE clause's `portfolioId IS NULL` is the guard, not a
 * pre-check, so a concurrent assign cannot silently overwrite another.
 */
export async function assignProjectToPortfolioForCurrentOrganization(projectId: string, portfolioId: string) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');
  if (!canManagePortfolio(ctx.membership.role)) {
    throw new Error('Permission denied');
  }

  const [portfolio] = await db
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.organizationId, ctx.organization.id)));
  if (!portfolio) throw new Error('Portfolio not found');
  if (portfolio.status === 'archived') {
    throw new Error('No se puede asignar un proyecto a un portafolio archivado.');
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organization.id)));
  if (!project) throw new Error('Project not found');

  const updated = await db
    .update(projects)
    .set({ portfolioId, updatedAt: new Date() })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, ctx.organization.id),
        isNull(projects.portfolioId),
      ),
    )
    .returning();

  if (updated.length === 0) {
    throw new Error('El proyecto ya pertenece a un portafolio.');
  }

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'project',
    entityId: projectId,
    action: AUDIT_ACTIONS.PROJECT_PORTFOLIO_ASSIGNED,
    contentModifying: true,
    beforeJson: { portfolioId: project.portfolioId },
    afterJson: { portfolioId },
  });

  return updated[0];
}

/**
 * Unassign a project from a portfolio. The project remains fully intact —
 * only the grouping is removed. Requires the project to currently belong to
 * exactly the given portfolio; a project that has already moved elsewhere
 * refuses rather than silently detaching from wherever it now is.
 */
export async function unassignProjectFromPortfolioForCurrentOrganization(projectId: string, portfolioId: string) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');
  if (!canManagePortfolio(ctx.membership.role)) {
    throw new Error('Permission denied');
  }

  const updated = await db
    .update(projects)
    .set({ portfolioId: null, updatedAt: new Date() })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, ctx.organization.id),
        eq(projects.portfolioId, portfolioId),
      ),
    )
    .returning();

  if (updated.length === 0) {
    throw new Error('El proyecto no pertenece a ese portafolio.');
  }

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'project',
    entityId: projectId,
    action: AUDIT_ACTIONS.PROJECT_PORTFOLIO_UNASSIGNED,
    contentModifying: true,
    beforeJson: { portfolioId },
    afterJson: { portfolioId: null },
  });

  return updated[0];
}

/**
 * Move a project from one portfolio to another — ONE human decision, ONE
 * UPDATE, ONE audit row (never unassign followed by assign: MUT-COMP-1
 * exists to catch exactly that regression). Both portfolios must belong to
 * the caller's organization and the target must not be archived. If the
 * source no longer matches (zero rows updated), the operation is REFUSED —
 * never retried and never silently converted into an assign, so no state
 * exists in which the project belongs to no portfolio.
 */
export async function moveProjectToPortfolioForCurrentOrganization(
  projectId: string,
  sourcePortfolioId: string,
  targetPortfolioId: string,
) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');
  if (!canManagePortfolio(ctx.membership.role)) {
    throw new Error('Permission denied');
  }

  const [sourcePortfolio] = await db
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.id, sourcePortfolioId), eq(portfolios.organizationId, ctx.organization.id)));
  if (!sourcePortfolio) throw new Error('Source portfolio not found');

  const [targetPortfolio] = await db
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.id, targetPortfolioId), eq(portfolios.organizationId, ctx.organization.id)));
  if (!targetPortfolio) throw new Error('Target portfolio not found');
  if (targetPortfolio.status === 'archived') {
    throw new Error('No se puede mover un proyecto a un portafolio archivado.');
  }

  const updated = await db
    .update(projects)
    .set({ portfolioId: targetPortfolioId, updatedAt: new Date() })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, ctx.organization.id),
        eq(projects.portfolioId, sourcePortfolioId),
      ),
    )
    .returning();

  if (updated.length === 0) {
    throw new Error('El proyecto ya no pertenece al portafolio de origen.');
  }

  await logAuditAction({
    organizationId: ctx.organization.id,
    projectId,
    actorUserId: ctx.user.id,
    entityType: 'project',
    entityId: projectId,
    action: AUDIT_ACTIONS.PROJECT_PORTFOLIO_MOVED,
    contentModifying: true,
    beforeJson: { portfolioId: sourcePortfolioId },
    afterJson: { portfolioId: targetPortfolioId },
  });

  return updated[0];
}
