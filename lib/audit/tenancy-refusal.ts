// lib/audit/tenancy-refusal.ts
//
// THE ONLY WAY A TENANCY REFUSAL REACHES public.audit_logs.
//
// Authority: docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.25.json
// (REFUSAL_EVENT_CONTRACT, LOGGER_AND_EMITTER_DISPOSITION,
// TRANSACTION_AND_FAILURE_SEMANTICS), companion
// docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_AMENDMENT_v1.0.6.json.
//
// TWO VERBS, TWO SUBJECT FORMS, THREE LEGAL COMBINATIONS.
//
//   FORM A  no usable organisation UUID was supplied by an EXPLICIT selection
//           attempt. The subject is the CALLER: entity_type 'user', entity_id
//           auth.uid(), reason TENANCY_NO_ORGANIZATION_SELECTED.
//   FORM B  a VALID organisation UUID was supplied (or was already selected)
//           and the required membership is absent. The subject is that
//           ORGANISATION: entity_type 'organization', entity_id the exact
//           attempted UUID, reason TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER.
//
// `tenancy.organization.selection_refused` admits BOTH forms - an explicit act
// can fail either way. `tenancy.membership.revalidation_refused` admits FORM B
// ONLY: revalidation presupposes something to revalidate, so a FORM A row
// under that verb would assert a refusal of an attempt that never happened.
//
// THAT ASYMMETRY IS WHY THIS MODULE EXPORTS TWO FUNCTIONS AND NOT ONE GENERIC
// ONE. There is no parameter anywhere below that lets a caller pair
// revalidation_refused with FORM A, choose an entity_type, choose a reason, or
// supply organization_id / before_json / after_json / ip_address / user_agent.
// The migration's WITH CHECK refuses those rows too - but it is the SECOND
// wall, not the only one, and a caller should not be able to express the row
// that the database then has to reject.
//
// WHY THIS MODULE DOES NOT OPEN ITS OWN TRANSACTION.
//
// Two independent reasons, and both are load-bearing:
//
//   1. ISOLATION (HPO ADJUDICATION D). The refusal INSERT must not run inside
//      the transaction that RESOLVES the principal, because that transaction
//      is the one DECIDING the refusal - a failing audit write inside it would
//      roll back or perturb the authorization answer itself, letting the
//      observation change the thing observed. Deciding WHICH transaction the
//      write joins is therefore the CALLER's responsibility, made at the
//      request boundary where the principal transaction's lifetime is known.
//      This module can only verify the shape of the context it was handed.
//   2. THE ENTRYPOINT LEDGER. tests/database-runtime-entrypoints.test.ts
//      requires any app/ region importing a database-reaching symbol to itself
//      call a named context opener. If this module opened its own context, the
//      selector would import a database-reaching symbol while opening none,
//      and the pinned { contextualized: 100 } would fall to 99.
//
// FAIL-CLOSED, NOT BEST-EFFORT. Every failure below THROWS. There is no catch,
// no fallback and no fire-and-forget path: a refusal must not complete
// successfully while the row recording it is missing.
//
// NO PRIVILEGE ANYWHERE. The write runs as `uellix_app` under the caller's own
// claims, subject to every policy on audit_logs. No service role, no SECURITY
// DEFINER, no RLS bypass. If a refusal cannot be recorded that way, the
// correct outcome is the throw below, never a privileged connection.

import { getBoundDatabaseContext } from '@/db/identity-context'
import { AUDIT_ACTIONS, logAuditAction } from './logger'

/**
 * MODULE-PRIVATE, and byte-identical to the four existing copies in
 * lib/auth/identity.ts, lib/auth/selected-organization.ts, lib/auth/session.ts
 * and db/identity-context.ts.
 *
 * Refactoring the five into one shared helper would be a better shape and is
 * deliberately NOT done here: all four existing hosts lie outside this node's
 * authorized path ceiling, so the refactor would be scope expansion. The
 * duplication is recorded rather than silently introduced.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A refusal that could not be recorded. Thrown, never swallowed.
 *
 * Distinct from AuditContractViolationError so a caller (and a test) can tell
 * "the audit contract was violated" apart from "the context this emitter needs
 * was not the one it got".
 */
export class TenancyRefusalAuditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenancyRefusalAuditError'
  }
}

/**
 * The context precondition, checked before every emission.
 *
 * Requires an OPEN identity context that is (a) for this exact user and (b)
 * NOT organisation-scoped. Both halves matter:
 *
 *   - Without an open context `auth.uid()` is NULL, the policy's WITH CHECK
 *     cannot be satisfied, and the INSERT is refused by an error that says
 *     nothing about why. Checking here turns that into a legible failure.
 *   - An ORGANISATION-SCOPED context would mean the caller had already proven
 *     membership somewhere - the opposite of the state a refusal records - and
 *     is the shape a misplaced call would most plausibly take.
 */
function requireUnscopedContextFor(userId: string): void {
  const bound = getBoundDatabaseContext()

  if (bound === undefined) {
    throw new TenancyRefusalAuditError(
      'A tenancy refusal audit event must be emitted inside an open database identity context. ' +
        'Outside one, auth.uid() is NULL and the row is refused by policy. Open an unscoped ' +
        'authenticated context around this call - and open it AFTER the principal-resolution ' +
        'transaction has completed, never inside it.'
    )
  }

  if (bound.identity.userId !== userId) {
    throw new TenancyRefusalAuditError(
      'A tenancy refusal audit event must be emitted under the identity of the refused subject. ' +
        'The open context belongs to a different user, so actor_user_id = auth.uid() cannot hold.'
    )
  }

  if (bound.identity.organizationId !== null) {
    throw new TenancyRefusalAuditError(
      'A tenancy refusal audit event must be emitted under an UNSCOPED authenticated context. ' +
        'The open context is organisation-scoped, which asserts a membership the refusal being ' +
        'recorded says does not exist.'
    )
  }
}

/**
 * Record an EXPLICIT organisation-selection attempt that was refused.
 *
 * `attemptedOrganizationId` is the RAW submitted value, exactly as it arrived.
 * This function - not the caller - decides which form the row takes:
 *
 *   absent, empty or NOT UUID-SHAPED  ->  FORM A
 *   a valid organisation UUID         ->  FORM B, subject = that UUID
 *
 * MALFORMED INPUT NEVER REACHES A UUID COLUMN. audit_logs.entity_id is
 * `uuid NOT NULL`; writing hostile bytes there would be both a lie (the bytes
 * are not an organisation) and a write-anything channel into the subject
 * field. Malformed input is classified as FORM A and the raw value is not
 * carried into ANY column of the row - not entity_id, not reason, and not a
 * payload, because FORM A rows have no payload at all.
 *
 * NO EXISTENCE LOOKUP. FORM B is emitted on UUID SHAPE alone. A deleted or
 * never-existing organisation carrying a valid UUID stays observationally
 * indistinguishable from ordinary non-membership; checking would turn this
 * path into an organisation-existence oracle for a caller who, by definition,
 * is not authenticated in that tenant.
 *
 * Caller must already hold an open unscoped context for `userId`.
 */
export async function emitOrganizationSelectionRefused(input: {
  readonly userId: string
  readonly attemptedOrganizationId: string | null | undefined
}): Promise<void> {
  const { userId, attemptedOrganizationId } = input
  requireUnscopedContextFor(userId)

  const attempted = attemptedOrganizationId?.trim()
  const isUsableUuid = attempted !== undefined && attempted !== '' && UUID_PATTERN.test(attempted)

  if (!isUsableUuid) {
    // FORM A. Subject is the caller.
    await logAuditAction({
      actorUserId: userId,
      entityType: 'user',
      entityId: userId,
      action: AUDIT_ACTIONS.TENANCY_ORGANIZATION_SELECTION_REFUSED,
      reason: 'TENANCY_NO_ORGANIZATION_SELECTED',
    })
    return
  }

  // FORM B. Subject is the attempted organisation, and entity_id is the EXACT
  // attempted UUID - never a sentinel, never the nil UUID, and never the
  // caller's own id standing in for one.
  await logAuditAction({
    actorUserId: userId,
    entityType: 'organization',
    entityId: attempted,
    action: AUDIT_ACTIONS.TENANCY_ORGANIZATION_SELECTION_REFUSED,
    reason: 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER',
  })
}

/**
 * Record a membership REVALIDATION that was refused.
 *
 * FORM B ONLY, and the signature is what enforces it: there is no parameter
 * that could produce a FORM A row, so the prohibited action/form pair is
 * INEXPRESSIBLE here rather than merely rejected downstream.
 *
 * `selectedOrganizationId` is a valid organisation UUID BY CONSTRUCTION at the
 * one site authorized to call this - getSelectedOrganizationId() returns null
 * for anything that is not UUID-shaped, so control only reaches the membership
 * lookup with a valid UUID in hand. The assertion below is therefore expected
 * to be unreachable, and exists because "expected to be unreachable" is worth
 * exactly as much as the check that says so: without it a future caller could
 * quietly downgrade this to FORM A semantics by passing a malformed value.
 *
 * THIS IS NOT THE READABILITY-INVARIANT SITE. Where an active membership
 * EXISTS but its organisation row cannot be read, the refusal code
 * TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER is REUSED AS A CARRIER and is
 * false: the membership is right there in the same return object. That
 * condition is governed separately
 * (TENANCY_ORGANIZATION_READABILITY_INVARIANT_SUCCESSOR_REQUIRED) and MUST NOT
 * be recorded through this function. Callers select this emitter BY RETURN
 * SITE, never by refusal code.
 *
 * Caller must already hold an open unscoped context for `userId`, opened AFTER
 * the principal-resolution transaction completed.
 */
export async function emitMembershipRevalidationRefused(input: {
  readonly userId: string
  readonly selectedOrganizationId: string
}): Promise<void> {
  const { userId, selectedOrganizationId } = input
  requireUnscopedContextFor(userId)

  if (!UUID_PATTERN.test(selectedOrganizationId)) {
    throw new TenancyRefusalAuditError(
      'A membership revalidation refusal requires the valid organisation UUID that was being ' +
        'revalidated. There is no FORM A of this verb: recording one would assert that a ' +
        'revalidation was refused when none was attempted.'
    )
  }

  await logAuditAction({
    actorUserId: userId,
    entityType: 'organization',
    entityId: selectedOrganizationId,
    action: AUDIT_ACTIONS.TENANCY_MEMBERSHIP_REVALIDATION_REFUSED,
    reason: 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER',
  })
}
