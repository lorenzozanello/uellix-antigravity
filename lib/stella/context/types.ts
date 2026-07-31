// lib/stella/context/types.ts
// Sprint 9B: Stella project context types - only metadata, no secrets or raw files

export interface OutcomeRef {
  id: string
  name: string
  description: string
  stakeholderGroups?: string[]
}

export interface IndicatorRef {
  id: string
  outcomeId: string
  name: string
  unit: string
  baseline?: string
}

export interface EvidenceMeta {
  id: string
  title: string
  type: 'file' | 'url' | 'text'
  status: 'draft' | 'under_review' | 'approved' | 'rejected' | 'archived'
  contentHashTruncated?: string // First 8 chars of SHA-256, never full hash
  createdAt: string
  outcomeId?: string
  indicatorId?: string
  // Resolved linkage titles (metadata only — never file paths or raw content)
  relatedOutcomeTitle?: string | null
  relatedIndicatorName?: string | null
}

export interface ProxyRef {
  id: string
  name: string
  source: string
  value: string
  currency: string
  confidenceLevel?: 'high' | 'medium' | 'low'
  methodologicalRisk?: 'low' | 'medium' | 'high'
}

export interface FilterRef {
  assignmentId: string
  deadweightPct?: number
  attributionPct?: number
  displacementPct?: number
  dropoffPct?: number
  durationYears?: number
}

export interface FunderBreakdownRef {
  funderId: string
  funderName: string
  funderType: string
  investmentUsd: number
  attributedNsvUsd: number
  sroiRatio: number
}

export interface CalculationSnapshot {
  totalInvestment: number
  grossSocialValue: number
  netSocialValue: number
  sroiRatio: number
  currency: string
  lineItemCount: number
  version: number
  // NEVER include full snapshotJson
  fundersBreakdown?: FunderBreakdownRef[]
  unattributedNsvUsd?: number
}

export interface SectionRef {
  id: string
  sectionType: string
  title: string
  contentLength: number
  status: 'draft' | 'in_progress' | 'ready_for_review'
}

export interface ContextualStakeholderRef {
  id: string
  name: string
  type: string
  description?: string | null
}

export interface ContextualActivityRef {
  id: string
  title: string
}

export interface ContextualEvidenceMetadata {
  id: string
  title: string
  type: 'file' | 'url' | 'text'
  status: 'draft' | 'under_review' | 'approved' | 'rejected' | 'archived'
  createdAt: string
  description?: string | null
  // Evidence ↔ outcome/indicator linkage: ids + resolved display names are
  // metadata and stay in the contextual contract. NO filePath, NO raw content.
  outcomeId?: string | null
  indicatorId?: string | null
  relatedOutcomeTitle?: string | null
  relatedIndicatorName?: string | null
  mimeTypeGeneral?: string | null
}

export interface ContextualProxyRef {
  id: string
  name: string
  source: string
  value: string | number | null
  currency: string | null
  isGlobalCatalog?: boolean | null
  description?: string | null
  unit?: string | null
  referenceYear?: number | null
  territory?: string | null
  country?: string | null
  methodology?: string | null
  justification?: string | null
  territorialAdjustmentNotes?: string | null
  relatedOutcomeTitle?: string | null
  relatedStakeholderName?: string | null
}

export interface ContextualCalculationSnapshot {
  totalInvestment: number | null
  grossSocialValue: number | null
  netSocialValue: number | null
  sroiRatio: number | null
  currency: string | null
  lineItemCount: number
  version: number
}

export interface ContextualCalculationReadiness {
  ready: boolean
  blockingReasons: readonly string[]
  warnings: readonly string[]
}

/**
 * Normalized calculation-readiness summary for the Advisor context.
 *
 * Producing this value never computes anything: it is either injected by the
 * authorized caller (which may consult the deterministic engine outside of
 * lib/stella) or derived by buildAdvisorContext from persisted rows only.
 * lib/stella must NEVER import lib/pipeline/sroi-calculation.
 */
export interface CalculationReadinessSummary extends ContextualCalculationReadiness {
  source: 'injected' | 'derived_from_persisted'
  latestCalculatedRunExists: boolean
  activeProxyAssignmentCount: number
  activeFilterSetCount: number
}

/** The explicit, provider-independent data contract for a contextual Advisor request. */
export interface ContextualAdvisorContext {
  projectId: string
  organizationId: string
  projectName?: string | null
  narrativeSummary?: string | null
  outcomesSnapshot?: readonly OutcomeRef[]
  indicatorsSnapshot?: readonly IndicatorRef[]
  stakeholderCount?: number
  stakeholdersSnapshot?: readonly ContextualStakeholderRef[]
  activitiesSummary?: readonly ContextualActivityRef[]
  evidenceMetadata?: readonly ContextualEvidenceMetadata[]
  evidenceTotal?: number
  proxySummary?: readonly ContextualProxyRef[]
  filterSetsSummary?: readonly FilterRef[]
  calculationSnapshot?: ContextualCalculationSnapshot | null
  calculationReadiness?: ContextualCalculationReadiness | null
  reportSections?: readonly SectionRef[]
  projectCreatedAt?: string | null
  lastUpdatedAt?: string | null
}

/**
 * The advisor production context: StellaProjectContext plus every additional
 * field of the ContextualAdvisorContext contract, all populated from
 * persisted, org-scoped data. Returned by buildAdvisorContext so the
 * contextual advisor receives real values instead of structural-subtyping
 * placeholders.
 */
export interface AdvisorProjectContext extends StellaProjectContext {
  projectName: string
  stakeholdersSnapshot: ContextualStakeholderRef[]
  activitiesSummary: ContextualActivityRef[]
  calculationReadiness: CalculationReadinessSummary
}

export interface StellaProjectContext {
  // Project identity (no PII)
  projectId: string
  organizationId: string

  // Narrative (safe to send - non-sensitive text)
  narrativeSummary: string

  // Theory of change
  outcomesSnapshot: OutcomeRef[]
  indicatorsSnapshot: IndicatorRef[]
  stakeholderCount: number

  // Evidence (only metadata, NO file content)
  evidenceMetadata: EvidenceMeta[]
  evidenceTotal: number

  // Proxies (metadata only, NO values unless needed)
  proxySummary: ProxyRef[]

  // Filters and calculation (NO full formulas, only totals)
  filterSetsSummary: FilterRef[]
  calculationSnapshot: CalculationSnapshot | null

  // Report
  reportSections: SectionRef[]
  readinessScore?: number

  // Timestamps
  projectCreatedAt: string
  lastUpdatedAt: string
}
