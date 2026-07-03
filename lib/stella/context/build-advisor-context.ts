// lib/stella/context/build-advisor-context.ts
// Sprint 9C-1: Build StellaProjectContext for Advisor from project metadata
// Security: metadata only, no raw file content, no PII, no secrets, no cross-org data

import { db } from '@/db/client'
import {
  projects,
  impactNarratives,
  stakeholderGroups,
  outcomes,
  indicators,
  evidenceItems,
  outcomeProxyAssignments,
  financialProxies,
  proxySources,
} from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import { sanitizeString, sanitizeNarrative, hasForbiddenPattern } from './sanitize'
import type {
  StellaProjectContext,
  OutcomeRef,
  IndicatorRef,
  EvidenceMeta,
  ProxyRef,
} from './types'

export class StellaBuildContextError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'UNAUTHORIZED' | 'UNSUPPORTED_STEP',
    message: string
  ) {
    super(message)
    this.name = 'StellaBuildContextError'
  }
}

export async function buildAdvisorContext(
  projectId: string,
  organizationId: string,
  step: string
): Promise<StellaProjectContext> {
  // Project ownership check — structural cross-org boundary
  const project = await db
    .select({
      id: projects.id,
      organizationId: projects.organizationId,
      name: projects.name,
      status: projects.status,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!project) {
    throw new StellaBuildContextError('NOT_FOUND', 'Project not found')
  }
  if (project.organizationId !== organizationId) {
    throw new StellaBuildContextError('UNAUTHORIZED', 'Project does not belong to your organization')
  }

  // Fetch narrative summary (latest version)
  const narrative = await db
    .select({
      narrativeText: impactNarratives.narrativeText,
      theoryOfChangeSummary: impactNarratives.theoryOfChangeSummary,
    })
    .from(impactNarratives)
    .where(eq(impactNarratives.projectId, projectId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  const rawNarrative = [
    narrative?.narrativeText ?? '',
    narrative?.theoryOfChangeSummary ?? '',
  ]
    .filter(Boolean)
    .join(' ')
  const narrativeSummary = sanitizeNarrative(rawNarrative)

  // Fetch stakeholder count (no PII, no emails — just count and safe name/type)
  const rawStakeholders = await db
    .select({
      id: stakeholderGroups.id,
      name: stakeholderGroups.name,
      type: stakeholderGroups.type,
    })
    .from(stakeholderGroups)
    .where(eq(stakeholderGroups.projectId, projectId))

  const stakeholderCount = rawStakeholders.length

  // Fetch outcomes (title + type — no descriptions that might contain PII)
  const rawOutcomes = await db
    .select({
      id: outcomes.id,
      title: outcomes.title,
      outcomeType: outcomes.outcomeType,
      status: outcomes.status,
    })
    .from(outcomes)
    .where(and(eq(outcomes.projectId, projectId), eq(outcomes.status, 'active')))

  const outcomesSnapshot: OutcomeRef[] = rawOutcomes.map((o) => ({
    id: o.id,
    name: sanitizeString(o.title, 200),
    description: o.outcomeType ? sanitizeString(o.outcomeType, 100) : '',
    stakeholderGroups: [],
  }))

  // Fetch indicators (name + unit per outcome — no raw values sent)
  const rawIndicators = await db
    .select({
      id: indicators.id,
      outcomeId: indicators.outcomeId,
      name: indicators.name,
      unit: indicators.unit,
    })
    .from(indicators)
    .where(eq(indicators.projectId, projectId))

  const indicatorsSnapshot: IndicatorRef[] = rawIndicators.map((i) => ({
    id: i.id,
    outcomeId: i.outcomeId,
    name: sanitizeString(i.name, 200),
    unit: sanitizeString(i.unit ?? '', 50),
  }))

  // Fetch evidence metadata — NO filePath, NO raw content, NO storage paths
  // title is included only if it doesn't trigger forbidden pattern detection
  const rawEvidence = await db
    .select({
      id: evidenceItems.id,
      type: evidenceItems.type,
      title: evidenceItems.title,
      status: evidenceItems.status,
      contentHash: evidenceItems.contentHash,
      createdAt: evidenceItems.createdAt,
      outcomeId: evidenceItems.outcomeId,
      indicatorId: evidenceItems.indicatorId,
      // filePath intentionally excluded — never send storage paths to Gemini
    })
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.projectId, projectId),
        eq(evidenceItems.organizationId, organizationId)
      )
    )

  const evidenceMetadata: EvidenceMeta[] = rawEvidence.map((ev) => {
    const safeTitle = hasForbiddenPattern(ev.title)
      ? '[Evidence item]'
      : sanitizeString(ev.title, 150)

    return {
      id: ev.id,
      title: safeTitle,
      type: ev.type as 'file' | 'url' | 'text',
      status: ev.status as EvidenceMeta['status'],
      // Truncate hash to 8 chars — full SHA-256 never sent to Gemini
      contentHashTruncated: ev.contentHash ? ev.contentHash.slice(0, 8) : undefined,
      createdAt: ev.createdAt.toISOString(),
      outcomeId: ev.outcomeId ?? undefined,
      indicatorId: ev.indicatorId ?? undefined,
    }
  })

  // Fetch active proxy assignments for this project with proxy metadata
  // No proxy values in Advisor context — values are financial data, not needed for step guidance
  const rawAssignments = await db
    .select({
      assignmentId: outcomeProxyAssignments.id,
      proxyId: outcomeProxyAssignments.proxyId,
      proxyName: financialProxies.name,
      confidenceLevel: financialProxies.confidenceLevel,
      methodologicalRisk: financialProxies.methodologicalRisk,
      sourceId: financialProxies.sourceId,
    })
    .from(outcomeProxyAssignments)
    .innerJoin(financialProxies, eq(financialProxies.id, outcomeProxyAssignments.proxyId))
    .where(
      and(
        eq(outcomeProxyAssignments.projectId, projectId),
        eq(outcomeProxyAssignments.organizationId, organizationId),
        eq(outcomeProxyAssignments.assignmentStatus, 'active')
      )
    )

  // Resolve source names (public/verifiable names only)
  const sourceIds = [...new Set(rawAssignments.map((a) => a.sourceId).filter(Boolean))]
  const sourcesMap = new Map<string, string>()
  if (sourceIds.length > 0) {
    for (const sid of sourceIds) {
      const source = await db
        .select({ id: proxySources.id, name: proxySources.name })
        .from(proxySources)
        .where(eq(proxySources.id, sid))
        .limit(1)
        .then((rows) => rows[0] ?? null)
      if (source) sourcesMap.set(source.id, source.name)
    }
  }

  const proxySummary: ProxyRef[] = rawAssignments.map((a) => ({
    id: a.proxyId,
    name: sanitizeString(a.proxyName, 200),
    source: a.sourceId ? sanitizeString(sourcesMap.get(a.sourceId) ?? 'Unknown source', 150) : 'Unknown source',
    // Value intentionally excluded from Advisor context — not needed for step guidance
    value: '',
    currency: '',
    confidenceLevel: a.confidenceLevel as ProxyRef['confidenceLevel'] ?? undefined,
    methodologicalRisk: a.methodologicalRisk as ProxyRef['methodologicalRisk'] ?? undefined,
  }))

  return {
    projectId,
    organizationId,
    narrativeSummary,
    outcomesSnapshot,
    indicatorsSnapshot,
    stakeholderCount,
    evidenceMetadata,
    evidenceTotal: rawEvidence.length,
    proxySummary,
    filterSetsSummary: [],
    calculationSnapshot: null,
    reportSections: [],
    projectCreatedAt: project.createdAt.toISOString(),
    lastUpdatedAt: project.updatedAt.toISOString(),
  }
}
