import { db } from '@/db/client';
import { portfolios } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { logAuditAction } from '@/lib/audit/logger';
import { z } from 'zod';
import type { Role } from '@/lib/auth/roles';


// Validation schema
const PortfolioInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['active', 'archived']).default('active'),
});

type PortfolioInput = z.input<typeof PortfolioInputSchema>;

/** List all portfolios for the current organization */
export async function listPortfoliosForCurrentOrganization() {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');
  return db.select().from(portfolios).where(eq(portfolios.organizationId, ctx.organization.id));
}

/** Get a portfolio by ID, scoped to the current org */
export async function getPortfolioByIdForCurrentOrganization(id: string) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) return null;
  const rows = await db
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.id, id), eq(portfolios.organizationId, ctx.organization.id)));
  return rows[0] ?? null;
}

/** Create a portfolio, verifying role and logging */
export async function createPortfolioForCurrentOrganization(input: PortfolioInput) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) throw new Error('Unauthenticated');
  const allowedRoles: Role[] = ['super_admin', 'organization_admin', 'impact_manager', 'analyst'];
  if (!allowedRoles.includes(ctx.membership.role)) {
    throw new Error('Permission denied');
  }
  const data = PortfolioInputSchema.parse(input);
  const [newRecord] = await db
    .insert(portfolios)
    .values({
      id: crypto.randomUUID(),
      organizationId: ctx.organization.id,
      name: data.name,
      description: data.description ?? null,
      status: data.status,
      createdBy: ctx.user.id,
    })
    .returning();

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'portfolio',
    entityId: newRecord.id,
    action: 'create',
    afterJson: data,
  });

  return newRecord;
}
