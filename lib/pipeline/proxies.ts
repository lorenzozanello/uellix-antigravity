// lib/pipeline/proxies.ts

import { db } from '@/db/client';
import { proxySources, financialProxies, outcomeProxyAssignments, projects, outcomes } from '@/db/schema';
import { eq, and, or, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import '@/lib/pipeline/decimal-config';
import { requireOrganizationAccess, getCurrentOrganizationContext, type OrganizationContext } from '@/lib/auth/session';
import { canApproveProxy } from '@/lib/auth/permissions';
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger';
import { getOrCreateSharedCopRate, convertToUsd, type FxRateExecutor } from '@/lib/pipeline/fx';
import {
  createFinancialProxyVersion,
  getLatestFinancialProxyVersion,
  getCurrentApprovedFinancialProxyVersion,
  updateCurrentFinancialProxyVersion,
  assertApprovableProvenance,
  toVersionReviewStatus,
  toLiveReviewStatus,
  assertLiveVersionStatusCoupling,
} from '@/lib/pipeline/financial-proxy-versions';
import { assertRubricApprovable } from '@/lib/pipeline/financial-proxy-rubric';
import {
  applyMaterialChange,
  materialCategoriesTouched,
  assertPatchKeysEditable,
  INPUT_KEY_TO_PERSISTED_FIELD,
  MATERIAL_CATEGORY_LABELS,
} from '@/lib/pipeline/proxy-material-change';

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
  options?: { organizationId?: string },
): Promise<T> {
  return db.transaction(async (tx) => {
    // W2-B2-R4-404-CONTRACT-CORRECTION — when a caller supplies
    // `organizationId`, the LOCK SELECT itself is scoped to it: a proxy
    // owned by another organization (or a global/system proxy,
    // organizationId NULL, which never equals a specific org id) is simply
    // never observed to exist by this transaction, so it falls through to
    // the ordinary 'Proxy not found' path below — no existence is leaked to
    // an org-scoped caller that must not learn whether a given id belongs to
    // someone else's tenant. Opt-in and additive: every existing caller that
    // omits `options` keeps the prior unscoped-lookup-plus-explicit-Forbidden
    // behaviour untouched (see updateFinancialProxyReviewStatus's IDOR test).
    const where = options?.organizationId !== undefined
      ? and(eq(financialProxies.id, proxyId), eq(financialProxies.organizationId, options.organizationId))
      : eq(financialProxies.id, proxyId);
    const proxy = await tx
      .select()
      .from(financialProxies)
      .where(where)
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
  // FIBIU-08 (FIBC-010) — full-provenance fields, recorded on the version,
  // never on the live financial_proxies row. Optional at stage A: creation
  // (`suggested`) is still allowed with incomplete provenance; only
  // *approval* requires them (see requireApprovableProvenance below).
  geographicContextualScope: z.string().optional(),
  linkedOutcomeContext: z.string().optional(),
  recoverableReference: z.string().optional(),
  relevanceJustification: z.string().optional(),
  documentedTransformations: z.string().optional(),
  consultationDate: z.string().optional(),
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
    contentModifying: true,
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
  // R-B2-01 — the live token is the source of truth at creation; the version
  // token is its image under the single frozen mapping, never a literal.
  const initialLiveStatus = 'suggested' as const;
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
    reviewStatus: initialLiveStatus,
    createdBy: ctx.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning().then(r => r[0]);

  // FIBIU-08 (FIBC-002/FIBC-010) — every financial proxy is versioned from
  // creation; there is no pre-versioning state to backfill for a NEW row.
  const version = await createFinancialProxyVersion({
    organizationId: ctx.organization.id,
    financialProxyId: row.id,
    sourceId: data.sourceId,
    value: data.value,
    currency: data.currency,
    unit: data.unit,
    referenceYear: data.referenceYear,
    valueUsd: null,
    fxRateId: null,
    country: data.country ?? null,
    territory: data.territory ?? null,
    thematicArea: data.thematicArea ?? null,
    methodology: data.methodology ?? null,
    geographicContextualScope: data.geographicContextualScope ?? null,
    linkedOutcomeContext: data.linkedOutcomeContext ?? null,
    recoverableReference: data.recoverableReference ?? null,
    relevanceJustification: data.relevanceJustification ?? null,
    documentedTransformations: data.documentedTransformations ?? null,
    consultationDate: data.consultationDate ? new Date(data.consultationDate) : null,
    reviewStatus: toVersionReviewStatus(initialLiveStatus),
    createdBy: ctx.user.id,
  });
  assertLiveVersionStatusCoupling(row.reviewStatus, version.reviewStatus);

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'financial_proxy_version',
    entityId: version.id,
    action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_CREATED,
    afterJson: version,
  });

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

// CL-2B (PROX-01) — subset of the material fields that resolveProxyValueUsd
// actually derives from (value, currency, and referenceYear for the COP TRM
// lookup date). `unit` is material to the review — it changes what the value
// MEANS — but not to the USD figure itself, so it alone must not force a
// pointless FX re-fetch.
const PROXY_USD_DERIVATION_FIELDS = ['value', 'currency', 'referenceYear'] as const;

// Keys of FinancialProxyInput that are also persisted on financial_proxy_versions
// (name/description/proxyType/confidenceLevel/methodologicalRisk live only
// on the live financialProxies row — see MATERIAL_FIELD_CATEGORY_BY_INPUT_KEY).
const VERSION_MIRRORED_KEYS = [
  'sourceId', 'value', 'currency', 'unit', 'referenceYear', 'country', 'territory',
  'thematicArea', 'methodology', 'geographicContextualScope', 'linkedOutcomeContext',
  'recoverableReference', 'relevanceJustification', 'documentedTransformations', 'consultationDate',
] as const;

function versionFieldPatchFrom(data: Partial<z.infer<typeof FinancialProxyInput>>) {
  const patch: Record<string, unknown> = {};
  for (const key of VERSION_MIRRORED_KEYS) {
    if (data[key] === undefined) continue;
    patch[key] = key === 'consultationDate' ? new Date(data[key] as string) : data[key];
  }
  return patch;
}

/**
 * FIBIU-10 (FIBC-013) — every material edit, whatever its category, must be
 * reflected in the version record: EITHER in place (version not yet
 * approved — no approval to protect) OR via an atomic fork that leaves the
 * approved version untouched (see lib/pipeline/proxy-material-change.ts).
 * Editing name/description/proxyType-only ("non_material") never touches
 * the version or resets review status — that is the negative control
 * FIBIU-10's own EXIT_GATE names ("an editorial change does not
 * invalidate").
 */
// W2-B2-R1 / R-B2-06 (closes M2; editorial_noop_patch_disposition, FROZEN).
// A field counts as materially changed IF AND ONLY IF the AUTHORITATIVE
// PERSISTED SEMANTIC VALUE of that field actually changes. Key presence in a
// payload is not evidence of change — zod's `.partial()` reports a key whose
// value is `undefined` in Object.keys() while JSON.stringify hides it, which
// is exactly how a blank form submission destroyed approvals (M2).
//
//   ABSENT / UNDEFINED : not a change ('no value supplied', never 'clear').
//   NULL               : a change iff the persisted value is not already
//                        semantically absent — the only form that may clear.
//   EMPTY_STRING       : for nullable text, '' and NULL are the same absence.
//   UNCHANGED_VALUE    : equal after canonicalisation — not a change.
//   CHANGED_VALUE      : differs after canonicalisation — a change.
// Canonicalisation: numerics by decimal value (canonicalDecimal, so '100'
// equals '100.0000'), integers by numeric value, dates by instant, text
// exactly (no trimming/case-folding — that would hide a real edit).
// Comparison target: the row that authoritatively persists the field
// (registry table_name) — the CURRENT version for version-mirrored fields,
// the live row for live-only fields; a never-versioned legacy proxy has only
// its live row to compare against.
const INTEGER_INPUT_KEYS: readonly string[] = ['referenceYear'];
const NUMERIC_INPUT_KEYS: readonly string[] = ['value'];
const DATE_INPUT_KEYS: readonly string[] = ['consultationDate'];

function semanticallyAbsent(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.length === 0);
}

/** True iff `incoming` (present in the payload) differs semantically from `persisted`. */
export function isSemanticProxyFieldChange(key: string, incoming: unknown, persisted: unknown): boolean {
  if (incoming === undefined) return false; // UNDEFINED — no value supplied
  if (incoming === null) return !semanticallyAbsent(persisted); // NULL — clear iff something is there
  if (NUMERIC_INPUT_KEYS.includes(key)) {
    return canonicalDecimal(String(incoming)) !== (semanticallyAbsent(persisted) ? null : canonicalDecimal(String(persisted)));
  }
  if (INTEGER_INPUT_KEYS.includes(key)) {
    return semanticallyAbsent(persisted) ? true : Number(incoming) !== Number(persisted);
  }
  if (DATE_INPUT_KEYS.includes(key)) {
    if (semanticallyAbsent(persisted)) return true;
    const p = persisted instanceof Date ? persisted.getTime() : new Date(String(persisted)).getTime();
    return new Date(String(incoming)).getTime() !== p;
  }
  // text: EMPTY_STRING ≡ NULL, otherwise exact
  if (typeof incoming === 'string' && incoming.length === 0) return !semanticallyAbsent(persisted);
  return semanticallyAbsent(persisted) ? true : String(incoming) !== String(persisted);
}

function semanticallyChangedKeys(
  data: Partial<z.infer<typeof FinancialProxyInput>>,
  live: FinancialProxyRow,
  version: Awaited<ReturnType<typeof getLatestFinancialProxyVersion>>,
): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    const incoming = data[key];
    if (incoming === undefined) continue;
    const ref = INPUT_KEY_TO_PERSISTED_FIELD[key];
    const persisted = ref?.table === 'financial_proxy_versions' && version
      ? (version as Record<string, unknown>)[key]
      : (live as Record<string, unknown>)[key];
    if (isSemanticProxyFieldChange(key, incoming, persisted)) changed.push(key);
  }
  return changed;
}

export async function updateOrganizationFinancialProxy(proxyId: string, input: unknown) {
  const ctx = await requireOrganizationAccess();
  // R-B2-06 / AG-B2-3-DERIVED rejection_rule — a patch that NAMES a field
  // whose registry editability is not user_editable is rejected by name,
  // before parsing could strip it, so an approval-metadata write attempt
  // can never pass unnoticed.
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    assertPatchKeysEditable(Object.keys(input as Record<string, unknown>));
  }
  const data = FinancialProxyInput.partial().parse(input);

  const { proxy, updated, forked, supersededVersion, newVersion, changedKeys, touchedCategories } = await withLockedFinancialProxy(proxyId, async (tx, proxy) => {
    if (proxy.organizationId !== ctx.organization.id) throw new Error('Forbidden');

    // Materiality is decided against the persisted rows, inside the lock.
    const currentVersion = await getLatestFinancialProxyVersion(proxyId, tx);
    const changedKeys = semanticallyChangedKeys(data, proxy, currentVersion);
    const touchedCategories = materialCategoriesTouched(changedKeys);
    const isMaterial = touchedCategories.length > 0;

    // A semantic no-op: nothing persisted changes, so nothing is written —
    // no fork, no status change, no value_usd null-out, no audit event.
    if (changedKeys.length === 0) {
      return { proxy, updated: proxy, forked: false, supersededVersion: null, newVersion: null, changedKeys, touchedCategories };
    }

    // A partial update may repoint the proxy at another source — the same
    // ownership gate as creation applies (RC-12).
    if (changedKeys.includes('sourceId') && data.sourceId !== undefined) {
      await requireUsableProxySource(data.sourceId, ctx.organization.id);
    }

    const changedData = Object.fromEntries(changedKeys.map((k) => [k, (data as Record<string, unknown>)[k]])) as Partial<z.infer<typeof FinancialProxyInput>>;
    let forked = false;
    let supersededVersion: Awaited<ReturnType<typeof getLatestFinancialProxyVersion>> = null;
    let newVersion: Awaited<ReturnType<typeof getLatestFinancialProxyVersion>> = null;

    // CL-2B/CL-2C (PROX-01) — a REAL change to value/currency/referenceYear
    // makes the previously frozen valueUsd/fxRateId stale. Same semantic
    // comparator as materiality, never String(...) identity.
    const usdDerivationChange = PROXY_USD_DERIVATION_FIELDS.some((f) => changedKeys.includes(f));

    if (isMaterial && currentVersion) {
      const versionPatch = versionFieldPatchFrom(changedData);
      const result = await applyMaterialChange(
        proxyId,
        proxy.organizationId,
        currentVersion,
        versionPatch,
        ctx.user.id,
        tx,
      );
      forked = result.forked;
      if (result.forked) {
        supersededVersion = result.supersededVersion;
        newVersion = result.version;
      } else {
        // Not yet approved — no approval to protect; the SAME version is
        // edited in place, mirroring the live row (existing FIBC-002
        // behavior for a pre-approval edit).
        newVersion = await updateCurrentFinancialProxyVersion(
          proxyId,
          { ...versionPatch, ...(usdDerivationChange ? { valueUsd: null, fxRateId: null } : {}) },
          tx
        );
      }
    }

    // Re-review gate: an approved proxy whose material fields change drops
    // back into the review queue. `forked` IS this condition. R-B2-01: the
    // live token is the INVERSE IMAGE of the fork's version status under
    // the frozen mapping, never a coincident literal.
    const resetReview = forked;

    const updated = await tx.update(financialProxies).set({
      ...changedData,
      ...(resetReview && newVersion ? { reviewStatus: toLiveReviewStatus(newVersion.reviewStatus) } : {}),
      ...(usdDerivationChange ? { valueUsd: null, fxRateId: null } : {}),
      updatedAt: new Date(),
    }).where(eq(financialProxies.id, proxyId)).returning().then(r => r[0]);
    if (newVersion) assertLiveVersionStatusCoupling(updated.reviewStatus, newVersion.reviewStatus);
    return { proxy, updated, forked, supersededVersion, newVersion, changedKeys, touchedCategories };
  });

  if (changedKeys.length === 0) return updated;

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'financial_proxy',
    entityId: proxyId,
    action: forked
      ? AUDIT_ACTIONS.FINANCIAL_PROXY_REVIEW_STATUS_CHANGED
      : AUDIT_ACTIONS.FINANCIAL_PROXY_UPDATED,
    reason: forked
      ? `Approval reset: material change in ${touchedCategories.map((c) => MATERIAL_CATEGORY_LABELS[c]).join(', ')}`
      : undefined,
    contentModifying: true,
    beforeJson: proxy,
    afterJson: updated,
  });

  if (forked && supersededVersion && newVersion) {
    await logAuditAction({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'financial_proxy_version',
      entityId: supersededVersion.id,
      action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_INVALIDATED_BY_MATERIAL_CHANGE,
      reason: `Material change in ${touchedCategories.map((c) => MATERIAL_CATEGORY_LABELS[c]).join(', ')}`,
      beforeJson: { reviewStatus: supersededVersion.reviewStatus },
      afterJson: { supersededBy: newVersion.id },
    });
    await logAuditAction({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'financial_proxy_version',
      entityId: newVersion.id,
      action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_CREATED,
      reason: 'Opened by material change',
      afterJson: newVersion,
    });
  }

  return updated;
}

export async function updateFinancialProxyReviewStatus(
  proxyId: string,
  newStatus: string,
  expectedApprovalState?: string,
) {
  const ctx = await requireOrganizationAccess();
  return updateFinancialProxyReviewStatusForContext(ctx, proxyId, newStatus, expectedApprovalState);
}

/**
 * Same governed transition as {@link updateFinancialProxyReviewStatus}, for a
 * caller that already holds a non-redirecting {@link OrganizationContext} —
 * e.g. a Route Handler using `getCurrentOrganizationContext`, which must
 * control its own HTTP response on an auth failure rather than trigger
 * `requireOrganizationAccess`'s redirect.
 *
 * W2-B2-R3-NARROW-REMEDIATION / R-B2-10 — the fifth reachable transition site
 * (app/api/proxies/[id]/suggest/route.ts) previously wrote the live row
 * directly, bypassing both this governed permission gate and the
 * LIVE_VERSION_STATUS_COUPLING mapping. `requireFromStatus`, when given, is
 * checked against the CURRENT live review_status inside the SAME locked
 * transaction as the write — never as a separate pre-read — so a concurrent
 * status change cannot race between the check and the mutation.
 *
 * W2-B2-R4-404-CONTRACT-CORRECTION — `hideCrossTenantAsNotFound`, when true,
 * scopes the underlying row lock to `ctx.organization.id` (see
 * `withLockedFinancialProxy`'s `options.organizationId`) instead of relying
 * on the Forbidden throw below, so a proxy owned by another organization (or
 * a global/system proxy) is never observed to exist by this transaction at
 * all — the caller gets 'Proxy not found', never 'Forbidden'. This is a
 * caller-side literal, never derived from request input, and defaults to
 * false so every existing caller (including the approval path's own IDOR
 * check, which intentionally surfaces 'Forbidden') is unaffected.
 */
export async function updateFinancialProxyReviewStatusForContext(
  ctx: OrganizationContext,
  proxyId: string,
  newStatus: string,
  expectedApprovalState?: string,
  requireFromStatus?: string,
  hideCrossTenantAsNotFound?: boolean,
) {
  const allowed = ['suggested', 'pending_review', 'approved', 'rejected', 'archived'];
  if (!allowed.includes(newStatus)) throw new Error('Invalid status');
  const transition = async (tx: FinancialProxyTransaction, proxy: FinancialProxyRow) => {
    // When hideCrossTenantAsNotFound scoped the lock SELECT above, `proxy`
    // is already guaranteed to belong to ctx.organization.id (or the SELECT
    // would have found nothing and thrown 'Proxy not found' already) — these
    // two checks are then dead but harmless. They remain load-bearing for
    // every caller that does NOT set the flag.
    if (proxy.organizationId && proxy.organizationId !== ctx.organization.id) throw new Error('Forbidden');
    // System proxies (organizationId: null) are reviewed/approved exclusively
    // via lib/admin/proxies.ts — see updateOrganizationProxySource above for
    // why an isSuperAdmin bypass here was dead code, not a working escape
    // hatch.
    if (!proxy.organizationId) throw new Error('Forbidden');
    if (!canApproveProxy(ctx.membership.role)) throw new Error('Forbidden');
    if (requireFromStatus !== undefined && proxy.reviewStatus !== requireFromStatus) {
      throw new Error('Unexpected current status');
    }
    // FIBIU-08 (FIBC-010/FIBC-012) — the EXIT_GATE's two named blocking
    // conditions: a recordable actor+moment (this function supplies it
    // below) and a recoverable reference, checked here against the CURRENT
    // version, in the SAME locked transaction as the rest of the approval.
    if (newStatus === 'approved') {
      const currentVersion = await getLatestFinancialProxyVersion(proxyId, tx)
      assertApprovableProvenance(currentVersion)
      assertRubricApprovable(currentVersion)
    }
    const usdFields = newStatus === 'approved'
      ? await deriveApprovedProxyAuthority(tx, proxy)
      : {};
    const updated = await tx.update(financialProxies).set({ reviewStatus: newStatus, ...usdFields, updatedAt: new Date() })
      .where(eq(financialProxies.id, proxyId))
      .returning().then(r => r[0]);

    // FIBIU-08 (FIBC-012) — THE fix: reviewer_id/reviewed_at are actually
    // written now, sealed on the CURRENT version, in the SAME transaction as
    // the proxy row's own status change — never a separate later write that
    // could observe a torn state between "proxy says approved" and "no
    // version records who approved it or when."
    // R-B2-01 — the live token crosses into the version write ONLY through
    // the frozen mapping (B2-AR-B1: 'suggested'/'pending_review' violated the
    // version CHECK when copied verbatim), and the coupling invariant is
    // asserted inside the same transaction so a violation rolls it back.
    const version = await updateCurrentFinancialProxyVersion(
      proxyId,
      {
        reviewStatus: toVersionReviewStatus(newStatus),
        ...(newStatus === 'approved'
          ? { reviewerId: ctx.user.id, reviewedAt: new Date(), ...usdFields }
          : {}),
      },
      tx
    );
    if (version) assertLiveVersionStatusCoupling(updated.reviewStatus, version.reviewStatus);
    return { proxy, updated, version };
  };

  const result = newStatus === 'approved'
    ? await withExpectedLockedFinancialProxy(proxyId, expectedApprovalState, async (_tx, proxy) => {
      if (proxy.organizationId !== ctx.organization.id) throw new Error('Forbidden');
      if (!canApproveProxy(ctx.membership.role)) throw new Error('Forbidden');
    }, transition)
    : await withLockedFinancialProxy(
      proxyId,
      transition,
      hideCrossTenantAsNotFound ? { organizationId: ctx.organization.id } : undefined,
    );
  const { proxy, updated, version } = result;

  await logAuditAction({
    organizationId: ctx.organization.id,
    actorUserId: ctx.user.id,
    entityType: 'financial_proxy',
    entityId: proxyId,
    action: AUDIT_ACTIONS.FINANCIAL_PROXY_REVIEW_STATUS_CHANGED,
    beforeJson: proxy,
    afterJson: updated,
  });

  if (version) {
    await logAuditAction({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'financial_proxy_version',
      entityId: version.id,
      action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_REVIEW_STATUS_CHANGED,
      afterJson: version,
    });
  }
  return updated;
}

export async function archiveFinancialProxy(proxyId: string) {
  const ctx = await requireOrganizationAccess();
  // R-B2-01 — archive is the fourth transition site. It previously updated
  // only the live row and left the current version 'approved', breaking the
  // coupling invariant and leaving an approved version reachable by binding.
  // Now the current version transitions in the SAME transaction, through
  // the same mapping, with the coupling asserted before commit.
  const archivedLiveStatus = 'archived' as const;
  const { proxy, updated, version } = await withLockedFinancialProxy(proxyId, async (tx, proxy) => {
    if (proxy.organizationId !== ctx.organization.id) throw new Error('Forbidden');
    const updated = await tx.update(financialProxies).set({ reviewStatus: archivedLiveStatus, updatedAt: new Date() })
      .where(eq(financialProxies.id, proxyId))
      .returning().then(r => r[0]);
    const version = await updateCurrentFinancialProxyVersion(
      proxyId,
      { reviewStatus: toVersionReviewStatus(archivedLiveStatus) },
      tx
    );
    if (version) assertLiveVersionStatusCoupling(updated.reviewStatus, version.reviewStatus);
    return { proxy, updated, version };
  });

  if (version) {
    await logAuditAction({
      organizationId: ctx.organization.id,
      actorUserId: ctx.user.id,
      entityType: 'financial_proxy_version',
      entityId: version.id,
      action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_REVIEW_STATUS_CHANGED,
      afterJson: version,
    });
  }

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

  // FIBIU-08 (FIBDB-039) — bind to a version at assignment time. Immutable
  // per run: this assignment keeps pointing at exactly this version even if
  // the proxy is later re-approved under a newer one (financial_proxy_
  // version_id is written ONCE, here, and never updated — a committed static
  // control proves no code path updates it).
  //
  // W2-B2-R1 / R-B2-05 (M7-DERIVED): bind the current APPROVED version, per
  // FIBC-012's literal "eligibility binds to the exact approved version" —
  // never the latest version regardless of status, which bound a fresh
  // 'under_review' fork and left the assignment permanently ineligible. When
  // no approved version exists, REFUSE: never bind NULL, never bind a draft.
  const version = await getCurrentApprovedFinancialProxyVersion(data.proxyId);
  if (!version) {
    throw new Error('Cannot assign: proxy has no approved version to bind (FIBC-012 — eligibility binds to the exact approved version)');
  }

  const row = await db.insert(outcomeProxyAssignments).values({
    projectId,
    organizationId: ctx.organization.id,
    outcomeId: data.outcomeId,
    proxyId: data.proxyId,
    financialProxyVersionId: version.id,
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
