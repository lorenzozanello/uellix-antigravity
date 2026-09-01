// lib/admin/proxies.ts
// SuperAdmin management of system-level (organizationId IS NULL) proxy data.
//
// Deliberately independent from lib/pipeline/proxies.ts: that module gates
// every write through requireOrganizationAccess(), which redirects a real
// super_admin (who has no organization membership) to /admin before its
// own `isSuperAdmin` bypass branches are ever reached. Rather than touch
// that already-tested, in-use code path, admin-only global proxy curation
// lives here behind requireAdminAccess() instead.
//
// === USD CONVERSION WORKFLOW (Fase 1e) ===
// Proxies are stored with a frozen USD equivalent (value_usd) for SROI calculation.
//
// 1. Create proxy with value, currency, unit, referenceYear
// 2. Set USD conversion based on currency:
//    - USD: Direct pass-through (valueUsd = value, fxRateId = null)
//    - COP: Auto-fetch Dec 31 TRM on approval (setGlobalProxyManualFxRate not needed)
//    - Other: Manual rate entry REQUIRED via setGlobalProxyManualFxRate()
// 3. Approval constraint (approved_proxy_check in schema):
//    - Requires value, currency, unit, referenceYear, AND valueUsd all NOT NULL
//    - Enforced at DB level; updateGlobalProxyReviewStatus calls resolveProxyValueUsd
//
// Rate lookup date convention: Dec 31 of proxy's referenceYear (proxies only carry year, not date)
// Manual entry persists every rate in fx_rates for audit trail (no dedup)

import { db } from '@/db/client'
import { proxySources, financialProxies, financialProxyVersions, fxRates } from '@/db/schema'
import {
  deriveApprovedProxyAuthority,
  withExpectedLockedFinancialProxy,
  withLockedFinancialProxy,
} from '@/lib/pipeline/proxies'
import {
  createFinancialProxyVersion,
  getLatestFinancialProxyVersion,
  updateCurrentFinancialProxyVersion,
  assertApprovableProvenance,
  toVersionReviewStatus,
  assertLiveVersionStatusCoupling,
} from '@/lib/pipeline/financial-proxy-versions'
import { assertRubricApprovable } from '@/lib/pipeline/financial-proxy-rubric'
import { convertToUsd } from '@/lib/pipeline/fx'
import { eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { requireAdminAccess } from '@/lib/auth/session'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'

const ProxySourceInput = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  url: z.string().url().optional(),
})

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
  // FIBIU-08 (FIBC-010) — full-provenance fields, recorded on the version.
  // Optional at creation (`suggested`); recoverableReference specifically is
  // required at approval time (assertApprovableProvenance).
  geographicContextualScope: z.string().optional(),
  linkedOutcomeContext: z.string().optional(),
  recoverableReference: z.string().optional(),
  relevanceJustification: z.string().optional(),
  documentedTransformations: z.string().optional(),
  consultationDate: z.string().optional(),
})

const REVIEW_STATUSES = ['suggested', 'pending_review', 'approved', 'rejected', 'archived'] as const

const ManualFxRateInput = z.object({
  rateToUsd: z
    .string()
    .min(1, 'La tasa debe ser un número mayor a 0')
    .refine((v) => !isNaN(Number(v)) && Number(v) > 0, {
      message: 'La tasa debe ser un número positivo',
    }),
  source: z.string().min(1, 'Se requiere fuente para documentación'),
})

export async function listGlobalProxySources() {
  await requireAdminAccess()
  return db.select().from(proxySources).where(isNull(proxySources.organizationId))
}

export async function listGlobalFinancialProxies() {
  await requireAdminAccess()
  return db.select().from(financialProxies).where(isNull(financialProxies.organizationId))
}

export async function createGlobalProxySource(input: unknown) {
  const admin = await requireAdminAccess()
  const data = ProxySourceInput.parse(input)

  const [row] = await db
    .insert(proxySources)
    .values({
      organizationId: null,
      name: data.name,
      description: data.description,
      url: data.url,
      status: 'active',
      createdBy: admin.id,
    })
    .returning()

  // MNB-1 — this created a proxy_source, not an organization; the correct,
  // already-governed verb for that entity has existed in AUDIT_ACTIONS since
  // before this fix (see lib/pipeline/proxies.ts:createOrganizationProxySource,
  // the org-scoped sibling of this admin-only path).
  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'proxy_source',
    entityId: row.id,
    action: AUDIT_ACTIONS.PROXY_SOURCE_CREATED,
    afterJson: row,
  })

  return row
}

export async function createGlobalFinancialProxy(input: unknown) {
  const admin = await requireAdminAccess()
  const data = FinancialProxyInput.parse(input)

  // R-B2-01 — live token is the source of truth at creation; the version
  // token is its image under the single frozen mapping.
  const initialLiveStatus = 'suggested' as const
  const [row] = await db
    .insert(financialProxies)
    .values({
      organizationId: null,
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
      createdBy: admin.id,
    })
    .returning()

  // FIBIU-08 (FIBC-002/FIBC-010) — same versioning substrate as the
  // org-scoped path: every financial proxy is versioned from creation.
  const version = await createFinancialProxyVersion({
    organizationId: null,
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
    createdBy: admin.id,
  })
  assertLiveVersionStatusCoupling(row.reviewStatus, version.reviewStatus)

  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'financial_proxy_version',
    entityId: version.id,
    action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_CREATED,
    afterJson: version,
  })

  // MNB-1 — this created a financial_proxy, not an organization.
  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'financial_proxy',
    entityId: row.id,
    action: AUDIT_ACTIONS.FINANCIAL_PROXY_CREATED,
    afterJson: row,
  })

  return row
}

export async function updateGlobalProxyReviewStatus(
  proxyId: string,
  newStatus: string,
  expectedApprovalState?: string,
) {
  const admin = await requireAdminAccess()
  if (!REVIEW_STATUSES.includes(newStatus as (typeof REVIEW_STATUSES)[number])) {
    throw new Error('Invalid status')
  }

  const transition = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], proxy: typeof financialProxies.$inferSelect) => {
    if (proxy.organizationId) throw new Error('Not a global proxy — manage it from the owning organization')

    let usdFields: { valueUsd: string; fxRateId: string | null } | Record<string, never> = {}
    if (newStatus === 'approved') {
      // FIBIU-08 (FIBC-010/FIBC-012) — the EXIT_GATE's recoverable-reference
      // gate, checked against the CURRENT version in the same locked
      // transaction, exactly like the org-scoped path.
      const currentVersion = await getLatestFinancialProxyVersion(proxyId, tx)
      assertApprovableProvenance(currentVersion)
      assertRubricApprovable(currentVersion)
      usdFields = await deriveApprovedProxyAuthority(tx, proxy)
    }

    const [updated] = await tx
      .update(financialProxies)
      .set({ reviewStatus: newStatus, ...usdFields, updatedAt: new Date() })
      .where(eq(financialProxies.id, proxyId))
      .returning()

    // FIBIU-08 (FIBC-012) — sealed on the version, in the same transaction,
    // exactly like the org-scoped path (lib/pipeline/proxies.ts).
    // R-B2-01 — live token crosses into the version write ONLY through the
    // frozen mapping; coupling asserted inside the same transaction.
    const version = await updateCurrentFinancialProxyVersion(
      proxyId,
      {
        reviewStatus: toVersionReviewStatus(newStatus),
        ...(newStatus === 'approved'
          ? { reviewerId: admin.id, reviewedAt: new Date(), ...usdFields }
          : {}),
      },
      tx
    )
    if (version) assertLiveVersionStatusCoupling(updated.reviewStatus, version.reviewStatus)
    return { proxy, updated, version }
  }

  const { proxy, updated, version } = newStatus === 'approved'
    ? await withExpectedLockedFinancialProxy(proxyId, expectedApprovalState, (_tx, proxy) => {
      if (proxy.organizationId) throw new Error('Not a global proxy — manage it from the owning organization')
    }, transition)
    : await withLockedFinancialProxy(proxyId, transition)

  // MNB-1 — this changed a financial_proxy's review status, not an organization.
  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'financial_proxy',
    entityId: proxyId,
    action: AUDIT_ACTIONS.FINANCIAL_PROXY_REVIEW_STATUS_CHANGED,
    beforeJson: proxy,
    afterJson: updated,
  })

  if (version) {
    await logAuditAction({
      actorUserId: admin.id,
      entityType: 'financial_proxy_version',
      entityId: version.id,
      action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_REVIEW_STATUS_CHANGED,
      afterJson: version,
    })
  }

  return updated
}

/**
 * Manually set the USD conversion for a global proxy whose currency has no
 * auto-fetch source (anything other than USD/COP — see resolveProxyValueUsd).
 * Inserts a new fx_rates row every call (organizationId: null, sourceType:
 * 'manual') rather than caching/reusing one: each manual entry is a deliberate,
 * citable action, so preserving every one is more useful for methodological
 * transparency than deduping them.
 */
export async function setGlobalProxyManualFxRate(
  proxyId: string,
  input: { rateToUsd: string; source: string },
  expectedApprovalState: string,
) {
  const admin = await requireAdminAccess()
  const validated = ManualFxRateInput.parse(input)

  const rateNum = Number(validated.rateToUsd)
  if (!Number.isFinite(rateNum) || rateNum <= 0) throw new Error('La tasa debe ser un número mayor a 0')
  const { proxy, updated } = await withExpectedLockedFinancialProxy(
    proxyId,
    expectedApprovalState,
    (_tx, proxy) => {
      if (proxy.organizationId) throw new Error('Not a global proxy — manage it from the owning organization')
      if (!proxy.value || !proxy.currency) throw new Error('Cannot set an FX rate without value and currency')
      if (proxy.currency === 'USD') throw new Error('USD proxies do not need an FX rate')
    },
    async (tx, proxy) => {
      const rateDate = proxy.referenceYear ? `${proxy.referenceYear}-12-31` : new Date().toISOString().slice(0, 10)
      const [fxRate] = await tx
        .insert(fxRates)
        .values({
          currency: proxy.currency!,
          rateDate,
          rateToUsd: validated.rateToUsd,
          source: validated.source,
          sourceType: 'manual',
          organizationId: null,
          createdBy: admin.id,
        })
        .returning()
      const valueUsd = convertToUsd(proxy.value!, validated.rateToUsd)
      const [updated] = await tx
        .update(financialProxies)
        .set({
          valueUsd,
          fxRateId: fxRate.id,
          ...(proxy.reviewStatus === 'approved' ? { reviewStatus: 'pending_review' as const } : {}),
          updatedAt: new Date(),
        })
        .where(eq(financialProxies.id, proxyId))
        .returning()
      return { proxy, updated }
    },
  )

  // MNB-1 — this changed a financial_proxy's FX/valueUsd fields, not an organization.
  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'financial_proxy',
    entityId: proxyId,
    action: AUDIT_ACTIONS.FINANCIAL_PROXY_UPDATED,
    beforeJson: proxy,
    afterJson: updated,
  })

  return updated
}

export async function listPendingReviewProxies() {
  await requireAdminAccess()
  // Return all proxies from organizations that are pending review for the global bank
  return db
    .select()
    .from(financialProxies)
    .where(eq(financialProxies.reviewStatus, 'pending_review'))
}

export async function promoteProxyToGlobal(proxyId: string, expectedApprovalState: string) {
  const admin = await requireAdminAccess()
  const now = new Date()
  const { clonedSource, clonedProxy, clonedVersion, originalVersion } = await withExpectedLockedFinancialProxy(
    proxyId,
    expectedApprovalState,
    (_tx, proxy) => {
      if (!proxy.organizationId) throw new Error('Proxy is already global')
      if (proxy.reviewStatus !== 'pending_review') throw new Error('Proxy is not pending review')
    },
    async (tx, proxy) => {
      // FIBIU-08 (FIBC-010/FIBC-012) — this transition also approves the
      // ORIGINAL proxy (reviewStatus -> 'approved' below), so the same
      // recoverable-reference gate applies here too. Fetched once, reused
      // below for the clone's own provenance copy.
      const sourceVersion = await getLatestFinancialProxyVersion(proxyId, tx)
      assertApprovableProvenance(sourceVersion)
      assertRubricApprovable(sourceVersion)
      const usdFields = await deriveApprovedProxyAuthority(tx, proxy)
      const source = await tx
        .select()
        .from(proxySources)
        .where(eq(proxySources.id, proxy.sourceId))
        .for('update')
        .then((rows) => rows[0] ?? null)
      let globalSourceId = proxy.sourceId
      let clonedSource: typeof proxySources.$inferSelect | null = null
      if (source?.organizationId) {
        ;[clonedSource] = await tx.insert(proxySources).values({
          organizationId: null,
          name: source.name,
          description: source.description,
          url: source.url,
          status: 'active',
          createdBy: admin.id,
        }).returning()
        globalSourceId = clonedSource.id
      }
      const [clonedProxy] = await tx.insert(financialProxies).values({
        organizationId: null,
        sourceId: globalSourceId,
        name: proxy.name,
        description: proxy.description,
        proxyType: proxy.proxyType,
        country: proxy.country,
        territory: proxy.territory,
        currency: proxy.currency,
        value: proxy.value,
        ...usdFields,
        unit: proxy.unit,
        referenceYear: proxy.referenceYear,
        thematicArea: proxy.thematicArea,
        methodology: proxy.methodology,
        confidenceLevel: proxy.confidenceLevel,
        methodologicalRisk: proxy.methodologicalRisk,
        reviewStatus: 'approved',
        reviewerId: admin.id,
        reviewedAt: now,
        createdBy: admin.id,
      }).returning()
      await tx.update(financialProxies)
        .set({ reviewStatus: 'approved', ...usdFields, reviewerId: admin.id, reviewedAt: now, updatedAt: now })
        .where(eq(financialProxies.id, proxyId))

      // FIBIU-08 (FIBC-002/FIBC-010/FIBC-012) — carry the original's current
      // provenance into the clone's own version 1, sealed approved on
      // creation; seal the original's own current version approved too, in
      // the same transaction as the live-row transitions above.
      const clonedVersion = await createFinancialProxyVersion(
        {
          organizationId: null,
          financialProxyId: clonedProxy.id,
          sourceId: globalSourceId,
          value: proxy.value,
          currency: proxy.currency,
          unit: proxy.unit,
          referenceYear: proxy.referenceYear,
          valueUsd: usdFields.valueUsd ?? null,
          fxRateId: usdFields.fxRateId ?? null,
          country: proxy.country,
          territory: proxy.territory,
          thematicArea: proxy.thematicArea,
          methodology: proxy.methodology,
          geographicContextualScope: sourceVersion?.geographicContextualScope ?? null,
          linkedOutcomeContext: sourceVersion?.linkedOutcomeContext ?? null,
          recoverableReference: sourceVersion?.recoverableReference ?? null,
          relevanceJustification: sourceVersion?.relevanceJustification ?? null,
          documentedTransformations: sourceVersion?.documentedTransformations ?? null,
          consultationDate: sourceVersion?.consultationDate ?? null,
          // FIBIU-09 — the clone carries the ALREADY-EVALUATED (and just
          // gate-checked via assertRubricApprovable above) source rubric
          // across, rather than starting the promoted proxy back at
          // unrated: promotion changes no underlying evidence, so re-rating
          // it from scratch would be governance theater, not a real check.
          c1SourceQualityVerifiability: sourceVersion?.c1SourceQualityVerifiability ?? null,
          c2OutcomeCorrespondence: sourceVersion?.c2OutcomeCorrespondence ?? null,
          c3StakeholderPopulationFit: sourceVersion?.c3StakeholderPopulationFit ?? null,
          c4GeographicContextFit: sourceVersion?.c4GeographicContextFit ?? null,
          c5TemporalFit: sourceVersion?.c5TemporalFit ?? null,
          c6MethodologicalUnitComparability: sourceVersion?.c6MethodologicalUnitComparability ?? null,
          r1ProvenanceRisk: sourceVersion?.r1ProvenanceRisk ?? null,
          r2SourceLimitationRisk: sourceVersion?.r2SourceLimitationRisk ?? null,
          r3ConceptualFitRisk: sourceVersion?.r3ConceptualFitRisk ?? null,
          r4GeographicPopulationTransferRisk: sourceVersion?.r4GeographicPopulationTransferRisk ?? null,
          r5TemporalObsolescenceRisk: sourceVersion?.r5TemporalObsolescenceRisk ?? null,
          r6TransformationRisk: sourceVersion?.r6TransformationRisk ?? null,
          r7MethodologicalUncertaintyRisk: sourceVersion?.r7MethodologicalUncertaintyRisk ?? null,
          confidenceScore: sourceVersion?.confidenceScore ?? null,
          confidenceLevel: sourceVersion?.confidenceLevel ?? null,
          methodologicalRiskScore: sourceVersion?.methodologicalRiskScore ?? null,
          methodologicalRisk: sourceVersion?.methodologicalRisk ?? null,
          rubricVersion: sourceVersion?.rubricVersion ?? null,
          exceptionalDefendibilityDetermination: sourceVersion?.exceptionalDefendibilityDetermination ?? null,
          // R-B2-01 — version token is the image of the clone's live token.
          reviewStatus: toVersionReviewStatus(clonedProxy.reviewStatus),
          createdBy: admin.id,
        },
        tx
      )
      await tx
        .update(financialProxyVersions)
        .set({ reviewerId: admin.id, reviewedAt: now })
        .where(eq(financialProxyVersions.id, clonedVersion.id))
      assertLiveVersionStatusCoupling(clonedProxy.reviewStatus, clonedVersion.reviewStatus)
      // R-B2-01 — the original's live row was set to 'approved' above; its
      // version takes that token's image, never the literal.
      const originalLiveStatus = 'approved' as const
      const originalVersion = await updateCurrentFinancialProxyVersion(
        proxyId,
        { reviewStatus: toVersionReviewStatus(originalLiveStatus), reviewerId: admin.id, reviewedAt: now, ...usdFields },
        tx
      )
      if (originalVersion) assertLiveVersionStatusCoupling(originalLiveStatus, originalVersion.reviewStatus)

      return { clonedSource, clonedProxy, clonedVersion, originalVersion }
    },
  )

  if (clonedSource) {
    await logAuditAction({
      actorUserId: admin.id,
      entityType: 'proxy_source',
      entityId: clonedSource.id,
      action: AUDIT_ACTIONS.PROXY_SOURCE_CREATED,
      afterJson: clonedSource,
    })
  }
  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'financial_proxy_version',
    entityId: clonedVersion.id,
    action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_CREATED,
    afterJson: clonedVersion,
  })
  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'financial_proxy',
    entityId: clonedProxy.id,
    action: AUDIT_ACTIONS.FINANCIAL_PROXY_CREATED,
    afterJson: clonedProxy,
  })
  if (originalVersion) {
    await logAuditAction({
      actorUserId: admin.id,
      entityType: 'financial_proxy_version',
      entityId: originalVersion.id,
      action: AUDIT_ACTIONS.FINANCIAL_PROXY_VERSION_REVIEW_STATUS_CHANGED,
      afterJson: originalVersion,
    })
  }
  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'financial_proxy',
    entityId: proxyId,
    action: AUDIT_ACTIONS.FINANCIAL_PROXY_REVIEW_STATUS_CHANGED,
    afterJson: { id: proxyId, reviewStatus: 'approved' },
  })

  return clonedProxy
}
