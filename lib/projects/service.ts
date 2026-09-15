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
import { eq, and, inArray, isNotNull, isNull } from 'drizzle-orm';
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

// ---------------------------------------------------------------------------
// Organization-level Measure progress (LANE CV1-MEASURE-W3).
//
// F-MEASURE-W3-1 — getSroiCalculationReadiness/blockingReasons is REJECTED as
// the source for this surface. Its authorize() gate
// (lib/pipeline/sroi-calculation.ts) requires hasRole(role, 'analyst'), so it
// throws 'Insufficient role' for `reviewer` (20) and `viewer` (10). This lane's
// contract requires authorized read-only users to see progress, so a source
// that is not role-universal cannot define it. Calling it only for privileged
// roles was rejected too: that would make "where is this project in Measure"
// mean two different things depending on who is looking.
//
// Everything below therefore derives from persisted artifacts that every
// organization member can already read through the existing org-scoped access
// model — SROI runs, run reviews, reports, and the project's own lifecycle
// columns. No readiness model is recomputed here, no percentage is synthesized,
// and no permission is consulted: the read-only progress source IS the
// privileged progress source, because there is only one derivation.
// ---------------------------------------------------------------------------

export type MeasureProgressState =
  | 'sin_iniciar'
  | 'en_progreso'
  | 'listo_para_revision'
  | 'en_revision'
  | 'aprobado'
  | 'completado'
  | 'bloqueado';

/** Badge variants available in components/ui/badge.tsx. */
type MeasureProgressVariant = 'neutral' | 'info' | 'success' | 'warning' | 'accent';

/**
 * The persisted facts the ladder reads. Every field is a plain column value or
 * an existence check over a governed table — never a computed readiness score.
 */
export interface MeasureProgressFacts {
  /** projects.status */
  status: string;
  /** projects.deletion_requested_at */
  deletionRequestedAt: Date | string | null;
  /** >= 1 sroi_calculation_runs row with status = 'calculated' */
  hasCalculatedRun: boolean;
  /** >= 1 sroi_run_reviews row with status = 'approved' */
  hasApprovedReview: boolean;
  /** >= 1 sroi_run_reviews row still in play: draft | reviewed | flagged */
  hasOpenReview: boolean;
  /** >= 1 sroi_reports row with status = 'locked' */
  hasLockedReport: boolean;
}

export interface MeasureProgress {
  state: MeasureProgressState;
  /** Spanish label, drawn from vocabulary already used in the pipeline UI. */
  label: string;
  variant: MeasureProgressVariant;
  /** What a human should do next. Never a mutation — always navigation. */
  nextActionLabel: string;
  /**
   * Path suffix appended to `/app/projects/<id>`. Kept id-free so the ladder
   * stays a pure function of the facts and can be unit-tested without a route.
   * The empty string means "no navigable next action".
   */
  nextActionPath: string;
}

/**
 * Derive one Measure state from persisted facts. Pure: no db, no session, no
 * role. The branch order below is the whole contract, so it is spelled out
 * rather than expressed as a lookup table.
 *
 * `completado` outranks `bloqueado` deliberately. A locked report is an
 * immutable terminal artifact; pausing or requesting deletion of the project
 * afterwards does not reopen Measure, so reporting such a project as blocked
 * would be false.
 *
 * A review with status 'archived' counts as NEITHER approved nor open — an
 * archived review has been withdrawn, so it must not hold a project in
 * `en_revision` forever.
 */
export function deriveMeasureProgress(facts: MeasureProgressFacts): MeasureProgress {
  if (facts.hasLockedReport) {
    return {
      state: 'completado',
      label: 'Completado',
      variant: 'success',
      nextActionLabel: 'Ver reporte',
      nextActionPath: '/report',
    };
  }

  // The only two blocking conditions are persisted lifecycle facts already
  // represented on the project row. No readiness predicate is reimplemented.
  if (facts.deletionRequestedAt !== null && facts.deletionRequestedAt !== undefined) {
    return {
      state: 'bloqueado',
      label: 'Bloqueado',
      variant: 'warning',
      nextActionLabel: 'Eliminación solicitada — requiere resolución',
      nextActionPath: '',
    };
  }
  if (facts.status === 'paused') {
    return {
      state: 'bloqueado',
      label: 'Bloqueado',
      variant: 'warning',
      nextActionLabel: 'Proyecto en pausa — reanudar para continuar',
      nextActionPath: '',
    };
  }

  if (facts.hasApprovedReview) {
    return {
      state: 'aprobado',
      label: 'Aprobado',
      variant: 'success',
      nextActionLabel: 'Generar reporte',
      nextActionPath: '/report',
    };
  }
  if (facts.hasOpenReview) {
    return {
      state: 'en_revision',
      label: 'En revisión',
      variant: 'info',
      nextActionLabel: 'Continuar revisión',
      nextActionPath: '/pipeline/calculation',
    };
  }
  if (facts.hasCalculatedRun) {
    return {
      state: 'listo_para_revision',
      label: 'Listo para revisión',
      variant: 'accent',
      nextActionLabel: 'Revisar cálculo',
      nextActionPath: '/pipeline/calculation',
    };
  }

  // No calculated run yet. `draft` vs anything else is the existing persisted
  // lifecycle distinction between "nobody has started" and "work is underway";
  // it costs no extra query and invents no new state.
  if (facts.status === 'draft') {
    return {
      state: 'sin_iniciar',
      label: 'Sin iniciar',
      variant: 'neutral',
      nextActionLabel: 'Comenzar con Narrativa',
      nextActionPath: '/pipeline/narrative',
    };
  }
  return {
    state: 'en_progreso',
    label: 'En progreso',
    variant: 'info',
    nextActionLabel: 'Continuar pipeline',
    nextActionPath: '/pipeline',
  };
}

export type ProjectWithMeasureProgress = Awaited<
  ReturnType<typeof listProjectsForCurrentOrganization>
>[number] & {
  measureProgress: MeasureProgress;
  /** projects.portfolio_id IS NULL. Informational only — see F-MEASURE-W3-2. */
  unassignedToPortfolio: boolean;
};

/**
 * Every project of the current organization, each carrying its Measure state.
 *
 * F-MEASURE-W3-2 — the project set comes from listProjectsForCurrentOrganization
 * verbatim, which filters on organization_id ALONE. Reusing it rather than
 * re-issuing a second query is the point: there is exactly one place a
 * portfolio predicate could ever be introduced, so a project with
 * portfolio_id IS NULL cannot silently fall out of one surface but not the
 * other. `unassignedToPortfolio` only makes that already-correct state
 * observable; it changes no filtering, no ordering and no portfolio membership.
 *
 * Cost is three set-based queries for the WHOLE organization, not per project.
 * Each is correlated on organization_id on its own side as well as being
 * restricted to this organization's project ids — the org correlation is
 * required on both sides, never only on the project side.
 */
export async function listProjectsWithMeasureProgressForCurrentOrganization(): Promise<
  ProjectWithMeasureProgress[]
> {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');

  const rows = await listProjectsForCurrentOrganization();
  const projectIds = rows.map((p) => p.id);
  if (projectIds.length === 0) return [];

  const [calculatedRuns, reviewRows, reportRows] = await Promise.all([
    db
      .select({ projectId: sroiCalculationRuns.projectId })
      .from(sroiCalculationRuns)
      .where(
        and(
          inArray(sroiCalculationRuns.projectId, projectIds),
          eq(sroiCalculationRuns.organizationId, ctx.organization.id),
          eq(sroiCalculationRuns.status, 'calculated'),
        ),
      ),
    db
      .select({ projectId: sroiRunReviews.projectId, status: sroiRunReviews.status })
      .from(sroiRunReviews)
      .where(
        and(
          inArray(sroiRunReviews.projectId, projectIds),
          eq(sroiRunReviews.organizationId, ctx.organization.id),
        ),
      ),
    db
      .select({ projectId: sroiReports.projectId, status: sroiReports.status })
      .from(sroiReports)
      .where(
        and(
          inArray(sroiReports.projectId, projectIds),
          eq(sroiReports.organizationId, ctx.organization.id),
        ),
      ),
  ]);

  const withCalculatedRun = new Set(calculatedRuns.map((r) => r.projectId));
  const withApprovedReview = new Set<string>();
  const withOpenReview = new Set<string>();
  for (const review of reviewRows) {
    if (review.status === 'approved') withApprovedReview.add(review.projectId);
    else if (review.status !== 'archived') withOpenReview.add(review.projectId);
  }
  const withLockedReport = new Set(
    reportRows.filter((r) => r.status === 'locked').map((r) => r.projectId),
  );

  return rows.map((project) => ({
    ...project,
    measureProgress: deriveMeasureProgress({
      status: project.status,
      deletionRequestedAt: project.deletionRequestedAt,
      hasCalculatedRun: withCalculatedRun.has(project.id),
      hasApprovedReview: withApprovedReview.has(project.id),
      hasOpenReview: withOpenReview.has(project.id),
      hasLockedReport: withLockedReport.has(project.id),
    }),
    unassignedToPortfolio: project.portfolioId === null,
  }));
}
