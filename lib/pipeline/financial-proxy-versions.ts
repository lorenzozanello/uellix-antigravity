// lib/pipeline/financial-proxy-versions.ts
// FIBIU-08 — proxy version lineage (FIBDB-006/FIBC-002/FIBC-010/FIBC-012).
// The dedicated FIBC-002 specialization for financial proxies: its own
// table, following the same ordinal + supersedes_version_id lineage shape
// as lib/pipeline/evidence-versions.ts / domain-object-versions.ts, but not
// a row inside either generic table. This module deliberately exposes no
// generic "update any field" function for provenance content — a material
// field change is FIBIU-10's atomic new-version transition, not an in-place
// edit here. What DOES mutate in place, at stage A, is the CURRENT version's
// review lifecycle (review_status/reviewer_id/reviewed_at) and — owned by
// FIBIU-09 — its rubric evaluation, mirroring evidence_versions'
// review_status write path exactly.

import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { financialProxyVersions } from '@/db/schema'

export type FinancialProxyVersion = typeof financialProxyVersions.$inferSelect

// ---------------------------------------------------------------------------
// W2-B2-R1 / R-B2-01 — the SINGLE crossing point between the two review-status
// vocabularies (W2_B2_REMEDIATION_AUTHORITY_v1.0.0
// live_to_version_review_status_mapping, FROZEN).
//
// financial_proxies.review_status is the pre-existing LIVE vocabulary;
// financial_proxy_versions.review_status is the authority-derived VERSION
// vocabulary (FIBC-013 / FIBIU-10 name 'draft'/'under_review' literally). The
// map is total, injective and onto — a bijection — so it has a well-defined
// inverse. No call site may pass a token across the boundary by any other
// means; a verbatim copy is prohibited even where the two tokens coincide
// (approved/rejected/archived), because a coincidental match is not a mapping
// and would silently break if either vocabulary changed.
// ---------------------------------------------------------------------------

export const LIVE_REVIEW_STATUSES = ['suggested', 'pending_review', 'approved', 'rejected', 'archived'] as const
export type LiveReviewStatus = (typeof LIVE_REVIEW_STATUSES)[number]

export const VERSION_REVIEW_STATUSES = ['draft', 'under_review', 'approved', 'rejected', 'archived'] as const
export type VersionReviewStatus = (typeof VERSION_REVIEW_STATUSES)[number]

const LIVE_TO_VERSION: Readonly<Record<LiveReviewStatus, VersionReviewStatus>> = {
  suggested: 'draft',
  pending_review: 'under_review',
  approved: 'approved',
  rejected: 'rejected',
  archived: 'archived',
}

const VERSION_TO_LIVE: Readonly<Record<VersionReviewStatus, LiveReviewStatus>> = {
  draft: 'suggested',
  under_review: 'pending_review',
  approved: 'approved',
  rejected: 'rejected',
  archived: 'archived',
}

/** live -> version. Throws on any token outside the live vocabulary (fail closed). */
export function toVersionReviewStatus(live: string): VersionReviewStatus {
  const mapped = (LIVE_TO_VERSION as Record<string, VersionReviewStatus | undefined>)[live]
  if (!mapped) throw new Error(`Unmapped live review status "${live}" — not a financial_proxies.review_status token`)
  return mapped
}

/** version -> live (the inverse image). Throws on any token outside the version vocabulary. */
export function toLiveReviewStatus(version: string): LiveReviewStatus {
  const mapped = (VERSION_TO_LIVE as Record<string, LiveReviewStatus | undefined>)[version]
  if (!mapped) throw new Error(`Unmapped version review status "${version}" — not a financial_proxy_versions.review_status token`)
  return mapped
}

/**
 * LIVE_VERSION_STATUS_COUPLING (frozen): at every transaction commit boundary
 * the live row's review_status MUST equal the inverse image of the CURRENT
 * version's review_status. Superseded versions keep their own sealed status
 * and are NOT constrained — that is what lets an approved V1 survive beside a
 * pending V2. Called at every transition site rather than trusting call-site
 * discipline; a violation is a bug in the transition, so it throws and the
 * enclosing transaction rolls back.
 */
export function assertLiveVersionStatusCoupling(
  liveReviewStatus: string,
  currentVersionReviewStatus: string,
): void {
  const expectedVersion = toVersionReviewStatus(liveReviewStatus)
  if (expectedVersion !== currentVersionReviewStatus) {
    throw new Error(
      `LIVE_VERSION_STATUS_COUPLING violated: live "${liveReviewStatus}" maps to version "${expectedVersion}" but the current version is "${currentVersionReviewStatus}"`
    )
  }
}

/**
 * Same shape as lib/pipeline/fx.ts's FxRateExecutor — a `db`-or-transaction
 * handle. Approval sealing (FIBC-012) must commit atomically with the
 * financial_proxies row it approves: both writes take the SAME `tx` from
 * withLockedFinancialProxy/withExpectedLockedFinancialProxy, never a
 * separate, later transaction that could observe a torn state.
 */
export type FinancialProxyVersionExecutor = Pick<typeof db, 'select' | 'insert' | 'update'>

export interface CreateFinancialProxyVersionInput {
  organizationId: string | null
  financialProxyId: string
  sourceId: string
  value: string | null
  currency: string | null
  unit: string | null
  referenceYear: number | null
  valueUsd: string | null
  fxRateId: string | null
  country: string | null
  territory: string | null
  thematicArea: string | null
  methodology: string | null
  geographicContextualScope: string | null
  linkedOutcomeContext: string | null
  recoverableReference: string | null
  relevanceJustification: string | null
  documentedTransformations: string | null
  consultationDate: Date | null
  // FIBIU-09 (FIBC-011) — optional at creation (a fresh version's rubric is
  // unrated until a human evaluates it via recordProxyRubricEvaluation).
  // The one exception is promoteProxyToGlobal's clone, which carries an
  // already-rated source version's rubric across rather than resetting it
  // to unrated on an operation that changes no underlying evidence.
  c1SourceQualityVerifiability?: number | null
  c2OutcomeCorrespondence?: number | null
  c3StakeholderPopulationFit?: number | null
  c4GeographicContextFit?: number | null
  c5TemporalFit?: number | null
  c6MethodologicalUnitComparability?: number | null
  r1ProvenanceRisk?: number | null
  r2SourceLimitationRisk?: number | null
  r3ConceptualFitRisk?: number | null
  r4GeographicPopulationTransferRisk?: number | null
  r5TemporalObsolescenceRisk?: number | null
  r6TransformationRisk?: number | null
  r7MethodologicalUncertaintyRisk?: number | null
  confidenceScore?: number | null
  confidenceLevel?: string | null
  methodologicalRiskScore?: number | null
  methodologicalRisk?: string | null
  rubricVersion?: string | null
  exceptionalDefendibilityDetermination?: string | null
  reviewStatus: string
  createdBy: string
}

/**
 * Append a new version for a financial proxy. Ordinal is one past the
 * current maximum for that proxy (1 for the first version);
 * supersedesVersionId links to the version that was current before this
 * call, or null when this is the proxy's first version. Mirrors
 * createEvidenceVersion's select-max-then-insert-under-a-unique-index shape.
 */
export async function createFinancialProxyVersion(
  input: CreateFinancialProxyVersionInput,
  executor: FinancialProxyVersionExecutor = db
): Promise<FinancialProxyVersion> {
  const current = await getLatestFinancialProxyVersion(input.financialProxyId, executor)
  const ordinal = (current?.ordinal ?? 0) + 1

  const [created] = await executor
    .insert(financialProxyVersions)
    .values({
      organizationId: input.organizationId,
      financialProxyId: input.financialProxyId,
      ordinal,
      sourceId: input.sourceId,
      value: input.value,
      currency: input.currency,
      unit: input.unit,
      referenceYear: input.referenceYear,
      valueUsd: input.valueUsd,
      fxRateId: input.fxRateId,
      country: input.country,
      territory: input.territory,
      thematicArea: input.thematicArea,
      methodology: input.methodology,
      geographicContextualScope: input.geographicContextualScope,
      linkedOutcomeContext: input.linkedOutcomeContext,
      recoverableReference: input.recoverableReference,
      relevanceJustification: input.relevanceJustification,
      documentedTransformations: input.documentedTransformations,
      consultationDate: input.consultationDate,
      c1SourceQualityVerifiability: input.c1SourceQualityVerifiability ?? null,
      c2OutcomeCorrespondence: input.c2OutcomeCorrespondence ?? null,
      c3StakeholderPopulationFit: input.c3StakeholderPopulationFit ?? null,
      c4GeographicContextFit: input.c4GeographicContextFit ?? null,
      c5TemporalFit: input.c5TemporalFit ?? null,
      c6MethodologicalUnitComparability: input.c6MethodologicalUnitComparability ?? null,
      r1ProvenanceRisk: input.r1ProvenanceRisk ?? null,
      r2SourceLimitationRisk: input.r2SourceLimitationRisk ?? null,
      r3ConceptualFitRisk: input.r3ConceptualFitRisk ?? null,
      r4GeographicPopulationTransferRisk: input.r4GeographicPopulationTransferRisk ?? null,
      r5TemporalObsolescenceRisk: input.r5TemporalObsolescenceRisk ?? null,
      r6TransformationRisk: input.r6TransformationRisk ?? null,
      r7MethodologicalUncertaintyRisk: input.r7MethodologicalUncertaintyRisk ?? null,
      confidenceScore: input.confidenceScore ?? null,
      confidenceLevel: input.confidenceLevel ?? null,
      methodologicalRiskScore: input.methodologicalRiskScore ?? null,
      methodologicalRisk: input.methodologicalRisk ?? null,
      rubricVersion: input.rubricVersion ?? null,
      exceptionalDefendibilityDetermination: input.exceptionalDefendibilityDetermination ?? null,
      reviewStatus: input.reviewStatus,
      supersedesVersionId: current?.id ?? null,
      createdBy: input.createdBy,
    })
    .returning()

  return created
}

/** The current (highest-ordinal) version for a financial proxy, or null if it has never been versioned. */
export async function getLatestFinancialProxyVersion(
  financialProxyId: string,
  executor: FinancialProxyVersionExecutor = db
): Promise<FinancialProxyVersion | null> {
  const rows = await executor
    .select()
    .from(financialProxyVersions)
    .where(eq(financialProxyVersions.financialProxyId, financialProxyId))
    .orderBy(desc(financialProxyVersions.ordinal))
    .limit(1)
  return rows[0] ?? null
}

/**
 * W2-B2-R1 / R-B2-05 (M7-DERIVED) — the current APPROVED version: the
 * highest-ordinal version whose review_status is 'approved'. FIBC-012:
 * "Eligibility binds to the exact approved version." Binding the latest
 * version regardless of status (the pre-remediation shape) silently bound a
 * fresh 'under_review' fork and left the assignment permanently ineligible.
 * Null when the proxy has no approved version at all — the caller must
 * refuse, never bind NULL or a draft.
 */
export async function getCurrentApprovedFinancialProxyVersion(
  financialProxyId: string,
  executor: FinancialProxyVersionExecutor = db
): Promise<FinancialProxyVersion | null> {
  const rows = await executor
    .select()
    .from(financialProxyVersions)
    .where(and(eq(financialProxyVersions.financialProxyId, financialProxyId), eq(financialProxyVersions.reviewStatus, 'approved')))
    .orderBy(desc(financialProxyVersions.ordinal))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Batch form of getLatestFinancialProxyVersion, keyed by financialProxyId.
 * Used by the calculation engine's approval-eligibility check across many
 * proxies at once.
 */
export async function getLatestFinancialProxyVersionsByProxyIds(
  financialProxyIds: readonly string[]
): Promise<Map<string, FinancialProxyVersion>> {
  if (financialProxyIds.length === 0) return new Map()

  const rows = await db
    .select()
    .from(financialProxyVersions)
    .where(inArray(financialProxyVersions.financialProxyId, financialProxyIds))

  const latest = new Map<string, FinancialProxyVersion>()
  for (const row of rows) {
    const existing = latest.get(row.financialProxyId)
    if (!existing || row.ordinal > existing.ordinal) latest.set(row.financialProxyId, row)
  }
  return latest
}

/** Full lineage for a financial proxy, oldest first. Empty for a never-versioned proxy (should not occur post-backfill). */
export async function listFinancialProxyVersions(financialProxyId: string): Promise<FinancialProxyVersion[]> {
  return db
    .select()
    .from(financialProxyVersions)
    .where(eq(financialProxyVersions.financialProxyId, financialProxyId))
    .orderBy(financialProxyVersions.ordinal)
}

/** Read a specific version by id, or null. Used to resolve an assignment's frozen financialProxyVersionId. */
export async function getFinancialProxyVersionById(versionId: string): Promise<FinancialProxyVersion | null> {
  const rows = await db
    .select()
    .from(financialProxyVersions)
    .where(eq(financialProxyVersions.id, versionId))
  return rows[0] ?? null
}

/**
 * Seal (or otherwise transition) the review lifecycle of the CURRENT
 * (latest-ordinal) version row for a proxy. FIBC-012's actual fix:
 * reviewer_id/reviewed_at are written HERE, on the version, not merely
 * logged. Stage-A only — FIBDB-006's approved-version immutability is
 * stage-E hardening, deferred (see the schema comment), so this stays open
 * regardless of reviewStatus, the same way updateCurrentEvidenceVersion
 * does for evidence.
 */
export async function updateCurrentFinancialProxyVersion(
  financialProxyId: string,
  patch: Partial<
    Pick<
      FinancialProxyVersion,
      | 'reviewStatus'
      | 'reviewerId'
      | 'reviewedAt'
      | 'valueUsd'
      | 'fxRateId'
      // FIBIU-10 (FIBC-013) — a material edit to a version that is NOT yet
      // approved rides the SAME version in place (no fork needed; there is
      // no approval to protect). Added here rather than left version-stale,
      // which would have let the version silently diverge from the live
      // financial_proxies row on every non-approved edit.
      | 'sourceId'
      | 'value'
      | 'currency'
      | 'unit'
      | 'referenceYear'
      | 'country'
      | 'territory'
      | 'thematicArea'
      | 'methodology'
      | 'geographicContextualScope'
      | 'linkedOutcomeContext'
      | 'recoverableReference'
      | 'relevanceJustification'
      | 'documentedTransformations'
      | 'consultationDate'
      | 'c1SourceQualityVerifiability'
      | 'c2OutcomeCorrespondence'
      | 'c3StakeholderPopulationFit'
      | 'c4GeographicContextFit'
      | 'c5TemporalFit'
      | 'c6MethodologicalUnitComparability'
      | 'r1ProvenanceRisk'
      | 'r2SourceLimitationRisk'
      | 'r3ConceptualFitRisk'
      | 'r4GeographicPopulationTransferRisk'
      | 'r5TemporalObsolescenceRisk'
      | 'r6TransformationRisk'
      | 'r7MethodologicalUncertaintyRisk'
      | 'confidenceScore'
      | 'confidenceLevel'
      | 'methodologicalRiskScore'
      | 'methodologicalRisk'
      | 'rubricVersion'
      | 'exceptionalDefendibilityDetermination'
    >
  >,
  executor: FinancialProxyVersionExecutor = db
): Promise<FinancialProxyVersion | null> {
  const current = await getLatestFinancialProxyVersion(financialProxyId, executor)
  if (!current) return null

  const [updated] = await executor
    .update(financialProxyVersions)
    .set(patch)
    .where(and(eq(financialProxyVersions.id, current.id), eq(financialProxyVersions.financialProxyId, financialProxyId)))
    .returning()

  return updated ?? null
}

/**
 * W2-B2-R1 / R-B2-02 — FIBC-010's approval gate, widened from the single
 * recoverable-reference check to the TEN approval-blocking items frozen in
 * W2_B2_REMEDIATION_AUTHORITY_v1.0.0 organization_provenance_requirements
 * (closes B2-AR-B2's gate half). Each item has its own named error so a
 * rejection says which item is missing. Ordered as FIBC-010 enumerates
 * them; item 8 (consultation_date) is the ONLY item FIBC-010 qualifies
 * ('where relevant') and is therefore RECORDABLE-REQUIRED but NOT
 * approval-blocking — it is deliberately absent from this list.
 *
 * The actor and moment (reviewer_id/reviewed_at) are system-recorded at
 * the approval transition by the caller, never user-supplied, so they are
 * not gated here either.
 */
export const APPROVAL_BLOCKING_PROVENANCE_ITEMS = [
  { item: 1, column: 'value', label: 'value' },
  { item: 2, column: 'unit', label: 'unit' },
  { item: 3, column: 'currency', label: 'currency' },
  { item: 4, column: 'referenceYear', label: 'reference year' },
  { item: 5, column: 'geographicContextualScope', label: 'geographic/contextual scope' },
  { item: 6, column: 'linkedOutcomeContext', label: 'linked outcome' },
  { item: 7, column: 'sourceId', label: 'identifiable source' },
  { item: 9, column: 'recoverableReference', label: 'recoverable reference (URL/DOI/dataset id/linked document)' },
  { item: 10, column: 'relevanceJustification', label: 'relevance justification' },
  { item: 11, column: 'documentedTransformations', label: 'documented transformations (an explicit "none" is a valid recorded value)' },
] as const

export type ApprovalBlockingProvenanceColumn = (typeof APPROVAL_BLOCKING_PROVENANCE_ITEMS)[number]['column']

function provenanceItemPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

export function assertApprovableProvenance(
  version: Pick<FinancialProxyVersion, ApprovalBlockingProvenanceColumn> | null
): asserts version is NonNullable<typeof version> {
  if (!version) throw new Error('Cannot approve: proxy has no version to approve')
  for (const { item, column, label } of APPROVAL_BLOCKING_PROVENANCE_ITEMS) {
    if (!provenanceItemPresent(version[column])) {
      throw new Error(`Cannot approve without ${label} (FIBC-010 item ${item}: ${column})`)
    }
  }
}
