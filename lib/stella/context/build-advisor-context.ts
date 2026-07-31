// lib/stella/context/build-advisor-context.ts
// Sprint 9C-1: Build StellaProjectContext for Advisor from project metadata
// FABLE MOONSHOT WS1 / U2: populate the full ContextualAdvisorContext contract
// with real persisted values (no structural-subtyping placeholders).
// Security: metadata only, no raw file content, no PII, no secrets, no cross-org data.
// Boundary: NEVER import lib/pipeline/sroi-calculation — persisted results are
// read, nothing is ever computed here.

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
  theoryOfChangeNodes,
  sroiFilterSets,
  sroiCalculationRuns,
  sroiCalculationLineItems,
  sroiReportSections,
} from '@/db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { sanitizeString, sanitizeNarrative, hasForbiddenPattern } from './sanitize'
import type {
  AdvisorProjectContext,
  CalculationReadinessSummary,
  ContextualCalculationReadiness,
  CalculationSnapshot,
  ContextualActivityRef,
  ContextualStakeholderRef,
  OutcomeRef,
  IndicatorRef,
  EvidenceMeta,
  ProxyRef,
  FilterRef,
  SectionRef,
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

export interface BuildAdvisorContextOptions {
  /**
   * Live readiness summary injected by the authorized caller. When absent, a
   * minimal summary is derived from persisted data (latest run existence and
   * counts) — the calculation engine is never imported or executed here.
   *
   * The caller may pass just the core readiness verdict
   * (ready/blockingReasons/warnings, e.g. mapped from the deterministic
   * engine's own check in the app layer); the persisted-row counts are always
   * derived here and merged, and `source` is forced to 'injected'.
   */
  calculationReadiness?: ContextualCalculationReadiness | CalculationReadinessSummary
}

export async function buildAdvisorContext(
  projectId: string,
  organizationId: string,
  // Accepted for call-signature compatibility with callers (e.g. advisor.ts,
  // which always passes the current pipeline step) — no longer branches on
  // it now that every step (including Calculation) is supported.
  step: string,
  // INTEGRATION(coordinator): pass live readiness from
  // app/actions/stella/advisor.ts as
  // `buildAdvisorContext(projectId, orgId, step, { calculationReadiness })`,
  // built outside lib/stella (e.g. from the deterministic engine's own
  // readiness check). Until wired, the derived-from-persisted summary below
  // is used.
  options?: BuildAdvisorContextOptions
): Promise<AdvisorProjectContext> {
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

  const projectName = hasForbiddenPattern(project.name)
    ? '[Project]'
    : sanitizeString(project.name, 200)

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

  // Fetch stakeholder groups — group-level metadata only (name + type).
  // NO individual people, NO emails, NO descriptions (minimization pattern).
  const rawStakeholders = await db
    .select({
      id: stakeholderGroups.id,
      name: stakeholderGroups.name,
      type: stakeholderGroups.type,
    })
    .from(stakeholderGroups)
    .where(eq(stakeholderGroups.projectId, projectId))

  const stakeholderCount = rawStakeholders.length
  const stakeholdersSnapshot: ContextualStakeholderRef[] = rawStakeholders.map((s) => ({
    id: s.id,
    name: hasForbiddenPattern(s.name) ? '[Stakeholder group]' : sanitizeString(s.name, 200),
    type: sanitizeString(s.type ?? '', 100),
  }))

  // Fetch outcomes (title + type — no descriptions that might contain PII)
  // stakeholderGroupId carries the real outcome ↔ stakeholder-group linkage.
  // Group-level ids only (they resolve to name/type via stakeholdersSnapshot)
  // — no individual people, no PII.
  const rawOutcomes = await db
    .select({
      id: outcomes.id,
      title: outcomes.title,
      outcomeType: outcomes.outcomeType,
      status: outcomes.status,
      stakeholderGroupId: outcomes.stakeholderGroupId,
    })
    .from(outcomes)
    .where(and(eq(outcomes.projectId, projectId), eq(outcomes.status, 'active')))

  const outcomesSnapshot: OutcomeRef[] = rawOutcomes.map((o) => ({
    id: o.id,
    name: sanitizeString(o.title, 200),
    description: o.outcomeType ? sanitizeString(o.outcomeType, 100) : '',
    stakeholderGroups: o.stakeholderGroupId ? [o.stakeholderGroupId] : [],
  }))
  const outcomeTitleById = new Map(outcomesSnapshot.map((o) => [o.id, o.name]))

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
  const indicatorNameById = new Map(indicatorsSnapshot.map((i) => [i.id, i.name]))

  // Fetch evidence metadata — NO filePath, NO raw content, NO storage paths.
  // Outcome/indicator linkage (ids + resolved titles) IS metadata and is kept.
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
      ...(ev.outcomeId ? { relatedOutcomeTitle: outcomeTitleById.get(ev.outcomeId) ?? null } : {}),
      ...(ev.indicatorId ? { relatedIndicatorName: indicatorNameById.get(ev.indicatorId) ?? null } : {}),
    }
  })

  // Fetch active proxy assignments for this project with proxy metadata.
  // Value/currency are registered reference metadata the advisor may cite —
  // it must never convert, recalculate, or approve them (prompt-enforced).
  const rawAssignments = await db
    .select({
      assignmentId: outcomeProxyAssignments.id,
      proxyId: outcomeProxyAssignments.proxyId,
      proxyName: financialProxies.name,
      confidenceLevel: financialProxies.confidenceLevel,
      methodologicalRisk: financialProxies.methodologicalRisk,
      sourceId: financialProxies.sourceId,
      value: financialProxies.value,
      currency: financialProxies.currency,
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
    // Registered proxy value/currency from the proxies table — reference data
    // only; the deterministic engine remains the only calculator.
    value: a.value ?? '',
    currency: a.currency ?? '',
    confidenceLevel: a.confidenceLevel as ProxyRef['confidenceLevel'] ?? undefined,
    methodologicalRisk: a.methodologicalRisk as ProxyRef['methodologicalRisk'] ?? undefined,
  }))

  // Theory-of-change activities — title-level metadata only
  const rawActivities = await db
    .select({
      id: theoryOfChangeNodes.id,
      title: theoryOfChangeNodes.title,
    })
    .from(theoryOfChangeNodes)
    .where(
      and(
        eq(theoryOfChangeNodes.projectId, projectId),
        eq(theoryOfChangeNodes.organizationId, organizationId),
        eq(theoryOfChangeNodes.nodeType, 'activity'),
        eq(theoryOfChangeNodes.status, 'active')
      )
    )

  const activitiesSummary: ContextualActivityRef[] = rawActivities.map((a) => ({
    id: a.id,
    title: hasForbiddenPattern(a.title) ? '[Activity]' : sanitizeString(a.title, 200),
  }))

  // Filter set percentages for this project's active assignments
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

  // Latest PERSISTED calculation run — reading stored totals is allowed;
  // computing is not. snapshotJson is intentionally never selected.
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

  // Existing report sections — metadata only (type, title, length, status)
  const rawSections = await db
    .select({
      id: sroiReportSections.id,
      sectionType: sroiReportSections.sectionType,
      title: sroiReportSections.title,
      content: sroiReportSections.content,
    })
    .from(sroiReportSections)
    .where(
      and(
        eq(sroiReportSections.projectId, projectId),
        eq(sroiReportSections.organizationId, organizationId)
      )
    )

  const reportSections: SectionRef[] = rawSections.map((s) => ({
    id: s.id,
    sectionType: s.sectionType,
    title: sanitizeString(s.title, 200),
    contentLength: s.content?.length ?? 0,
    status: s.content && s.content.length > 0 ? 'in_progress' : 'draft',
  }))

  // Calculation readiness — injected by the authorized caller (merged over
  // the derived persisted-row counts), or fully derived. Never computed here.
  const derivedReadiness = deriveCalculationReadiness({
    latestCalculatedRunExists: latestRun !== null,
    activeProxyAssignmentCount: rawAssignments.length,
    activeFilterSetCount: rawFilterSets.length,
    evidenceTotal: rawEvidence.length,
    outcomeCount: rawOutcomes.length,
  })
  const calculationReadiness: CalculationReadinessSummary = options?.calculationReadiness
    ? { ...derivedReadiness, ...options.calculationReadiness, source: 'injected' }
    : derivedReadiness

  return {
    projectId,
    organizationId,
    projectName,
    narrativeSummary,
    outcomesSnapshot,
    indicatorsSnapshot,
    stakeholderCount,
    stakeholdersSnapshot,
    activitiesSummary,
    evidenceMetadata,
    evidenceTotal: rawEvidence.length,
    proxySummary,
    filterSetsSummary,
    calculationSnapshot,
    calculationReadiness,
    reportSections,
    projectCreatedAt: project.createdAt.toISOString(),
    lastUpdatedAt: project.updatedAt.toISOString(),
  }
}

function deriveCalculationReadiness(persisted: {
  latestCalculatedRunExists: boolean
  activeProxyAssignmentCount: number
  activeFilterSetCount: number
  evidenceTotal: number
  outcomeCount: number
}): CalculationReadinessSummary {
  const blockingReasons: string[] = []
  const warnings: string[] = []

  if (!persisted.latestCalculatedRunExists) {
    blockingReasons.push('No existe un cálculo SROI persistido para este proyecto.')
  }
  if (persisted.activeProxyAssignmentCount === 0) {
    blockingReasons.push('No hay asignaciones de proxy activas registradas.')
  }
  if (persisted.activeFilterSetCount === 0) {
    warnings.push('No hay conjuntos de filtros SROI activos registrados.')
  }
  if (persisted.outcomeCount === 0) {
    warnings.push('No hay outcomes activos registrados.')
  }
  if (persisted.evidenceTotal === 0) {
    warnings.push('No hay evidencia registrada para respaldar los outcomes.')
  }

  return {
    ready: blockingReasons.length === 0,
    blockingReasons,
    warnings,
    source: 'derived_from_persisted',
    latestCalculatedRunExists: persisted.latestCalculatedRunExists,
    activeProxyAssignmentCount: persisted.activeProxyAssignmentCount,
    activeFilterSetCount: persisted.activeFilterSetCount,
  }
}
