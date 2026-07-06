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
