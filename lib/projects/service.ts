import { db } from '@/db/client';
import { projects, portfolios } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { logAuditAction } from '@/lib/audit/logger';
import { z } from 'zod';
import type { Role } from '@/lib/auth/roles';
// import { hasRole } from '@/lib/auth/permissions'; // removed unused import

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
    })
    .returning();

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'project',
    entityId: newRecord.id,
    action: 'create',
    afterJson: data,
  });

  return newRecord;
}
