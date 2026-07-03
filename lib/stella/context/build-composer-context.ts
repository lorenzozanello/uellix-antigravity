// lib/stella/context/build-composer-context.ts
// Build StellaProjectContext for Composer, scoped to a specific report/section.
// Security: metadata only, no raw files, no PII, no full snapshotJson, no cross-org data.

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
  sroiFilterSets,
  sroiCalculationRuns,
  sroiCalculationLineItems,
  sroiRunReviews,
  sroiReports,
  sroiReportSections,
} from '@/db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { sanitizeString, sanitizeNarrative, hasForbiddenPattern } from './sanitize'
import type {
  StellaProjectContext,
  OutcomeRef,
  IndicatorRef,
  EvidenceMeta,
  ProxyRef,
  FilterRef,
  CalculationSnapshot,
  SectionRef,
} from './types'

export class StellaBuildComposerContextError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'UNAUTHORIZED',
    message: string
  ) {
    super(message)
    this.name = 'StellaBuildComposerContextError'
  }
}

export async function buildComposerContext(
  projectId: string,
  organizationId: string,
  reportId: string
): Promise<StellaProjectContext> {
  // Project ownership check
  const project = await db
    .select({
      id: projects.id,
      organizationId: projects.organizationId,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!project) {
    throw new StellaBuildComposerContextError('NOT_FOUND', 'Project not found')
  }
  if (project.organizationId !== organizationId) {
    throw new StellaBuildComposerContextError('UNAUTHORIZED', 'Project does not belong to your organization')
  }

  // Report ownership check — must belong to this project and organization
  const report = await db
    .select({ id: sroiReports.id, organizationId: sroiReports.organizationId, projectId: sroiReports.projectId })
    .from(sroiReports)
    .where(eq(sroiReports.id, reportId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!report) {
    throw new StellaBuildComposerContextError('NOT_FOUND', 'Report not found')
  }
  if (report.organizationId !== organizationId || report.projectId !== projectId) {
    throw new StellaBuildComposerContextError('UNAUTHORIZED', 'Report does not belong to this project/organization')
  }

  // Narrative summary
  const narrative = await db
    .select({
      narrativeText: impactNarratives.narrativeText,
      theoryOfChangeSummary: impactNarratives.theoryOfChangeSummary,
    })
    .from(impactNarratives)
    .where(eq(impactNarratives.projectId, projectId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  const rawNarrative = [narrative?.narrativeText ?? '', narrative?.theoryOfChangeSummary ?? '']
    .filter(Boolean)
    .join(' ')
  const narrativeSummary = sanitizeNarrative(rawNarrative)

  // Stakeholder count (no PII, no emails)
  const rawStakeholders = await db
    .select({ id: stakeholderGroups.id })
    .from(stakeholderGroups)
    .where(eq(stakeholderGroups.projectId, projectId))

  const stakeholderCount = rawStakeholders.length

  // Outcomes (title + type metadata — no descriptions to avoid PII)
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

  // Indicators (name + unit — no raw values)
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

  // Evidence metadata — filePath excluded, hash truncated to 8 chars
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

  const evidenceMetadata: EvidenceMeta[] = rawEvidence.map((ev) => ({
    id: ev.id,
    title: hasForbiddenPattern(ev.title) ? '[Evidence item]' : sanitizeString(ev.title, 150),
    type: ev.type as 'file' | 'url' | 'text',
    status: ev.status as EvidenceMeta['status'],
    contentHashTruncated: ev.contentHash ? ev.contentHash.slice(0, 8) : undefined,
    createdAt: ev.createdAt.toISOString(),
    outcomeId: ev.outcomeId ?? undefined,
    indicatorId: ev.indicatorId ?? undefined,
  }))

  // Proxy confidence/risk metadata — financial values excluded
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

  const sourceIds = [...new Set(rawAssignments.map((a) => a.sourceId).filter(Boolean))]
  const sourcesMap = new Map<string, string>()
  for (const sid of sourceIds) {
    const source = await db
      .select({ id: proxySources.id, name: proxySources.name })
      .from(proxySources)
      .where(eq(proxySources.id, sid))
      .limit(1)
      .then((rows) => rows[0] ?? null)
    if (source) sourcesMap.set(source.id, source.name)
  }

  const proxySummary: ProxyRef[] = rawAssignments.map((a) => ({
    id: a.proxyId,
    name: sanitizeString(a.proxyName, 200),
    source: a.sourceId
      ? sanitizeString(sourcesMap.get(a.sourceId) ?? 'Unknown source', 150)
      : 'Unknown source',
    value: '', // Financial values excluded — calculationSnapshot.sroiRatio provides the ratio
    currency: '',
    confidenceLevel: (a.confidenceLevel as ProxyRef['confidenceLevel']) ?? undefined,
    methodologicalRisk: (a.methodologicalRisk as ProxyRef['methodologicalRisk']) ?? undefined,
  }))

  // Filter set percentages
  const rawFilterSets = await db
    .select({
      assignmentId: sroiFilterSets.assignmentId,
      deadweightPct: sroiFilterSets.deadweightPct,
      displacementPct: sroiFilterSets.displacementPct,
      attributionPct: sroiFilterSets.attributionPct,
      dropoffPct: sroiFilterSets.dropoffPct,
      durationYears: sroiFilterSets.durationYears,
    })
    .from(sroiFilterSets)
    .innerJoin(
      outcomeProxyAssignments,
      eq(outcomeProxyAssignments.id, sroiFilterSets.assignmentId)
    )
    .where(
      and(
        eq(outcomeProxyAssignments.projectId, projectId),
        eq(sroiFilterSets.organizationId, organizationId),
        eq(sroiFilterSets.status, 'active')
      )
    )

  const filterSetsSummary: FilterRef[] = rawFilterSets.map((f) => ({
    assignmentId: f.assignmentId,
    deadweightPct: f.deadweightPct ? parseFloat(f.deadweightPct) : undefined,
    attributionPct: f.attributionPct ? parseFloat(f.attributionPct) : undefined,
    displacementPct: f.displacementPct ? parseFloat(f.displacementPct) : undefined,
    dropoffPct: f.dropoffPct ? parseFloat(f.dropoffPct) : undefined,
    durationYears: f.durationYears ?? undefined,
  }))

  // Latest SROI calculation run — totals only, snapshotJson NEVER included
  const latestRun = await db
    .select({
      id: sroiCalculationRuns.id,
      version: sroiCalculationRuns.version,
      currency: sroiCalculationRuns.currency,
      totalInvestment: sroiCalculationRuns.totalInvestment,
      grossSocialValue: sroiCalculationRuns.grossSocialValue,
      netSocialValue: sroiCalculationRuns.netSocialValue,
      sroiRatio: sroiCalculationRuns.sroiRatio,
    })
    .from(sroiCalculationRuns)
    .where(
      and(
        eq(sroiCalculationRuns.projectId, projectId),
        eq(sroiCalculationRuns.organizationId, organizationId),
        eq(sroiCalculationRuns.status, 'calculated')
      )
    )
    .orderBy(desc(sroiCalculationRuns.runDate))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  let calculationSnapshot: CalculationSnapshot | null = null

  if (latestRun) {
    const lineItems = await db
      .select({ id: sroiCalculationLineItems.id })
      .from(sroiCalculationLineItems)
      .where(eq(sroiCalculationLineItems.runId, latestRun.id))

    calculationSnapshot = {
      totalInvestment: parseFloat(latestRun.totalInvestment ?? '0'),
      grossSocialValue: parseFloat(latestRun.grossSocialValue ?? '0'),
      netSocialValue: parseFloat(latestRun.netSocialValue ?? '0'),
      sroiRatio: parseFloat(latestRun.sroiRatio ?? '0'),
      currency: latestRun.currency ?? 'USD',
      lineItemCount: lineItems.length,
      version: latestRun.version,
    }
  }

  // Readiness score from latest run review
  const latestReview = await db
    .select({ readinessScore: sroiRunReviews.readinessScore })
    .from(sroiRunReviews)
    .where(
      and(
        eq(sroiRunReviews.projectId, projectId),
        eq(sroiRunReviews.organizationId, organizationId)
      )
    )
    .orderBy(desc(sroiRunReviews.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  // Existing report sections — gives Composer awareness of what's already
  // drafted, to avoid duplicating content across sections.
  const rawSections = await db
    .select({
      id: sroiReportSections.id,
      sectionType: sroiReportSections.sectionType,
      title: sroiReportSections.title,
      content: sroiReportSections.content,
    })
    .from(sroiReportSections)
    .where(eq(sroiReportSections.reportId, reportId))

  const reportSections: SectionRef[] = rawSections.map((s) => ({
    id: s.id,
    sectionType: s.sectionType,
    title: sanitizeString(s.title, 200),
    contentLength: s.content?.length ?? 0,
    status: s.content && s.content.length > 0 ? 'in_progress' : 'draft',
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
    filterSetsSummary,
    calculationSnapshot,
    reportSections,
    readinessScore: latestReview?.readinessScore ?? undefined,
    projectCreatedAt: project.createdAt.toISOString(),
    lastUpdatedAt: project.updatedAt.toISOString(),
  }
}
