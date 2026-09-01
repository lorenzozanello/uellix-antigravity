// lib/pipeline/evidence-versions.ts
// FIBIU-04 — evidence version lineage (FIBDB-005/FIBC-002/FIBC-006). The
// dedicated FIBC-002 specialization for evidence: its own table, following
// the same ordinal + supersedes_version_id lineage shape as
// lib/pipeline/domain-object-versions.ts, but not a row inside that generic
// table. This module deliberately exposes no update/delete function for
// content itself — mutations to sensitivity/treatment/review_status/
// erasure_state go through the dedicated FIBIU-05/06/07 write paths in
// lib/pipeline/evidence.ts, which is where their own fail-closed gates live.

import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { evidenceVersions } from '@/db/schema'

export type EvidenceVersion = typeof evidenceVersions.$inferSelect

export interface CreateEvidenceVersionInput {
  organizationId: string
  evidenceId: string
  content: string | null
  contentHash: string | null
  reviewStatus: string
  legacyContentUnverifiable: boolean
  createdBy: string
}

/**
 * Append a new version for an evidence item. Ordinal is one past the current
 * maximum for that evidence (1 for the first version); supersedesVersionId
 * links to the version that was current before this call, or null when this
 * is the evidence item's first version. Mirrors createDomainObjectVersion's
 * select-max-then-insert-under-a-unique-index shape.
 */
export async function createEvidenceVersion(input: CreateEvidenceVersionInput): Promise<EvidenceVersion> {
  const current = await getLatestEvidenceVersion(input.evidenceId)
  const ordinal = (current?.ordinal ?? 0) + 1

  const [created] = await db
    .insert(evidenceVersions)
    .values({
      organizationId: input.organizationId,
      evidenceId: input.evidenceId,
      ordinal,
      content: input.content,
      contentHash: input.contentHash,
      reviewStatus: input.reviewStatus,
      legacyContentUnverifiable: input.legacyContentUnverifiable,
      supersedesVersionId: current?.id ?? null,
      createdBy: input.createdBy,
    })
    .returning()

  return created
}

/** The current (highest-ordinal) version for an evidence item, or null if it has never been versioned. */
export async function getLatestEvidenceVersion(evidenceId: string): Promise<EvidenceVersion | null> {
  const rows = await db
    .select()
    .from(evidenceVersions)
    .where(eq(evidenceVersions.evidenceId, evidenceId))
    .orderBy(desc(evidenceVersions.ordinal))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Batch form of getLatestEvidenceVersion, keyed by evidenceId. Used by
 * cross-cutting read paths (FIBIU-05: report/public-verify, Stella advisor
 * context) that need the current classification for many evidence items at
 * once. Reduces in application code rather than a DISTINCT ON query — every
 * write path in this unit creates exactly one version per evidence item, so
 * a plain max-by-ordinal reduction is exact, not an approximation.
 */
export async function getLatestEvidenceVersionsByEvidenceIds(
  evidenceIds: readonly string[]
): Promise<Map<string, EvidenceVersion>> {
  if (evidenceIds.length === 0) return new Map()

  const rows = await db
    .select()
    .from(evidenceVersions)
    .where(inArray(evidenceVersions.evidenceId, evidenceIds))

  const latest = new Map<string, EvidenceVersion>()
  for (const row of rows) {
    const existing = latest.get(row.evidenceId)
    if (!existing || row.ordinal > existing.ordinal) latest.set(row.evidenceId, row)
  }
  return latest
}

/** Full lineage for an evidence item, oldest first. Empty for a never-versioned item (should not occur post-backfill). */
export async function listEvidenceVersions(evidenceId: string): Promise<EvidenceVersion[]> {
  return db
    .select()
    .from(evidenceVersions)
    .where(eq(evidenceVersions.evidenceId, evidenceId))
    .orderBy(evidenceVersions.ordinal)
}

/**
 * Update the mutable fields of the CURRENT (latest-ordinal) version row for
 * an evidence item. Stage-A only: FIBDB-005's approved/used-version
 * immutability is stage-E hardening, deferred (see 0048's migration
 * header), so this update path stays open regardless of reviewStatus. It
 * exists so review-status transitions, sensitivity classification, and
 * erasure progress can be reflected without inventing a new version row
 * for a state change that is not a content edit.
 */
export async function updateCurrentEvidenceVersion(
  evidenceId: string,
  patch: Partial<
    Pick<EvidenceVersion, 'reviewStatus' | 'sensitivityClassification' | 'treatment' | 'erasureState' | 'content'>
  >
): Promise<EvidenceVersion | null> {
  const current = await getLatestEvidenceVersion(evidenceId)
  if (!current) return null

  const [updated] = await db
    .update(evidenceVersions)
    .set(patch)
    .where(and(eq(evidenceVersions.id, current.id), eq(evidenceVersions.evidenceId, evidenceId)))
    .returning()

  return updated ?? null
}

/**
 * Advance the erasure_state of SPECIFIC version rows, named by id — unlike
 * updateCurrentEvidenceVersion, not limited to the current (latest-ordinal)
 * row. FIBIU-07 (W2-B1-R5, M-4) governed erasure must durably record its
 * progress across EVERY version of an evidence item's content, not only the
 * one that happened to be current when erasure was requested — an older
 * version's content is exactly as much the evidence item's history as the
 * current one, and the same erasure must cover it.
 */
export async function markEvidenceVersionsErasureState(
  versionIds: readonly string[],
  erasureState: string
): Promise<void> {
  if (versionIds.length === 0) return
  await db
    .update(evidenceVersions)
    .set({ erasureState })
    .where(inArray(evidenceVersions.id, versionIds))
}

/**
 * Null the content of ONE specific version row, by id — the actual sweep
 * for a single version. `contentHash` is deliberately left untouched: it
 * remains the permanent, re-verifiable proof of what was erased (FIBC-009),
 * even once the content itself is gone.
 */
export async function eraseEvidenceVersionContent(versionId: string): Promise<void> {
  await db
    .update(evidenceVersions)
    .set({ content: null })
    .where(eq(evidenceVersions.id, versionId))
}
