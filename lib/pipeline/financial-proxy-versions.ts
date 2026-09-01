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
 * FIBIU-08's own EXIT_GATE/TESTS clause names exactly two conditions
 * `approved` is impossible without: "a recordable actor and moment" (the
 * caller's own identity — always available, enforced by writing reviewer_id
 * /reviewed_at, not by this function) and "a recoverable reference". This
 * is the second half: a bare institution name or domain is insufficient
 * (FIBC-010's own words), so the version being approved must carry a real
 * recoverable_reference (URL/DOI/dataset id/linked document) before
 * `updateCurrentFinancialProxyVersion` is ever asked to seal it approved.
 *
 * Deliberately does NOT block on the other FIBC-010 provenance fields
 * (geographic/contextual scope, linked-outcome context, relevance
 * justification, documented transformations) — the sealed unit's TESTS
 * clause names only these two as gated conditions; the rest are recordable
 * fields on the full-provenance form, not additional invented approval
 * gates.
 */
export function assertApprovableProvenance(
  version: Pick<FinancialProxyVersion, 'recoverableReference'> | null
): asserts version is NonNullable<typeof version> {
  if (!version) throw new Error('Cannot approve: proxy has no version to approve')
  if (!version.recoverableReference || version.recoverableReference.trim().length === 0) {
    throw new Error('Cannot approve without a recoverable reference (URL/DOI/dataset id/linked document)')
  }
}
