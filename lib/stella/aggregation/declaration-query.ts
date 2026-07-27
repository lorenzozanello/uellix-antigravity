// lib/stella/aggregation/declaration-query.ts
// Etapa A2.3.1/A2.3.2 (STL-A231-011, STL-A232-007/008). Read-only resolution
// of "is there a valid, verified aggregation declaration for THIS specific
// entity + category" — what lib/stella/context/context-guardrails.ts
// consults for every aggregate-style mention it finds, and the only place
// that decides whether a policy/threshold change silently invalidates a
// past verification.
//
// Fail-closed: any unexpected error resolves to 'missing'/null (nothing
// found), never 'valid' — mirrors getStellaConsentStatus()'s convention.

import { db } from '@/db/client'
import { stellaSensitiveAggregationDeclarations } from '@/db/schema'
import { eq, and, inArray, desc } from 'drizzle-orm'
import { CURRENT_SENSITIVE_AGGREGATION_POLICY, violatesPolicyDimensionRules } from './policy'
import type { SensitiveAggregationPolicy, SensitiveEntityType } from './policy'
import type { SensitiveAggregationDeclarationStatus, DeclarationSensitiveCategory, DeclarationRecord } from './types'
import type { AggregateDataDeclaration } from '../context/sensitive-population'
import { toDeclarationRecord } from './mappers'

export interface FindDeclarationParams {
  organizationId: string
  projectId: string
  entityType: SensitiveEntityType
  entityId: string
  sensitiveCategory: DeclarationSensitiveCategory
}

/** One row's minimal shape needed to resolve a status — matches what a `SELECT *` on the table yields. */
interface DeclarationStatusRow {
  id: string
  verificationStatus: string
  groupSize: number
  dimensions: string[] | null
  policyVersion: string
  minimumGroupSizeApplied: number | null
  sensitiveCategory: string
  entityType: string
  entityId: string
  verifiedAt: Date | null
}

function missingStatus(): SensitiveAggregationDeclarationStatus {
  return { status: 'missing' }
}

/**
 * Pure reclassification of a single row against a policy — no DB access, no
 * side effects. Exported so tests can inject a fixture policy (e.g. "v2,
 * minimum 15") and prove a v1/groupSize-10 row becomes `outdated_policy`/
 * `below_threshold`, WITHOUT ever touching the production
 * CURRENT_SENSITIVE_AGGREGATION_POLICY constant (STL-A232-007).
 */
export function resolveDeclarationStatus(
  row: DeclarationStatusRow,
  policy: SensitiveAggregationPolicy = CURRENT_SENSITIVE_AGGREGATION_POLICY,
): SensitiveAggregationDeclarationStatus {
  if (row.verificationStatus === 'pending') return { status: 'pending', declarationId: row.id }
  if (row.verificationStatus === 'revoked') return { status: 'revoked', declarationId: row.id }
  if (row.verificationStatus === 'superseded') return { status: 'superseded', declarationId: row.id }

  // verificationStatus === 'verified' — re-check against the policy
  // parameter (defaults to CURRENT), never trust that verification-time
  // correctness still holds (a raised threshold or a narrowed dimension
  // allowlist must not silently keep old verifications valid).
  const dimensions = row.dimensions ?? []
  const category = row.sensitiveCategory as DeclarationSensitiveCategory

  if (row.groupSize < policy.minimumGroupSize) {
    return { status: 'below_threshold', declarationId: row.id, category }
  }
  if (violatesPolicyDimensionRules(dimensions, policy)) {
    return { status: 'invalid_dimensions', declarationId: row.id, category }
  }
  if (row.policyVersion !== policy.policyVersion) {
    return { status: 'outdated_policy', declarationId: row.id, category, policyVersion: row.policyVersion }
  }

  return {
    status: 'valid',
    declarationId: row.id,
    category,
    groupSizeBucket: undefined, // filled in by callers that have the full row (bucket isn't part of this minimal shape)
    minimumGroupSizeApplied: row.minimumGroupSizeApplied ?? policy.minimumGroupSize,
    policyVersion: row.policyVersion,
    verifiedAt: row.verifiedAt ?? undefined,
  }
}

/** Pure: does `row` (already known 'verified') resolve to a currently-valid, usable declaration under `policy`? */
function toAggregateDataDeclarationIfValid(
  row: { verificationStatus: string; groupSize: number; dimensions: string[] | null; policyVersion: string; sensitiveCategory: string; entityType: string; entityId: string },
  policy: SensitiveAggregationPolicy,
): AggregateDataDeclaration | null {
  if (row.verificationStatus !== 'verified') return null
  const dimensions = row.dimensions ?? []
  if (row.groupSize < policy.minimumGroupSize) return null
  if (violatesPolicyDimensionRules(dimensions, policy)) return null
  if (row.policyVersion !== policy.policyVersion) return null

  return {
    sensitiveCategory: row.sensitiveCategory as AggregateDataDeclaration['sensitiveCategory'],
    aggregationLevel: 'aggregate',
    groupSize: row.groupSize,
    dimensions,
    sourceEntityType: row.entityType,
    sourceEntityId: row.entityId,
  }
}

/** Canonical key for an (entityType, entityId, sensitiveCategory) tuple — used to index batch results in memory. */
export function canonicalDeclarationKey(ref: { entityType: string; entityId: string; sensitiveCategory: string }): string {
  return `${ref.entityType}:${ref.entityId}:${ref.sensitiveCategory}`
}

/**
 * Resolves the most recent declaration for (organizationId, projectId,
 * entityType, entityId, sensitiveCategory) — regardless of its status, so a
 * caller can distinguish "never declared" from "was declared then revoked"
 * from "was verified but the policy has since moved past it". Only ONE
 * declaration is ever "the current one": the unique index in migration 0046
 * guarantees at most one pending|verified row per tuple, and a
 * revoked/superseded row is never followed by an older row taking its
 * place — ORDER BY created_at DESC LIMIT 1 always finds the right one.
 */
export async function getSensitiveAggregationDeclarationStatus(
  params: FindDeclarationParams,
): Promise<SensitiveAggregationDeclarationStatus> {
  try {
    const row = await db
      .select()
      .from(stellaSensitiveAggregationDeclarations)
      .where(
        and(
          eq(stellaSensitiveAggregationDeclarations.organizationId, params.organizationId),
          eq(stellaSensitiveAggregationDeclarations.projectId, params.projectId),
          eq(stellaSensitiveAggregationDeclarations.entityType, params.entityType),
          eq(stellaSensitiveAggregationDeclarations.entityId, params.entityId),
          eq(stellaSensitiveAggregationDeclarations.sensitiveCategory, params.sensitiveCategory),
        ),
      )
      .orderBy(desc(stellaSensitiveAggregationDeclarations.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null)

    if (!row) return missingStatus()

    const status = resolveDeclarationStatus(row)
    // groupSizeBucket is on the full row but not the minimal shape resolveDeclarationStatus takes — fill it in here for the 'valid' case only.
    if (status.status === 'valid') {
      return { ...status, groupSizeBucket: row.groupSizeBucket as SensitiveAggregationDeclarationStatus['groupSizeBucket'] }
    }
    return status
  } catch (error) {
    console.error('[stella-aggregation] getSensitiveAggregationDeclarationStatus failed, failing closed to "missing":', error)
    return missingStatus()
  }
}

/**
 * The shape lib/stella/context/context-guardrails.ts actually consumes:
 * returns a full AggregateDataDeclaration (usable directly by
 * assessSensitiveData) ONLY when the current status is 'valid' — every
 * other status (missing, pending, revoked, superseded, outdated_policy,
 * below_threshold, invalid_dimensions) returns null, which the guardrail
 * treats identically to "no declaration exists" (fail-closed).
 */
export async function findValidSensitiveAggregationDeclaration(
  params: FindDeclarationParams,
): Promise<AggregateDataDeclaration | null> {
  try {
    const row = await db
      .select()
      .from(stellaSensitiveAggregationDeclarations)
      .where(
        and(
          eq(stellaSensitiveAggregationDeclarations.organizationId, params.organizationId),
          eq(stellaSensitiveAggregationDeclarations.projectId, params.projectId),
          eq(stellaSensitiveAggregationDeclarations.entityType, params.entityType),
          eq(stellaSensitiveAggregationDeclarations.entityId, params.entityId),
          eq(stellaSensitiveAggregationDeclarations.sensitiveCategory, params.sensitiveCategory),
          eq(stellaSensitiveAggregationDeclarations.verificationStatus, 'verified'),
        ),
      )
      .orderBy(desc(stellaSensitiveAggregationDeclarations.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null)

    if (!row) return null
    return toAggregateDataDeclarationIfValid(row, CURRENT_SENSITIVE_AGGREGATION_POLICY)
  } catch (error) {
    console.error('[stella-aggregation] findValidSensitiveAggregationDeclaration failed, failing closed to null:', error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Batch query (Etapa A2.3.2, STL-A232-008/009) — avoids N+1 when the context
// guardrail has many entities to check in one call. Executes exactly ONE
// query regardless of how many (entityType, entityId, sensitiveCategory)
// tuples are requested (up to MAX_BATCH_ENTITIES), scoped to a single
// organization + project — never "load every declaration in the org".
// ---------------------------------------------------------------------------

export interface BatchDeclarationRef {
  entityType: SensitiveEntityType
  entityId: string
  sensitiveCategory: DeclarationSensitiveCategory
}

/** Conservative cap — current context builders scan at most a few dozen entities per call; this leaves generous headroom while still bounding the query. Exceeding it is a caller bug, not silently truncated: entries beyond the cap resolve to null (fail-closed), never partially processed as if they were checked. */
export const MAX_BATCH_ENTITIES = 200

/**
 * Batch-resolves a valid `AggregateDataDeclaration` for each of `refs`, keyed
 * by `canonicalDeclarationKey()`. A ref not present in the returned map (or
 * mapped to `null`) means "no valid declaration" — the caller (the context
 * guardrail) must treat that identically to the single-lookup `null` case:
 * fail-closed.
 *
 * Deduplicates `refs` before querying (a context can reference the same
 * entity+category more than once, e.g. an outcome's name AND description
 * both carrying a mention). Never accepts a ref for a different
 * organization/project — `organizationId`/`projectId` are fixed, top-level
 * parameters, not per-ref, so there is no way to smuggle a cross-tenant
 * entityId into the batch.
 */
export async function findValidSensitiveAggregationDeclarations(params: {
  organizationId: string
  projectId: string
  refs: BatchDeclarationRef[]
}): Promise<Map<string, AggregateDataDeclaration | null>> {
  const result = new Map<string, AggregateDataDeclaration | null>()

  const dedupedByKey = new Map<string, BatchDeclarationRef>()
  for (const ref of params.refs) {
    dedupedByKey.set(canonicalDeclarationKey(ref), ref)
  }
  const deduped = [...dedupedByKey.values()].slice(0, MAX_BATCH_ENTITIES)
  for (const ref of deduped) result.set(canonicalDeclarationKey(ref), null)

  if (deduped.length === 0) return result

  try {
    const entityIds = [...new Set(deduped.map((r) => r.entityId))]
    const entityTypes = [...new Set(deduped.map((r) => r.entityType))]
    const categories = [...new Set(deduped.map((r) => r.sensitiveCategory))]

    // ONE query: scoped to this organization+project, narrowed further by the
    // (small) sets of entityId/entityType/category actually requested — never
    // "select * from declarations where organization_id = ...", which would
    // load the whole org's declaration history for a single context build.
    const rows = await db
      .select()
      .from(stellaSensitiveAggregationDeclarations)
      .where(
        and(
          eq(stellaSensitiveAggregationDeclarations.organizationId, params.organizationId),
          eq(stellaSensitiveAggregationDeclarations.projectId, params.projectId),
          eq(stellaSensitiveAggregationDeclarations.verificationStatus, 'verified'),
          inArray(stellaSensitiveAggregationDeclarations.entityId, entityIds),
          inArray(stellaSensitiveAggregationDeclarations.entityType, entityTypes),
          inArray(stellaSensitiveAggregationDeclarations.sensitiveCategory, categories),
        ),
      )
      .orderBy(desc(stellaSensitiveAggregationDeclarations.createdAt))

    // Multiple rows can share an entityId across categories, or (in theory,
    // pre-dedup) multiple verified rows could exist for the exact same key
    // if data were manually tampered with outside the service layer — the
    // unique partial index prevents that in practice, but resolving with the
    // FIRST match per key (rows are already ordered by createdAt DESC) keeps
    // this function correct even under that hypothetical.
    const byKey = new Map<string, typeof rows[number]>()
    for (const row of rows) {
      const key = canonicalDeclarationKey({ entityType: row.entityType, entityId: row.entityId, sensitiveCategory: row.sensitiveCategory })
      if (!byKey.has(key)) byKey.set(key, row)
    }

    for (const ref of deduped) {
      const key = canonicalDeclarationKey(ref)
      const row = byKey.get(key)
      if (!row) continue // stays null — no verified row for this exact tuple
      result.set(key, toAggregateDataDeclarationIfValid(row, CURRENT_SENSITIVE_AGGREGATION_POLICY))
    }

    return result
  } catch (error) {
    console.error('[stella-aggregation] findValidSensitiveAggregationDeclarations failed, failing closed to null for all refs:', error)
    // Fail-closed: every ref already defaults to null in `result` above.
    return result
  }
}

// ---------------------------------------------------------------------------
// History listing (Etapa A2.3.2, STL-A232-016) — for the UI's "historial"
// view. Unlike the status/batch functions above, this returns the FULL
// DeclarationRecord (including declaredBy/verifiedBy/revokedBy/dates) for
// every declaration ever created for one entity, across all categories —
// authorization for whether the caller may SEE those actor/date fields is
// the server action's job (app/actions/stella/aggregation-declarations.ts),
// not this query's — RLS already scopes rows to the caller's organization
// regardless.
// ---------------------------------------------------------------------------

export async function listSensitiveAggregationDeclarationsForEntity(params: {
  organizationId: string
  projectId: string
  entityType: SensitiveEntityType
  entityId: string
}): Promise<DeclarationRecord[]> {
  try {
    const rows = await db
      .select()
      .from(stellaSensitiveAggregationDeclarations)
      .where(
        and(
          eq(stellaSensitiveAggregationDeclarations.organizationId, params.organizationId),
          eq(stellaSensitiveAggregationDeclarations.projectId, params.projectId),
          eq(stellaSensitiveAggregationDeclarations.entityType, params.entityType),
          eq(stellaSensitiveAggregationDeclarations.entityId, params.entityId),
        ),
      )
      .orderBy(desc(stellaSensitiveAggregationDeclarations.createdAt))

    return rows.map(toDeclarationRecord)
  } catch (error) {
    console.error('[stella-aggregation] listSensitiveAggregationDeclarationsForEntity failed, failing closed to an empty list:', error)
    return []
  }
}
