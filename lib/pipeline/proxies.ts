// lib/pipeline/proxies.ts

import { db } from '@/db/client';
import { proxySources, financialProxies, outcomeProxyAssignments, projects, outcomes } from '@/db/schema';
import { eq, and, or, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import '@/lib/pipeline/decimal-config';
import { requireOrganizationAccess, getCurrentOrganizationContext } from '@/lib/auth/session';
import { canApproveProxy } from '@/lib/auth/permissions';
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger';
import { getOrCreateSharedCopRate, convertToUsd, type FxRateExecutor } from '@/lib/pipeline/fx';

type FinancialProxyRow = typeof financialProxies.$inferSelect;
type FinancialProxyTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const APPROVAL_STATE_VERSION = 'financial-proxy-approval-state/v1';
const APPROVAL_STATE_FINGERPRINT_RE = /^[a-f0-9]{64}$/;

type FinancialProxyApprovalState = Pick<
  FinancialProxyRow,
  | 'id'
  | 'organizationId'
  | 'sourceId'
  | 'value'
  | 'currency'
  | 'unit'
  | 'referenceYear'
  | 'valueUsd'
  | 'fxRateId'
  | 'reviewStatus'
>;

function canonicalDecimal(value: string | null | undefined): string | null {
  if (value == null) return null;
  return new Decimal(value).toFixed();
}

/** A stable, approval-material-only identity for the proxy state a human saw. */
export function fingerprintFinancialProxyApprovalState(proxy: FinancialProxyApprovalState): string {
  const canonicalState = JSON.stringify([
    APPROVAL_STATE_VERSION,
    proxy.id,
    proxy.organizationId,
    proxy.sourceId,
    canonicalDecimal(proxy.value),
    proxy.currency,
    proxy.unit,
    proxy.referenceYear,
    canonicalDecimal(proxy.valueUsd),
    proxy.fxRateId,
    proxy.reviewStatus,
  ]);
  return createHash('sha256').update(canonicalState, 'utf8').digest('hex');
}

function assertExpectedApprovalState(expectedApprovalState: string | undefined): asserts expectedApprovalState is string {
  if (expectedApprovalState === undefined || expectedApprovalState.length === 0) {
    throw new Error('Expected approval state is required');
  }
  if (!APPROVAL_STATE_FINGERPRINT_RE.test(expectedApprovalState)) {
    throw new Error('Expected approval state is malformed');
  }
}

/**
 * Serializes every material proxy lifecycle transition on the proxy row itself.
 *
 * A plain read followed by an update is not enough: an edit and approval can
 * both read V1, then write different pieces of authority over the current V2
 * row. The callback receives the exact row locked by this transaction, so a
 * caller must derive USD/FX and commit its state transition from that same
 * authoritative material state.
 */
export async function withLockedFinancialProxy<T>(
  proxyId: string,
  transition: (tx: FinancialProxyTransaction, proxy: FinancialProxyRow) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const proxy = await tx
      .select()
      .from(financialProxies)
      .where(eq(financialProxies.id, proxyId))
      .for('update')
      .then((rows) => rows[0] ?? null);
    if (!proxy) throw new Error('Proxy not found');
    return transition(tx, proxy);
  });
}

/**
 * Locks the proxy before proving that the human-reviewed state still exists.
 * The expected fingerprint is intentionally not an authorization credential;
 * the caller keeps the role and tenancy checks in `authorize`.
 */
export async function withExpectedLockedFinancialProxy<T>(
  proxyId: string,
  expectedApprovalState: string | undefined,
  authorize: (tx: FinancialProxyTransaction, proxy: FinancialProxyRow) => Promise<void> | void,
  transition: (tx: FinancialProxyTransaction, proxy: FinancialProxyRow) => Promise<T>,
): Promise<T> {
  assertExpectedApprovalState(expectedApprovalState);
  return withLockedFinancialProxy(proxyId, async (tx, proxy) => {
    await authorize(tx, proxy);
    if (fingerprintFinancialProxyApprovalState(proxy) !== expectedApprovalState) {
      throw new Error('Approval state is stale');
    }
    return transition(tx, proxy);
  });
}

// Fase 1b — an approved proxy must resolve to USD (value_usd) so the calc's two
// sides normalize. USD passes through; COP auto-fetches the TRM (Dec 31 of the
// reference year); any other currency needs a manual rate (1c) and cannot be
// auto-approved yet.
export async function resolveProxyValueUsd(proxy: {
  value: string | null
  currency: string | null
  referenceYear: number | null
  valueUsd: string | null
  fxRateId: string | null
}, executor: FxRateExecutor = db): Promise<{ valueUsd: string; fxRateId: string | null }> {
  if (proxy.valueUsd) return { valueUsd: proxy.valueUsd, fxRateId: proxy.fxRateId }
  if (!proxy.value) throw new Error('Cannot resolve USD value without a value')
  if (proxy.currency === 'USD') return { valueUsd: proxy.value, fxRateId: null }
  if (proxy.currency === 'COP') {
    const date = proxy.referenceYear ? `${proxy.referenceYear}-12-31` : new Date().toISOString().slice(0, 10)
    const rate = await getOrCreateSharedCopRate(date, executor)
    if (!rate?.rateToUsd) throw new Error('Cannot approve: COP→USD rate unavailable for the reference year')
    return { valueUsd: convertToUsd(proxy.value, rate.rateToUsd), fxRateId: rate.id }
  }
  throw new Error('Cannot approve a non-USD/COP proxy without a manual USD conversion')
}

/** Validates and derives the monetary authority for a currently locked approval. */
export async function deriveApprovedProxyAuthority(
  tx: FinancialProxyTransaction,
  proxy: FinancialProxyRow,
): Promise<{ valueUsd: string; fxRateId: string | null }> {
  const { value, currency, unit, referenceYear } = proxy;
  if (!value) throw new Error('Cannot approve without value');
  if (!currency) throw new Error('Cannot approve without currency');
  if (!unit) throw new Error('Cannot approve without unit');
  if (!referenceYear) throw new Error('Cannot approve without referenceYear');
  const decimalValue = new Decimal(value);
  if (!decimalValue.isFinite() || decimalValue.lte(0)) {
    throw new Error('Cannot approve a proxy with a non-positive value');
  }
  return resolveProxyValueUsd(proxy, tx);
}

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
    action: AUDIT_ACTIONS.PROXY_SOURCE_CREATED,
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
  // System sources (organizationId: null) are managed exclusively via
  // lib/admin/proxies.ts (requireAdminAccess(), no org context needed) —
  // never through this org-scoped path. A caller who reaches this function
  // already passed requireOrganizationAccess(), which redirects a
  // super_admin with no org membership away before it ever runs, so an
  // isSuperAdmin bypass here was unreachable for that case and would only
  // ever fire for a super_admin who also happens to be an org member —
  // not a case this function should special-case.
  if (!source.organizationId) throw new Error('Forbidden');

  const updated = await db.update(proxySources).set({
    ...data,
    updatedAt: new Date(),
  }).where(eq(proxySources.id, sourceId)).returning().then(r => r[0]);

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'proxy_source',
    entityId: sourceId,
    action: AUDIT_ACTIONS.PROXY_SOURCE_UPDATED,
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
  // See updateOrganizationProxySource above — system sources go through
  // lib/admin/proxies.ts only.
  if (!source.organizationId) throw new Error('Forbidden');

  const updated = await db.update(proxySources).set({ status: 'archived', updatedAt: new Date() })
    .where(eq(proxySources.id, sourceId))
    .returning().then(r => r[0]);

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'proxy_source',
    entityId: sourceId,
    action: AUDIT_ACTIONS.PROXY_SOURCE_ARCHIVED,
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

/**
 * Ownership gate for a caller-supplied proxy_source id (RC-12, reaudit M5).
 *
 * A source is usable by the caller's organisation ONLY when it is
 *   * owned by that organisation, or
 *   * a global/system source (organizationId NULL) that is active.
 *
 * The read runs inside the caller's identity context, and the refusal is
 * UNIFORM: a source that does not exist and a source owned by another
 * organisation produce the same error, so the endpoint cannot be used as an
 * existence oracle for other tenants' catalog.
 */
async function requireUsableProxySource(sourceId: string, organizationId: string) {
  const source = await db.select().from(proxySources).where(eq(proxySources.id, sourceId)).then(r => r[0]);
  const usable =
    source !== undefined &&
    (source.organizationId === organizationId ||
      (source.organizationId === null && source.status === 'active'));
  if (!usable) throw new Error('Source not found');
  return source;
}

export async function createOrganizationFinancialProxy(input: unknown) {
  const ctx = await requireOrganizationAccess();
  const data = FinancialProxyInput.parse(input);
  // The organisation NEVER comes from the input — only from the session — and
  // the named source must be usable by that organisation.
  await requireUsableProxySource(data.sourceId, ctx.organization.id);
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
    action: AUDIT_ACTIONS.FINANCIAL_PROXY_CREATED,
    afterJson: row,
  });
  return row;
}

// Fields whose change invalidates a prior human approval: an approved proxy
// whose value/currency/unit/reference year is edited no longer reflects what
// the reviewer signed off on, so its review status is reset.
const PROXY_MATERIAL_FIELDS = ['sourceId', 'value', 'currency', 'unit', 'referenceYear'] as const;

// CL-2B (PROX-01) — subset of PROXY_MATERIAL_FIELDS that resolveProxyValueUsd
// actually derives from (value, currency, and referenceYear for the COP TRM
// lookup date). `unit` is material to the review — it changes what the value
// MEANS — but not to the USD figure itself, so it alone must not force a
// pointless FX re-fetch.
const PROXY_USD_DERIVATION_FIELDS = ['value', 'currency', 'referenceYear'] as const;

export async function updateOrganizationFinancialProxy(proxyId: string, input: unknown) {
  const ctx = await requireOrganizationAccess();
  const data = FinancialProxyInput.partial().parse(input);
  const { proxy, updated, resetReview } = await withLockedFinancialProxy(proxyId, async (tx, proxy) => {
    if (proxy.organizationId !== ctx.organization.id) throw new Error('Forbidden');
    // A partial update may repoint the proxy at another source — the same
    // ownership gate as creation applies (RC-12).
    if (data.sourceId !== undefined) {
      await requireUsableProxySource(data.sourceId, ctx.organization.id);
    }

    // Re-review gate: if an approved proxy's material fields change, drop it back
    // to pending_review so no calculation uses an unreviewed value under an
    // "approved" label.
    const materialChange = PROXY_MATERIAL_FIELDS.some(
      (f) => data[f] !== undefined && String(data[f]) !== String(proxy[f] ?? '')
    );
    const resetReview = proxy.reviewStatus === 'approved' && materialChange;

    // CL-2B/CL-2C (PROX-01) — a change to value/currency/referenceYear makes the
    // previously frozen valueUsd/fxRateId stale: they were derived from the OLD
    // material state. Null them out here so resolveProxyValueUsd's short-circuit
    // (`if (proxy.valueUsd) return ...`) cannot reuse the stale figure on the
    // next approval — that call is forced back through the real value/currency
    // → USD derivation with the CURRENT data instead.
    const usdDerivationChange = PROXY_USD_DERIVATION_FIELDS.some(
      (f) => data[f] !== undefined && String(data[f]) !== String(proxy[f] ?? '')
    );

    const updated = await tx.update(financialProxies).set({
      ...data,
      ...(resetReview ? { reviewStatus: 'pending_review' as const } : {}),
      ...(usdDerivationChange ? { valueUsd: null, fxRateId: null } : {}),
      updatedAt: new Date(),
    }).where(eq(financialProxies.id, proxyId)).returning().then(r => r[0]);
    return { proxy, updated, resetReview };
  });

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'financial_proxy',
    entityId: proxyId,
    action: resetReview
      ? AUDIT_ACTIONS.FINANCIAL_PROXY_REVIEW_STATUS_CHANGED
      : AUDIT_ACTIONS.FINANCIAL_PROXY_UPDATED,
    reason: resetReview ? 'Approval reset: material field changed after approval' : undefined,
    beforeJson: proxy,
    afterJson: updated,
  });
  return updated;
}

export async function updateFinancialProxyReviewStatus(
  proxyId: string,
  newStatus: string,
  expectedApprovalState?: string,
) {
  const ctx = await requireOrganizationAccess();
  const allowed = ['suggested', 'pending_review', 'approved', 'rejected', 'archived'];
  if (!allowed.includes(newStatus)) throw new Error('Invalid status');
  const transition = async (tx: FinancialProxyTransaction, proxy: FinancialProxyRow) => {
    if (proxy.organizationId && proxy.organizationId !== ctx.organization.id) throw new Error('Forbidden');
    // System proxies (organizationId: null) are reviewed/approved exclusively
    // via lib/admin/proxies.ts — see updateOrganizationProxySource above for
    // why an isSuperAdmin bypass here was dead code, not a working escape
    // hatch.
    if (!proxy.organizationId) throw new Error('Forbidden');
    if (!canApproveProxy(ctx.membership.role)) throw new Error('Forbidden');
    const usdFields = newStatus === 'approved'
      ? await deriveApprovedProxyAuthority(tx, proxy)
      : {};
    const updated = await tx.update(financialProxies).set({ reviewStatus: newStatus, ...usdFields, updatedAt: new Date() })
      .where(eq(financialProxies.id, proxyId))
      .returning().then(r => r[0]);
    return { proxy, updated };
  };

  const result = newStatus === 'approved'
    ? await withExpectedLockedFinancialProxy(proxyId, expectedApprovalState, async (_tx, proxy) => {
      if (proxy.organizationId !== ctx.organization.id) throw new Error('Forbidden');
      if (!canApproveProxy(ctx.membership.role)) throw new Error('Forbidden');
    }, transition)
    : await withLockedFinancialProxy(proxyId, transition);
  const { proxy, updated } = result;

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'financial_proxy',
    entityId: proxyId,
    action: AUDIT_ACTIONS.FINANCIAL_PROXY_REVIEW_STATUS_CHANGED,
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
    action: AUDIT_ACTIONS.FINANCIAL_PROXY_ARCHIVED,
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
  // Verify proxy visibility. getFinancialProxyById already returns null for
  // any proxy owned by another org (only org-owned-by-caller or approved
  // system proxies are ever returned), so no further org-mismatch check is
  // needed here — only the system-proxy approval status remains to check.
  const proxy = await getFinancialProxyById(data.proxyId);
  if (!proxy) throw new Error('Proxy not visible');
  if (!proxy.organizationId && proxy.reviewStatus !== 'approved') {
    throw new Error('System proxy not approved');
  }
  // Ensure justification is provided (already validated by Zod)

  // Prevent duplicate active assignments of the same proxy to the same outcome:
  // two identical active rows would be double-counted by the calculation loader.
  const duplicate = await db.select({ id: outcomeProxyAssignments.id }).from(outcomeProxyAssignments)
    .where(and(
      eq(outcomeProxyAssignments.projectId, projectId),
      eq(outcomeProxyAssignments.outcomeId, data.outcomeId),
      eq(outcomeProxyAssignments.proxyId, data.proxyId),
      eq(outcomeProxyAssignments.assignmentStatus, 'active'),
    ))
    .then(r => r[0]);
  if (duplicate) throw new Error('This proxy is already assigned to this outcome');

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
    action: AUDIT_ACTIONS.PROXY_ASSIGNMENT_CREATED,
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
    action: AUDIT_ACTIONS.PROXY_ASSIGNMENT_ARCHIVED,
    beforeJson: assignment,
    afterJson: updated,
  });
  return true;}
