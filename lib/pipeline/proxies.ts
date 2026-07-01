// lib/pipeline/proxies.ts

import { db } from '@/db/client';
import { proxySources, financialProxies, outcomeProxyAssignments, projects, outcomes } from '@/db/schema';
import { eq, and, or, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { requireOrganizationAccess, getCurrentOrganizationContext } from '@/lib/auth/session';
import { canApproveProxy } from '@/lib/auth/permissions';
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger';

/*** Validation schemas ***/
const ProxySourceInput = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  url: z.string().url().optional(),
});

const FinancialProxyInput = z.object({
  sourceId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  proxyType: z.string().optional(),
  country: z.string().length(2).optional(),
  territory: z.string().optional(),
  currency: z.string().min(1),
  value: z.string().refine((v) => !isNaN(Number(v)), { message: 'value must be numeric' }),
  unit: z.string().min(1),
  referenceYear: z.number().int().positive(),
  thematicArea: z.string().optional(),
  methodology: z.string().optional(),
  confidenceLevel: z.enum(['high', 'medium', 'low']).optional(),
  methodologicalRisk: z.enum(['low', 'medium', 'high']).optional(),
});

const ProxyAssignmentInput = z.object({
  outcomeId: z.string().uuid(),
  proxyId: z.string().uuid(),
  justification: z.string().min(1),
  territorialAdjustmentNotes: z.string().optional(),
});

/*** Service functions ***/
export async function listProxySources() {
  const ctx = await getCurrentOrganizationContext();
  const query = db.select().from(proxySources);
  if (!ctx) {
    return query.where(and(isNull(proxySources.organizationId), eq(proxySources.status, 'active')));
  }
  return query.where(
    or(
      and(isNull(proxySources.organizationId), eq(proxySources.status, 'active')),
      eq(proxySources.organizationId, ctx.organization.id)
    )
  );
}

export async function createOrganizationProxySource(input: unknown) {
  const ctx = await requireOrganizationAccess();
  const data = ProxySourceInput.parse(input);
  const row = await db.insert(proxySources).values({
    organizationId: ctx.organization.id,
    name: data.name,
    description: data.description,
    url: data.url,
    status: 'active',
    createdBy: ctx.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning().then(r => r[0]);

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'proxy_source',
    entityId: row.id,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    afterJson: row,
  });
  return row;
}

export async function updateOrganizationProxySource(sourceId: string, input: unknown) {
  const ctx = await requireOrganizationAccess();
  const data = ProxySourceInput.partial().parse(input);
  const source = await db.select().from(proxySources).where(eq(proxySources.id, sourceId)).then(r => r[0]);
  if (!source) throw new Error('Source not found');
  if (source.organizationId && source.organizationId !== ctx.organization.id) throw new Error('Forbidden');
  if (!source.organizationId && !ctx.user.isSuperAdmin) throw new Error('Forbidden');

  const updated = await db.update(proxySources).set({
    ...data,
    updatedAt: new Date(),
  }).where(eq(proxySources.id, sourceId)).returning().then(r => r[0]);

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'proxy_source',
    entityId: sourceId,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    beforeJson: source,
    afterJson: updated,
  });
  return updated;
}

export async function archiveProxySource(sourceId: string) {
  const ctx = await requireOrganizationAccess();
  const source = await db.select().from(proxySources).where(eq(proxySources.id, sourceId)).then(r => r[0]);
  if (!source) throw new Error('Source not found');
  if (source.organizationId && source.organizationId !== ctx.organization.id) throw new Error('Forbidden');
  if (!source.organizationId && !ctx.user.isSuperAdmin) throw new Error('Forbidden');

  const updated = await db.update(proxySources).set({ status: 'archived', updatedAt: new Date() })
    .where(eq(proxySources.id, sourceId))
    .returning().then(r => r[0]);

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'proxy_source',
    entityId: sourceId,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    beforeJson: source,
    afterJson: updated,
  });
  return updated;
}

// Financial proxies ----------------------------------------------------------
export async function listFinancialProxies() {
  const ctx = await getCurrentOrganizationContext();
  const base = db.select().from(financialProxies);
  if (!ctx) {
    return base.where(and(isNull(financialProxies.organizationId), eq(financialProxies.reviewStatus, 'approved')));
  }
  return base.where(
    or(
      and(isNull(financialProxies.organizationId), eq(financialProxies.reviewStatus, 'approved')),
      eq(financialProxies.organizationId, ctx.organization.id)
    )
  );
}

export async function getFinancialProxyById(proxyId: string) {
  const ctx = await getCurrentOrganizationContext();
  const proxy = await db.select().from(financialProxies).where(eq(financialProxies.id, proxyId)).then(r => r[0]);
  if (!proxy) return null;
  if (proxy.organizationId) {
    if (!ctx || proxy.organizationId !== ctx.organization.id) return null;
  } else {
    if (proxy.reviewStatus !== 'approved') return null;
  }
  return proxy;
}

export async function createOrganizationFinancialProxy(input: unknown) {
  const ctx = await requireOrganizationAccess();
  const data = FinancialProxyInput.parse(input);
  const row = await db.insert(financialProxies).values({
    organizationId: ctx.organization.id,
    sourceId: data.sourceId,
    name: data.name,
    description: data.description,
    proxyType: data.proxyType,
    country: data.country,
    territory: data.territory,
    currency: data.currency,
    value: data.value,
    unit: data.unit,
    referenceYear: data.referenceYear,
    thematicArea: data.thematicArea,
    methodology: data.methodology,
    confidenceLevel: data.confidenceLevel,
    methodologicalRisk: data.methodologicalRisk,
    reviewStatus: 'suggested',
    createdBy: ctx.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning().then(r => r[0]);

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'financial_proxy',
    entityId: row.id,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    afterJson: row,
  });
  return row;
}

export async function updateOrganizationFinancialProxy(proxyId: string, input: unknown) {
  const ctx = await requireOrganizationAccess();
  const data = FinancialProxyInput.partial().parse(input);
  const proxy = await db.select().from(financialProxies).where(eq(financialProxies.id, proxyId)).then(r => r[0]);
  if (!proxy) throw new Error('Proxy not found');
  if (proxy.organizationId !== ctx.organization.id) throw new Error('Forbidden');

  const updated = await db.update(financialProxies).set({
    ...data,
    updatedAt: new Date(),
  }).where(eq(financialProxies.id, proxyId)).returning().then(r => r[0]);

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'financial_proxy',
    entityId: proxyId,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    beforeJson: proxy,
    afterJson: updated,
  });
  return updated;
}

export async function updateFinancialProxyReviewStatus(proxyId: string, newStatus: string) {
  const ctx = await requireOrganizationAccess();
  const allowed = ['suggested', 'pending_review', 'approved', 'rejected', 'archived'];
  if (!allowed.includes(newStatus)) throw new Error('Invalid status');
  const proxy = await db.select().from(financialProxies).where(eq(financialProxies.id, proxyId)).then(r => r[0]);
  if (!proxy) throw new Error('Proxy not found');
  if (proxy.organizationId && proxy.organizationId !== ctx.organization.id) throw new Error('Forbidden');
  if (!proxy.organizationId && !ctx.user.isSuperAdmin) throw new Error('Forbidden');
  if (!canApproveProxy(ctx.membership.role) && !ctx.user.isSuperAdmin) throw new Error('Forbidden');
  if (newStatus === 'approved') {
    const required = ['value', 'currency', 'unit', 'referenceYear'];
    for (const f of required) {
      if (!proxy[f as keyof typeof proxy]) throw new Error(`Cannot approve without ${f}`);
    }
  }
  const updated = await db.update(financialProxies).set({ reviewStatus: newStatus, updatedAt: new Date() })
    .where(eq(financialProxies.id, proxyId))
    .returning().then(r => r[0]);

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'financial_proxy',
    entityId: proxyId,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    beforeJson: proxy,
    afterJson: updated,
  });
  return updated;
}

export async function archiveFinancialProxy(proxyId: string) {
  const ctx = await requireOrganizationAccess();
  const proxy = await db.select().from(financialProxies).where(eq(financialProxies.id, proxyId)).then(r => r[0]);
  if (!proxy) throw new Error('Proxy not found');
  if (proxy.organizationId !== ctx.organization.id) throw new Error('Forbidden');
  const updated = await db.update(financialProxies).set({ reviewStatus: 'archived', updatedAt: new Date() })
    .where(eq(financialProxies.id, proxyId))
    .returning().then(r => r[0]);

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'financial_proxy',
    entityId: proxyId,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    beforeJson: proxy,
    afterJson: updated,
  });
  return updated;
}

// Assignments ---------------------------------------------------------------
export async function listProxyAssignmentsForProject(projectId: string) {
  const ctx = await getCurrentOrganizationContext();
  if (!ctx) return [];
  return db.select().from(outcomeProxyAssignments)
    .where(and(eq(outcomeProxyAssignments.projectId, projectId), eq(outcomeProxyAssignments.organizationId, ctx.organization.id)));
}

export async function assignProxyToOutcome(projectId: string, input: unknown) {
  const ctx = await requireOrganizationAccess();
  const data = ProxyAssignmentInput.parse(input);
  // Verify project belongs to the user's organization
  const project = await db.select().from(projects).where(eq(projects.id, projectId)).then(r => r[0]);
  if (!project || project.organizationId !== ctx.organization.id) throw new Error('Project not found or forbidden');
  // Verify outcome belongs to the same project
  const outcome = await db.select().from(outcomes).where(eq(outcomes.id, data.outcomeId)).then(r => r[0]);
  if (!outcome || outcome.projectId !== projectId) throw new Error('Outcome not found or forbidden');
  // Verify proxy visibility
  const proxy = await getFinancialProxyById(data.proxyId);
  if (!proxy) throw new Error('Proxy not visible');
  if (proxy.organizationId && proxy.organizationId !== ctx.organization.id) {
    // proxy belongs to another organization and is not a system proxy approved
    if (proxy.reviewStatus !== 'approved') throw new Error('Proxy not visible');
  } else if (!proxy.organizationId && proxy.reviewStatus !== 'approved') {
    throw new Error('System proxy not approved');
  }
  // Ensure justification is provided (already validated by Zod)

  const row = await db.insert(outcomeProxyAssignments).values({
    projectId,
    organizationId: ctx.organization.id,
    outcomeId: data.outcomeId,
    proxyId: data.proxyId,
    justification: data.justification,
    territorialAdjustmentNotes: data.territorialAdjustmentNotes,
    assignedBy: ctx.user.id,
    assignedAt: new Date(),
  }).returning().then(r => r[0]);

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'proxy_assignment',
    entityId: row.id,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    afterJson: row,
  });
  return row;
}

export async function archiveOutcomeProxyAssignment(projectId: string, assignmentId: string) {
  const ctx = await requireOrganizationAccess();
  const assignment = await db.select().from(outcomeProxyAssignments)
    .where(eq(outcomeProxyAssignments.id, assignmentId))
    .then(r => r[0]);
  if (!assignment) throw new Error('Assignment not found');
  if (assignment.projectId !== projectId || assignment.organizationId !== ctx.organization.id) throw new Error('Forbidden');
  // Logical archive instead of hard delete
  const updated = await db.update(outcomeProxyAssignments)
    .set({
      assignmentStatus: 'archived',
      archivedBy: ctx.user.id,
      archivedAt: new Date(),
    })
    .where(eq(outcomeProxyAssignments.id, assignmentId))
    .returning()
    .then(r => r[0]);
  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'proxy_assignment',
    entityId: assignmentId,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    beforeJson: assignment,
    afterJson: updated,
  });
  return true;}
