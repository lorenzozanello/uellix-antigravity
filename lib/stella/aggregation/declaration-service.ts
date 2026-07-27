// lib/stella/aggregation/declaration-service.ts
// Etapa A2.3.1/A2.3.2 (STL-A231-008/009/010, STL-A232-002..006, DR-002/DR-003).
// The single write path for stella_sensitive_aggregation_declarations — the
// ONLY functions in the codebase that may INSERT/UPDATE this table. There is
// no "edit" function: a material change (group size, category, dimensions)
// always creates a new declaration and supersedes the old one, never
// mutates it in place.
//
// MINIMIZATION INVARIANT (load-bearing, verified by tests): none of these
// functions ever accept or persist a person's name, a diagnosis, a
// testimony, an address, the content of a supporting document, or any
// payload sent to Stella. `dimensions` only ever stores codes from
// ALLOWED_AGGREGATION_DIMENSIONS (policy.ts) — never a value.
//
// NOT A MATHEMATICAL OR LEGAL GUARANTEE of anonymization — see the
// equivalent note in lib/stella/context/sensitive-population.ts. This is a
// conservative, explainable, code-level control.
//
// Authorization: callers (server actions) resolve the actor's role via
// requireOrganizationAccess() and pass it in explicitly — this module never
// queries membership itself, so its role checks stay pure and testable
// without mocking the DB. The server NEVER trusts a client-supplied role,
// policy version, threshold, bucket, or verification timestamp — every one
// of those is resolved here.
//
// CONCURRENCY (Etapa A2.3.2, STL-A232-002/006): verify/revoke/supersede all
// run inside `db.transaction()` and take `SELECT ... FOR UPDATE` on the row
// being mutated, so two concurrent verifications (or a verify racing a
// revoke, or a supersede racing a revoke) serialize on the row lock instead
// of both reading a stale status and both succeeding. The partial unique
// index (`ssad_active_unique_idx`, migration 0046) is the DB-level backstop
// for concurrent CREATE of a duplicate active declaration — no row exists
// yet to lock in that case, so the index is the only defense, and it is
// sufficient (a 23505 surfaces as a typed ACTIVE_DECLARATION_EXISTS error,
// never a silent duplicate).

import { db } from '@/db/client'
import { stellaSensitiveAggregationDeclarations } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { validateEntityScope } from './entity-validation'
import { toDeclarationRecord } from './mappers'
import {
  SENSITIVE_AGGREGATION_POLICY_VERSION,
  MINIMUM_SENSITIVE_GROUP_SIZE,
  ALLOWED_AGGREGATION_DIMENSIONS,
  MAX_AGGREGATION_DIMENSIONS,
  isHighRiskDimensionCombination,
  isAllowedSensitiveEntityType,
  isAllowedCountSourceType,
  computeGroupSizeBucket,
} from './policy'
import type { CreateDeclarationInput, VerifyDeclarationInput, RevokeDeclarationInput, DeclarationRecord } from './types'

/** Roles allowed to CREATE a (pending) declaration — a proposal, not yet trusted. */
const CREATE_ROLES: ReadonlySet<string> = new Set(['organization_admin', 'analyst'])

/**
 * Roles allowed to VERIFY (or revoke/supersede) a declaration — deliberately
 * narrower than CREATE_ROLES and an EXACT match, not a hierarchy check: a
 * global `super_admin` without an explicit `organization_admin` membership
 * row for THIS organization cannot verify on the organization's behalf,
 * mirroring the exact-match rule DR-005's consent gate already established
 * (app/actions/stella/consent.ts) for the same reason.
 */
const VERIFY_ROLES: ReadonlySet<string> = new Set(['organization_admin'])

/** The transaction client type `db.transaction(async (tx) => ...)` passes in — narrower than `typeof db` (no `$client`/`transaction` of its own), but supports the same `select`/`insert`/`update` builders this module needs. */
type TxClient = Parameters<Parameters<typeof db.transaction>[0]>[0]
/** Either the top-level `db` or an ambient `tx` — lets internal helpers run inside a caller's transaction without opening a second connection. */
type QueryClient = typeof db | TxClient

export type CreateDeclarationError =
  | 'FORBIDDEN_ROLE'
  | 'INVALID_ENTITY_TYPE'
  | 'INVALID_CATEGORY'
  | 'INVALID_GROUP_SIZE'
  | 'INVALID_COUNT_SOURCE'
  | 'ENTITY_NOT_FOUND'
  | 'ENTITY_ORGANIZATION_MISMATCH'
  | 'ENTITY_PROJECT_MISMATCH'
  | 'ACTIVE_DECLARATION_EXISTS'
  | 'UNKNOWN_ERROR'

export type CreateDeclarationResult =
  | { ok: true; id: string }
  | { ok: false; error: CreateDeclarationError }

async function createDeclarationWithClient(
  input: CreateDeclarationInput,
  actorRole: string,
  client: QueryClient,
): Promise<CreateDeclarationResult> {
  if (!CREATE_ROLES.has(actorRole)) return { ok: false, error: 'FORBIDDEN_ROLE' }
  if (!isAllowedSensitiveEntityType(input.entityType)) return { ok: false, error: 'INVALID_ENTITY_TYPE' }
  if (input.sensitiveCategory !== 'minors' && input.sensitiveCategory !== 'health' && input.sensitiveCategory !== 'minors_and_health') {
    return { ok: false, error: 'INVALID_CATEGORY' }
  }
  // Integer, positive — a client-asserted "approximately 10" or a decimal
  // never reaches here as a valid group size (form/action-layer input
  // parsing is responsible for rejecting non-integers before this call;
  // this is the last, authoritative check).
  if (!Number.isInteger(input.groupSize) || input.groupSize <= 0) return { ok: false, error: 'INVALID_GROUP_SIZE' }
  if (!isAllowedCountSourceType(input.countSourceType)) return { ok: false, error: 'INVALID_COUNT_SOURCE' }

  // Entity-scope validation always reads via the plain `db` client, even
  // when called from inside a supersede transaction: it only reads
  // outcomes/indicators/etc., tables this transaction never writes to, so a
  // consistent snapshot from the ambient connection is unnecessary — using
  // the shared client here would be over-engineering a read against
  // unrelated, stable data.
  const scope = await validateEntityScope({
    entityType: input.entityType,
    entityId: input.entityId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  })
  if (!scope.valid) {
    if (scope.reason === 'not_found') return { ok: false, error: 'ENTITY_NOT_FOUND' }
    if (scope.reason === 'organization_mismatch') return { ok: false, error: 'ENTITY_ORGANIZATION_MISMATCH' }
    return { ok: false, error: 'ENTITY_PROJECT_MISMATCH' }
  }

  try {
    const [inserted] = await client
      .insert(stellaSensitiveAggregationDeclarations)
      .values({
        organizationId: input.organizationId,
        projectId: input.projectId,
        entityType: input.entityType,
        entityId: input.entityId,
        sensitiveCategory: input.sensitiveCategory,
        aggregationLevel: 'aggregate',
        groupSize: input.groupSize,
        groupSizeBucket: computeGroupSizeBucket(input.groupSize),
        dimensions: [...input.dimensions],
        countSourceType: input.countSourceType,
        countSourceId: input.countSourceId ?? undefined,
        countSourceNote: input.countSourceNote ?? undefined,
        verificationStatus: 'pending',
        declaredBy: input.declaredByUserId,
        policyVersion: SENSITIVE_AGGREGATION_POLICY_VERSION,
        supersedesDeclarationId: input.supersedesDeclarationId,
      })
      .returning({ id: stellaSensitiveAggregationDeclarations.id })

    return { ok: true, id: inserted.id }
  } catch (error) {
    // The partial unique index (ssad_active_unique_idx) is the DB-level
    // backstop for "at most one active declaration per entity+category" —
    // a Postgres unique_violation (23505) surfaces as this specific error
    // rather than the generic UNKNOWN_ERROR.
    if (isUniqueViolation(error)) return { ok: false, error: 'ACTIVE_DECLARATION_EXISTS' }
    console.error('[stella-aggregation] createSensitiveAggregationDeclaration failed:', error)
    return { ok: false, error: 'UNKNOWN_ERROR' }
  }
}

/**
 * Creates a new declaration in 'pending' status. Never auto-verifies — a
 * separate, explicit call to verifySensitiveAggregationDeclaration() is
 * always required, even when the same organization_admin will perform both
 * steps back-to-back. This keeps "I declared this" and "I verified this
 * really is >=10 and correctly sourced" as two distinct, separately-audited
 * actions, per the approved design.
 */
export async function createSensitiveAggregationDeclaration(
  input: CreateDeclarationInput,
  actorRole: string,
): Promise<CreateDeclarationResult> {
  return createDeclarationWithClient(input, actorRole, db)
}

export type VerifyDeclarationError =
  | 'FORBIDDEN_ROLE'
  | 'NOT_FOUND'
  | 'CROSS_ORG'
  | 'ALREADY_VERIFIED'
  | 'ALREADY_REVOKED'
  | 'ALREADY_SUPERSEDED'
  | 'GROUP_SIZE_BELOW_THRESHOLD'
  | 'TOO_MANY_DIMENSIONS'
  | 'INVALID_DIMENSIONS'
  | 'HIGH_RISK_DIMENSIONS'
  | 'UNKNOWN_ERROR'

export type VerifyDeclarationResult =
  | { ok: true; declaration: DeclarationRecord }
  | { ok: false; error: VerifyDeclarationError }

/**
 * Verifies a pending declaration. Re-validates EVERY invariant at
 * verification time (never trusts that create-time validation is still
 * sufficient) — the threshold and dimension allowlist are resolved fresh
 * from policy.ts here, never read back from the row being verified.
 *
 * Runs inside a transaction with `FOR UPDATE` on the target row: two
 * concurrent verifications of the SAME declaration serialize — the second
 * transaction blocks until the first commits, then re-reads the
 * now-'verified' status and returns ALREADY_VERIFIED instead of both
 * "succeeding". A concurrent revoke on the same row is serialized the same
 * way (see revokeSensitiveAggregationDeclaration).
 */
export async function verifySensitiveAggregationDeclaration(
  input: VerifyDeclarationInput,
  actorRole: string,
): Promise<VerifyDeclarationResult> {
  if (!VERIFY_ROLES.has(actorRole)) return { ok: false, error: 'FORBIDDEN_ROLE' }

  try {
    return await db.transaction(async (tx) => {
      const row = await tx
        .select()
        .from(stellaSensitiveAggregationDeclarations)
        .where(eq(stellaSensitiveAggregationDeclarations.id, input.declarationId))
        .for('update')
        .limit(1)
        .then((rows) => rows[0] ?? null)

      if (!row) return { ok: false, error: 'NOT_FOUND' } as const
      if (row.organizationId !== input.organizationId) return { ok: false, error: 'CROSS_ORG' } as const
      if (row.verificationStatus === 'verified') return { ok: false, error: 'ALREADY_VERIFIED' } as const
      if (row.verificationStatus === 'revoked') return { ok: false, error: 'ALREADY_REVOKED' } as const
      if (row.verificationStatus === 'superseded') return { ok: false, error: 'ALREADY_SUPERSEDED' } as const

      if (row.groupSize < MINIMUM_SENSITIVE_GROUP_SIZE) return { ok: false, error: 'GROUP_SIZE_BELOW_THRESHOLD' } as const

      const dimensions = row.dimensions ?? []
      if (dimensions.length > MAX_AGGREGATION_DIMENSIONS) return { ok: false, error: 'TOO_MANY_DIMENSIONS' } as const
      if (dimensions.some((d) => !(ALLOWED_AGGREGATION_DIMENSIONS as readonly string[]).includes(d))) {
        return { ok: false, error: 'INVALID_DIMENSIONS' } as const
      }
      if (isHighRiskDimensionCombination(dimensions)) return { ok: false, error: 'HIGH_RISK_DIMENSIONS' } as const

      const [updated] = await tx
        .update(stellaSensitiveAggregationDeclarations)
        .set({
          verificationStatus: 'verified',
          verifiedBy: input.verifiedByUserId,
          verifiedAt: new Date(),
          minimumGroupSizeApplied: MINIMUM_SENSITIVE_GROUP_SIZE,
          updatedAt: new Date(),
        })
        .where(eq(stellaSensitiveAggregationDeclarations.id, input.declarationId))
        .returning()

      return { ok: true, declaration: toDeclarationRecord(updated) } as const
    })
  } catch (error) {
    console.error('[stella-aggregation] verifySensitiveAggregationDeclaration failed:', error)
    return { ok: false, error: 'UNKNOWN_ERROR' }
  }
}

export type RevokeDeclarationError = 'FORBIDDEN_ROLE' | 'NOT_FOUND' | 'CROSS_ORG' | 'ALREADY_REVOKED' | 'ALREADY_SUPERSEDED' | 'UNKNOWN_ERROR'

export type RevokeDeclarationResult = { ok: true } | { ok: false; error: RevokeDeclarationError }

/**
 * Revoking preserves the row (and its history) — it never deletes. A
 * revoked declaration can never be un-revoked; a new declaration must be
 * created instead. Same transaction + row-lock pattern as verify, so a
 * revoke racing a verify (or a second concurrent revoke) serializes on the
 * row instead of both succeeding.
 */
export async function revokeSensitiveAggregationDeclaration(
  input: RevokeDeclarationInput,
  actorRole: string,
): Promise<RevokeDeclarationResult> {
  if (!VERIFY_ROLES.has(actorRole)) return { ok: false, error: 'FORBIDDEN_ROLE' }

  try {
    return await db.transaction(async (tx) => {
      const row = await tx
        .select({
          id: stellaSensitiveAggregationDeclarations.id,
          organizationId: stellaSensitiveAggregationDeclarations.organizationId,
          verificationStatus: stellaSensitiveAggregationDeclarations.verificationStatus,
        })
        .from(stellaSensitiveAggregationDeclarations)
        .where(eq(stellaSensitiveAggregationDeclarations.id, input.declarationId))
        .for('update')
        .limit(1)
        .then((rows) => rows[0] ?? null)

      if (!row) return { ok: false, error: 'NOT_FOUND' } as const
      if (row.organizationId !== input.organizationId) return { ok: false, error: 'CROSS_ORG' } as const
      if (row.verificationStatus === 'revoked') return { ok: false, error: 'ALREADY_REVOKED' } as const
      if (row.verificationStatus === 'superseded') return { ok: false, error: 'ALREADY_SUPERSEDED' } as const

      await tx
        .update(stellaSensitiveAggregationDeclarations)
        .set({
          verificationStatus: 'revoked',
          revokedBy: input.revokedByUserId,
          revokedAt: new Date(),
          revocationReason: input.reason,
          updatedAt: new Date(),
        })
        .where(eq(stellaSensitiveAggregationDeclarations.id, input.declarationId))

      return { ok: true } as const
    })
  } catch (error) {
    console.error('[stella-aggregation] revokeSensitiveAggregationDeclaration failed:', error)
    return { ok: false, error: 'UNKNOWN_ERROR' }
  }
}

export type SupersedeDeclarationError = CreateDeclarationError | 'PREVIOUS_NOT_FOUND' | 'PREVIOUS_CROSS_ORG' | 'PREVIOUS_ALREADY_REVOKED' | 'PREVIOUS_ALREADY_SUPERSEDED'

export type SupersedeDeclarationResult = { ok: true; id: string } | { ok: false; error: SupersedeDeclarationError }

/** Internal control-flow signal — thrown (never returned) so a failed inner create forces a ROLLBACK of the whole supersede transaction, never leaving the previous row marked superseded without a valid new declaration. */
class SupersedeCreateFailed extends Error {
  constructor(public readonly code: CreateDeclarationError) {
    super(`supersede: inner create failed with ${code}`)
  }
}

/**
 * The ONLY path for a material change (group size, category, dimensions) to
 * an existing declaration — creates a brand-new declaration and marks the
 * previous one 'superseded' (never 'revoked': a supersession is not a
 * retraction, it is a replacement, and the two must stay distinguishable in
 * history). The new declaration still starts 'pending' and requires its own
 * independent verification — a supersession never inherits the previous
 * declaration's verified status.
 *
 * Etapa A2.3.2 (STL-A232-004): now a single Postgres transaction —
 * `BEGIN → SELECT previous FOR UPDATE → revalidate → INSERT new →
 * UPDATE previous SET superseded → COMMIT`, or a full `ROLLBACK` on any
 * failure (invalid new input, unique-index collision, previous no longer
 * active). Nothing partial can ever be observed: the previous row is either
 * still active (rollback) or superseded with a valid new declaration
 * already committed (commit) — never both flags in an inconsistent state.
 *
 * Audit-log participation: `logAuditAction()` writes to `audit_logs` via the
 * plain `db` client, OUTSIDE this transaction (see
 * app/actions/stella/aggregation-declarations.ts) — `audit_logs` is a
 * separate, hardened, append-only table used the same way by every other
 * Stella action in this codebase, and threading a transaction client into
 * it would be a much larger, unrelated refactor. Accepted risk: if the
 * transaction commits but the subsequent audit-log insert throws, the
 * supersede itself is still correct (data integrity holds) — only that
 * specific audit entry would be missing. Fail-safe: the server action layer
 * wraps the audit-log call in its own try/catch so a broken audit insert
 * can never mask (or roll back) an already-committed, successful operation.
 */
export async function supersedeSensitiveAggregationDeclaration(
  previousDeclarationId: string,
  newInput: CreateDeclarationInput,
  actorRole: string,
): Promise<SupersedeDeclarationResult> {
  if (!CREATE_ROLES.has(actorRole)) return { ok: false, error: 'FORBIDDEN_ROLE' }

  try {
    return await db.transaction(async (tx) => {
      const previous = await tx
        .select({
          id: stellaSensitiveAggregationDeclarations.id,
          organizationId: stellaSensitiveAggregationDeclarations.organizationId,
          verificationStatus: stellaSensitiveAggregationDeclarations.verificationStatus,
        })
        .from(stellaSensitiveAggregationDeclarations)
        .where(eq(stellaSensitiveAggregationDeclarations.id, previousDeclarationId))
        .for('update')
        .limit(1)
        .then((rows) => rows[0] ?? null)

      if (!previous) return { ok: false, error: 'PREVIOUS_NOT_FOUND' } as const
      if (previous.organizationId !== newInput.organizationId) return { ok: false, error: 'PREVIOUS_CROSS_ORG' } as const
      if (previous.verificationStatus === 'revoked') return { ok: false, error: 'PREVIOUS_ALREADY_REVOKED' } as const
      if (previous.verificationStatus === 'superseded') return { ok: false, error: 'PREVIOUS_ALREADY_SUPERSEDED' } as const

      // Mark the previous row 'superseded' BEFORE inserting the new one —
      // required, not cosmetic: the partial unique index only excludes
      // 'revoked'/'superseded' rows, so if the new declaration targets the
      // SAME (entityType, entityId, sensitiveCategory) as the previous one
      // (the common case — a supersession usually corrects the same
      // entity), inserting the new row while `previous` is still
      // 'pending'/'verified' would collide with `previous` ITSELF. Doing
      // the UPDATE first removes it from the active set, so the INSERT can
      // only collide with a genuinely different active row (a real
      // ACTIVE_DECLARATION_EXISTS case, e.g. the new input's entity already
      // has an unrelated active declaration). `supersededByDeclarationId` is
      // filled in with a second UPDATE once the new row's id is known — all
      // three statements share the same transaction, so a failure at any
      // point rolls back everything, including this first UPDATE.
      await tx
        .update(stellaSensitiveAggregationDeclarations)
        .set({ verificationStatus: 'superseded', updatedAt: new Date() })
        .where(eq(stellaSensitiveAggregationDeclarations.id, previousDeclarationId))

      const created = await createDeclarationWithClient(
        { ...newInput, supersedesDeclarationId: previousDeclarationId },
        actorRole,
        tx,
      )
      if (!created.ok) {
        // Force a rollback: `previous` reverts to its original status too
        // (the UPDATE above is undone), so it never ends up marked
        // superseded without a valid replacement.
        throw new SupersedeCreateFailed(created.error)
      }

      await tx
        .update(stellaSensitiveAggregationDeclarations)
        .set({ supersededByDeclarationId: created.id, updatedAt: new Date() })
        .where(eq(stellaSensitiveAggregationDeclarations.id, previousDeclarationId))

      return { ok: true, id: created.id } as const
    })
  } catch (error) {
    if (error instanceof SupersedeCreateFailed) return { ok: false, error: error.code }
    if (isUniqueViolation(error)) return { ok: false, error: 'ACTIVE_DECLARATION_EXISTS' }
    console.error('[stella-aggregation] supersedeSensitiveAggregationDeclaration failed:', error)
    return { ok: false, error: 'UNKNOWN_ERROR' }
  }
}

/**
 * True for a Postgres unique_violation (23505). Checked against BOTH
 * `error.code` and `error.cause.code`: this Drizzle version wraps the
 * driver's PostgresError in its own `DrizzleQueryError`, which does not
 * forward `.code` — the real Postgres error code only survives on
 * `.cause`. Discovered via a real-database integration test
 * (tests/integration/stella-sensitive-aggregation-transactions.test.ts) —
 * a mock using a plain `Object.assign(new Error(...), {code:'23505'})`
 * would never have caught this, since it doesn't reproduce the wrapper.
 */
function isUniqueViolation(error: unknown): boolean {
  const code = (value: unknown): string | undefined =>
    typeof value === 'object' && value !== null && 'code' in value ? (value as { code?: string }).code : undefined
  if (code(error) === '23505') return true
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    return code((error as { cause?: unknown }).cause) === '23505'
  }
  return false
}
