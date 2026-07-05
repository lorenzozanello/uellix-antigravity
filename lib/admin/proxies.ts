// lib/admin/proxies.ts
// SuperAdmin management of system-level (organizationId IS NULL) proxy data.
//
// Deliberately independent from lib/pipeline/proxies.ts: that module gates
// every write through requireOrganizationAccess(), which redirects a real
// super_admin (who has no organization membership) to /admin before its
// own `isSuperAdmin` bypass branches are ever reached. Rather than touch
// that already-tested, in-use code path, admin-only global proxy curation
// lives here behind requireAdminAccess() instead.

import { db } from '@/db/client'
import { proxySources, financialProxies, fxRates } from '@/db/schema'
import { resolveProxyValueUsd } from '@/lib/pipeline/proxies'
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
})

const REVIEW_STATUSES = ['suggested', 'pending_review', 'approved', 'rejected', 'archived'] as const

const ManualFxRateInput = z.object({
  rateToUsd: z.string().min(1),
  source: z.string().min(1),
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

  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'proxy_source',
    entityId: row.id,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    afterJson: row,
  })

  return row
}

export async function createGlobalFinancialProxy(input: unknown) {
  const admin = await requireAdminAccess()
  const data = FinancialProxyInput.parse(input)

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
      reviewStatus: 'suggested',
      createdBy: admin.id,
    })
    .returning()

  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'financial_proxy',
    entityId: row.id,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    afterJson: row,
  })

  return row
}

export async function updateGlobalProxyReviewStatus(proxyId: string, newStatus: string) {
  const admin = await requireAdminAccess()
  if (!REVIEW_STATUSES.includes(newStatus as (typeof REVIEW_STATUSES)[number])) {
    throw new Error('Invalid status')
  }

  const proxy = await db.select().from(financialProxies).where(eq(financialProxies.id, proxyId)).then((r) => r[0])
  if (!proxy) throw new Error('Proxy not found')
  if (proxy.organizationId) throw new Error('Not a global proxy — manage it from the owning organization')

  let usdFields: { valueUsd: string; fxRateId: string | null } | Record<string, never> = {}
  if (newStatus === 'approved') {
    const required = ['value', 'currency', 'unit', 'referenceYear'] as const
    for (const f of required) {
      if (!proxy[f]) throw new Error(`Cannot approve without ${f}`)
    }
    // Freeze the USD equivalent on approval (required by approved_proxy_check).
    usdFields = await resolveProxyValueUsd(proxy)
  }

  const [updated] = await db
    .update(financialProxies)
    .set({ reviewStatus: newStatus, ...usdFields, updatedAt: new Date() })
    .where(eq(financialProxies.id, proxyId))
    .returning()

  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'financial_proxy',
    entityId: proxyId,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    beforeJson: proxy,
    afterJson: updated,
  })

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
export async function setGlobalProxyManualFxRate(proxyId: string, input: { rateToUsd: string; source: string }) {
  const admin = await requireAdminAccess()
  const validated = ManualFxRateInput.parse(input)

  const proxy = await db.select().from(financialProxies).where(eq(financialProxies.id, proxyId)).then((r) => r[0])
  if (!proxy) throw new Error('Proxy not found')
  if (proxy.organizationId) throw new Error('Not a global proxy — manage it from the owning organization')
  if (!proxy.value || !proxy.currency) throw new Error('Cannot set an FX rate without value and currency')
  if (proxy.currency === 'USD') throw new Error('USD proxies do not need an FX rate')

  const rateNum = Number(validated.rateToUsd)
  if (!Number.isFinite(rateNum) || rateNum <= 0) throw new Error('La tasa debe ser un número mayor a 0')

  // Same lookup-date convention as the automatic path: Dec 31 of the proxy's
  // reference year (proxies only carry a year, not an exact date).
  const rateDate = proxy.referenceYear ? `${proxy.referenceYear}-12-31` : new Date().toISOString().slice(0, 10)

  const [fxRate] = await db
    .insert(fxRates)
    .values({
      currency: proxy.currency,
      rateDate,
      rateToUsd: validated.rateToUsd,
      source: validated.source,
      sourceType: 'manual',
      organizationId: null,
      createdBy: admin.id,
    })
    .returning()

  const valueUsd = convertToUsd(proxy.value, validated.rateToUsd)

  const [updated] = await db
    .update(financialProxies)
    .set({ valueUsd, fxRateId: fxRate.id, updatedAt: new Date() })
    .where(eq(financialProxies.id, proxyId))
    .returning()

  await logAuditAction({
    actorUserId: admin.id,
    entityType: 'financial_proxy',
    entityId: proxyId,
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    beforeJson: proxy,
    afterJson: updated,
  })

  return updated
}
