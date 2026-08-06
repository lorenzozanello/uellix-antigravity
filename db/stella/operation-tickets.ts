// db/stella/operation-tickets.ts
// INTEGRATION — Train 4.1, INT-INT-001 §7 (2). The adapter for
// `db/prepared/stella_0014_operation_tickets.sql`, and — since Train 4.2 —
// for `db/prepared/stella_0015_project_bound_operation_tickets.sql`.
//
// ---------------------------------------------------------------------------
// TRAIN 4.2 — R2-INT: THE EXECUTION PROJECT
// ---------------------------------------------------------------------------
// `bind`, `complete`, `abort` and `inspect` now take the project the caller is
// executing against, and the database compares it against the one welded onto
// the ticket at issue. The four SQL signatures that took no project have been
// DROPPED, so there is no executable path left that skips the comparison.
//
// CAPABILITIES delivered the parameter OPTIONAL in TypeScript and required in
// fact — a call that omitted it was refused in Node before any round trip. That
// asymmetry was correct for a line that does not own
// `app/actions/stella/grounded-query.ts`, and INTEGRATION has now closed it:
// the parameter is REQUIRED, in the SQL's own position (second, between the
// ticket and the query digest). Two consequences, and both are the point:
//
//   * omitting it is a COMPILE error, not a runtime refusal. The old
//     two-argument call shape is not "discouraged", it does not typecheck —
//     which is the TypeScript counterpart of stella_0015 §3 DROPping the four
//     unbound SQL signatures rather than leaving them revoked.
//   * the argument order MIRRORS the function it calls, so a reader comparing
//     this file against the package is comparing two lists in the same order
//     and a transposition is visible rather than inferable.
//
// The shape check survives as a fail-closed guard for the untyped edges (a
// `any` cast, a JSON boundary, a test double): a value that is not a UUID is
// refused here rather than sent to be classified as U0100.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS ALLOWED TO KNOW, AND WHAT IT IS NOT
// ---------------------------------------------------------------------------
// It calls six SECURITY DEFINER functions and reads nothing else. There is no
// SELECT against `uellix_stella_ops.operation_tickets` anywhere in this file —
// not because it would be impolite, but because `uellix_app` HOLDS NO
// PRIVILEGE ON THAT TABLE (stella_0014 §"aislamiento de privilegio"). A direct
// read would not return the wrong answer; it would fail. Stating it here means
// a future edit that adds one fails at the first run rather than at review.
//
// It never sees `charge_nonce`: no function in the package declares it in a
// RETURNS clause, no message interpolates it, and `complete` reads it only into
// a local it uses to derive the charge key. That is what makes the key
// uncomputable by anything upstream of `complete_operation_ticket`.
//
// HELD BY INSPECTION, NOT BY MACHINE. An earlier version of this comment said
// the property was "asserted structurally by the package over
// `pg_get_function_result`". It is not — stella_0014 §7 inspects privileges,
// constraints, triggers and policies, and never function result types. The
// claim was corrected rather than the assertion added, because adding one
// would be editing a published CAPABILITIES package from the integration line.
// Recorded as a residual for Train 4.1 (adversarial review A, MINOR).
//
// ---------------------------------------------------------------------------
// ONE TRANSACTION PER CALL — AND WHY THAT IS THE WHOLE POINT
// ---------------------------------------------------------------------------
// Every function below opens its OWN `withOrganizationDatabaseContext`. It
// would be less code to wrap bind -> execute -> complete in one context, and
// it would be wrong: the ticket row lock (`SELECT ... FOR UPDATE`) and the
// per-organization advisory lock `bind` takes are released only at COMMIT, so
// a single enclosing transaction would hold both across the whole grounding
// journey — retrieval, generation, citation validation — and serialize an
// entire organization behind one reviewer's question.
//
// Closing bind's transaction before generation starts is what turns the
// reservation into a ROW STATE (`status='bound'` with a live `expires_at`)
// instead of a held lock. INT-INT-001 §4 step 3 states this as the protocol's
// own requirement; this file is where it is either honoured or lost.
//
// Retrieval does open a transaction of its own — it must, because
// `chunks_in_scope_attested` is SECURITY DEFINER and reads the session claims.
// That transaction holds no ticket row and no advisory lock, which is the
// property that matters and the one being claimed.

import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withOrganizationDatabaseContext } from '@/lib/auth/database-context'
import { isCanonicalQueryHash } from '@/lib/stella/operation-ticket/canonical-query-hash'
import {
  GROUNDED_QUERY_CATEGORY,
  isStellaTicketCategory,
  type StellaTicketCategory,
} from '@/lib/stella/operation-ticket/categories'

/* -------------------------------------------------------------------------- */
/* Vocabulary — mirrored from the package, never widened                      */
/* -------------------------------------------------------------------------- */

/**
 * The grounded-query capability, re-exported under its historical name.
 *
 * TRAIN 4.3. Until this train the constant WAS the category: `issueOperationTicket`
 * interpolated it directly and took no category argument, which is how "the
 * client cannot choose a category" was held. Six more categories now use this
 * adapter, so the property has to be held somewhere a parameter exists —
 * `resolveIssuableCategory` in `lib/stella/operation-ticket/categories.ts`, and
 * the fact that every ISSUANCE surface names its category as a module constant
 * of its own action rather than reading one out of a request.
 *
 * The constant is kept (rather than every call site switching to the new name)
 * because `tests/cross-workstream/runtime-grounded-query.test.ts` pins the
 * grounded path by this symbol.
 */
export const GROUNDED_QUERY_TICKET_CATEGORY = GROUNDED_QUERY_CATEGORY

/**
 * The four abort reasons `operation_tickets_abort_reason_check` admits. A
 * fifth would be rejected by the constraint, so the union is the contract and
 * not a convention.
 */
export type OperationTicketAbortReason =
  | 'caller_abort'
  | 'execution_failed'
  | 'no_result'
  | 'quota_refused'

/** SQLSTATEs the package raises. Mapped, never surfaced verbatim. */
const TICKET_ERROR_CODES = {
  MALFORMED: 'U0100',
  OUT_OF_SCOPE: 'U0102',
  UNGOVERNED: 'U0106',
  QUERY_MISMATCH: 'U0107',
  EXPIRED: 'U0108',
  SETTLED: 'U0109',
  /**
   * R2-INT (prepared stella_0015). The ticket belongs to a DIFFERENT PROJECT
   * than the one the governed surface says it is executing against.
   *
   * DISTINCT AT THE DATABASE BOUNDARY, COLLAPSED AT THE PRODUCT ONE, and both
   * halves are deliberate. The package keeps its own SQLSTATE so an operator
   * reading a log can tell a cross-project presentation from a cross-tenant
   * one, from an expired ticket and from a wiring bug — six causes that need
   * six different responses. `classifyTicketError` then maps it to
   * `out_of_scope`, which is the same product sentence every other scope
   * failure gets, for the tenancy-oracle reason `U0102` states in SQL.
   */
  PROJECT_MISMATCH: 'U0110',
  /**
   * R1 (prepared stella_0016). The conversion was asked to charge a reservation
   * that is not live — not `bound`, expired, or welded to a different scope or
   * category than the one being charged.
   *
   * It is raised by `settle_reserved_quota`, which re-reads the ticket row
   * itself rather than trusting the verb that called it. That independence is
   * the point: the conversion is granted to `uellix_cap_stella_ticket` and to
   * nothing else, so it is the last thing standing between a ticket and the
   * append-only ledger.
   */
  RESERVATION_NOT_LIVE: 'U0111',
} as const

/**
 * The shape of a project id, checked in Node so a malformed value never becomes
 * a database round trip that comes back as U0100 and has to be classified.
 *
 * Deliberately a SHAPE check and nothing more. This module cannot verify that
 * the project is one the caller may execute against — that is exactly what the
 * database re-imposes, against the value welded onto the ticket at issue, which
 * is the only copy no request can influence.
 */
function isProjectId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export type OperationTicketRejection =
  | 'malformed'
  | 'out_of_scope'
  | 'ungoverned'
  | 'query_mismatch'
  | 'expired'
  | 'settled'
  /**
   * TRAIN 4.3. The ticket exists, belongs to this organization, this actor and
   * this project — and was issued for a DIFFERENT capability than the surface
   * presenting it.
   *
   * NOT A SQLSTATE, and the asymmetry is worth stating rather than hiding.
   * `complete_operation_ticket` reads the category off the TICKET ROW under the
   * row lock and passes it to the conversion, so a cross-category presentation
   * cannot produce a charge under a category the ticket does not hold — the
   * database is already safe. What it WOULD produce is an internally
   * inconsistent ledger row: `stella_role = 'advisor'` next to a
   * `response_json` the validator generated, with nothing in the trail saying
   * which one ran.
   *
   * That is an ATTRIBUTION defect of exactly the shape R2-INT reports for the
   * project, and it is closed the same way: by comparing, before the work runs,
   * a value the server derived against the value welded onto the ticket at
   * issue. The comparison happens in Node because no published function accepts
   * an expected category, and adding one would mean editing a CAPABILITIES
   * package from the integration line. Recorded as a residual: a database-side
   * `p_expected_category` would make this structural instead of layered.
   */
  | 'category_mismatch'
  | 'unavailable'

/* -------------------------------------------------------------------------- */
/* Result shapes                                                              */
/* -------------------------------------------------------------------------- */

export type IssueTicketResult =
  | { readonly kind: 'issued'; readonly ticketId: string }
  | { readonly kind: 'rejected'; readonly reason: OperationTicketRejection }

export type BindTicketResult =
  /** The reservation is held — freshly taken, or already held by a retried bind. */
  | { readonly kind: 'bound'; readonly used: number | null; readonly quota: number | null }
  /** The ticket was already completed and charged. The caller must NOT re-execute. */
  | { readonly kind: 'already_completed' }
  | { readonly kind: 'quota_exceeded'; readonly used: number | null; readonly quota: number | null }
  | { readonly kind: 'no_quota'; readonly used: number | null; readonly quota: number | null }
  | { readonly kind: 'rejected'; readonly reason: OperationTicketRejection }

export type CompleteTicketResult =
  /** Charged exactly one unit, through `uellix_stella.consume_stella_quota`. */
  | { readonly kind: 'completed'; readonly used: number | null; readonly quota: number | null }
  /** Already completed on an earlier delivery. Zero additional charge. */
  | { readonly kind: 'replayed' }
  /**
   * R1. The ledger refused AFTER the work ran, because a sibling Stella action
   * charged between bind and complete. The ticket stays `bound` and abortable;
   * nothing was charged. Never collapsed into a generic failure, because the
   * caller has to abort it with `quota_refused` rather than retry it.
   */
  | { readonly kind: 'quota_refused'; readonly used: number | null; readonly quota: number | null }
  | { readonly kind: 'rejected'; readonly reason: OperationTicketRejection }

export type AbortTicketResult =
  | { readonly kind: 'aborted' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'rejected'; readonly reason: OperationTicketRejection }

export interface OperationTicketInspection {
  readonly status: 'issued' | 'bound' | 'completed' | 'aborted' | 'expired'
  readonly category: string
  readonly expiresAt: string
  readonly hasQueryHash: boolean
}

/* -------------------------------------------------------------------------- */
/* Error classification                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Find the SQLSTATE, wherever the driver stack left it.
 *
 * NOT simply `error.code`. Drizzle wraps every failure from `db.execute` in a
 * `DrizzleQueryError` carrying `{ query, params, cause }`, and the PostgresError
 * with the actual SQLSTATE sits on `cause` — so reading the top-level `code`
 * finds `undefined` for EVERY refusal the package raises, and every one of
 * `U0100`/`U0102`/`U0107`/`U0108`/`U0109` silently classifies as
 * `unavailable`.
 *
 * That mattered: `unavailable` maps to "Stella could not complete", while the
 * refusals map to "this operation is no longer valid". The reviewer would have
 * been told the system broke when in fact their ticket was rejected — and the
 * distinction is the one an operator uses to tell a bug from an attack.
 *
 * Found by tests/e2e/stella-ticket-journey.e2e.test.ts, which presented a bound
 * ticket with a second query and got the wrong product code back.
 *
 * The walk is depth-bounded: a cause cycle would otherwise hang the request.
 */
function sqlStateOf(error: unknown): unknown {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Maps a PostgreSQL error to a rejection reason using its SQLSTATE ONLY.
 *
 * Never the message. The package is careful not to interpolate arguments into
 * its messages, but matching on message text would make this adapter's
 * behaviour depend on a string a future edit is free to reword — and would
 * turn a wording change into a silent reclassification of a security refusal.
 */
function classifyTicketError(error: unknown): OperationTicketRejection {
  const code = sqlStateOf(error)
  switch (code) {
    case TICKET_ERROR_CODES.MALFORMED:
      return 'malformed'
    case TICKET_ERROR_CODES.OUT_OF_SCOPE:
      return 'out_of_scope'
    case TICKET_ERROR_CODES.UNGOVERNED:
      return 'ungoverned'
    case TICKET_ERROR_CODES.QUERY_MISMATCH:
      return 'query_mismatch'
    case TICKET_ERROR_CODES.EXPIRED:
      return 'expired'
    case TICKET_ERROR_CODES.SETTLED:
      return 'settled'
    case TICKET_ERROR_CODES.RESERVATION_NOT_LIVE:
      // TRAIN 4.3. `settle_reserved_quota` re-reads the ticket row INDEPENDENTLY
      // of the verb that called it and refuses unless the reservation is still
      // `bound`, unexpired, and welded to the organization, project and category
      // it is being asked to charge (prepared stella_0016 §5, stella_0017 §3).
      //
      // Reaching it through `complete_operation_ticket` means the reservation
      // lapsed between that verb's own expiry check and the conversion — a
      // window of microseconds, but a real one. Reported as `expired` because
      // that is what it is, and because the caller's obligation is identical to
      // an expiry: do not present the answer, do not retry this ticket.
      return 'expired'
    case TICKET_ERROR_CODES.PROJECT_MISMATCH:
      // Collapsed into `out_of_scope` ON PURPOSE, and not because the union is
      // inconvenient to widen. Every scope failure reaches the reviewer as one
      // sentence, so a caller cannot probe the difference between "another
      // organization", "another actor", "another project" and "no such ticket".
      // The distinction survives where it is useful — the SQLSTATE is in the
      // database log, and stella_0015 raises it for nothing else.
      return 'out_of_scope'
    default:
      // A connection failure, a package that is not applied, a permission
      // error. Deliberately NOT collapsed into any of the above: "the database
      // refused you" and "the database was not reachable" are different facts
      // and the caller charges/aborts differently on each.
      return 'unavailable'
  }
}

/**
 * The refusal for a call whose execution project is not a project id at all —
 * FAIL CLOSED.
 *
 * The parameter is REQUIRED since Train 4.2, so within typed code this branch is
 * unreachable and that is the intent: it exists for the edges TypeScript does
 * not police — a value that crossed a JSON boundary, a `as never` cast, a test
 * double that passes `undefined`. Refused here rather than sent to the database
 * to come back as U0100 and be classified.
 *
 * `out_of_scope` rather than `malformed`: a caller that cannot name the project
 * it is executing against has not come through a governed surface, which is a
 * scope failure and not a typo. It reaches the reviewer as the same UNAUTHORIZED
 * sentence every other scope failure does.
 *
 * NEVER defaulted to the ticket's own project. That substitution is the defect
 * R2-INT reports, written as a convenience: the ticket's project is what the
 * comparison is AGAINST, so using it as the expected value makes every
 * comparison trivially true.
 */
function unboundProject(): { readonly kind: 'rejected'; readonly reason: OperationTicketRejection } {
  return { kind: 'rejected', reason: 'out_of_scope' }
}

/** Rows come back as `unknown`; read the three columns by name, never by index. */
function readOutcomeRow(rows: unknown): { outcome: string; used: number | null; quota: number | null } | null {
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
  if (!row || typeof row.outcome !== 'string') return null
  return {
    outcome: row.outcome,
    used: row.used === null || row.used === undefined ? null : Number(row.used),
    quota: row.quota === null || row.quota === undefined ? null : Number(row.quota),
  }
}

/* -------------------------------------------------------------------------- */
/* 1. issue                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Mint an operation ticket.
 *
 * Both ids are SERVER-DERIVED by the caller (the organization from the
 * session, the project from a bound server-action argument), and the package
 * re-derives the actor itself from `auth.uid()` — there is no actor parameter,
 * so "the ticket belongs to whoever asked for it" is not something this
 * adapter can get wrong.
 */
export async function issueOperationTicket(
  organizationId: string,
  projectId: string,
  category: StellaTicketCategory,
): Promise<IssueTicketResult> {
  // TRAIN 4.3. REQUIRED, and refused in Node when it is not one of the seven
  // `operation_tickets_category_check` admits.
  //
  // The check is NOT what stops a client choosing its own category — an
  // allowlist would happily accept `'composer'` from a request body. What stops
  // that is upstream: every issuance surface names its category as a module
  // constant, and the one surface that legitimately has three
  // (`issueStellaReviewerTicket`) runs the inbound value through
  // `resolveIssuableCategory` against the set of roles whose flag is ON. This
  // is the last fail-closed guard, so a category that reached here by some path
  // nobody anticipated is refused before it becomes a `U0106` to classify.
  if (!isStellaTicketCategory(category)) {
    return { kind: 'rejected', reason: 'ungoverned' }
  }

  try {
    const rows = await withOrganizationDatabaseContext(() =>
      db.execute(sql`
        SELECT uellix_stella_ops.issue_operation_ticket(
          ${organizationId}::uuid,
          ${projectId}::uuid,
          ${category}::varchar(50)
        ) AS ticket_id
      `),
    )
    const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
    const ticketId = row?.ticket_id
    if (typeof ticketId !== 'string' || !/^[0-9a-f]{64}$/.test(ticketId)) {
      return { kind: 'rejected', reason: 'unavailable' }
    }
    return { kind: 'issued', ticketId }
  } catch (error) {
    return { kind: 'rejected', reason: classifyTicketError(error) }
  }
}

/* -------------------------------------------------------------------------- */
/* 2. bind — fix the digest and RESERVE                                       */
/* -------------------------------------------------------------------------- */

/**
 * Bind the ticket to this question and reserve one unit.
 *
 * `already_completed` is the case the whole of FASE 11 turns on. `bind` returns
 * the ticket's current status when it is already `bound` or `completed`, and
 * the two must NOT be collapsed: a retried bind on a `bound` ticket means "go
 * ahead and run the work", while the same call on a `completed` ticket means
 * "the work already ran and was already charged — do not run it again". A
 * caller that treated both as "proceed" would re-execute a paid operation and
 * could return an answer different from the one the charge paid for.
 */
export async function bindOperationTicket(
  ticketId: string,
  expectedProjectId: string,
  queryHash: string,
): Promise<BindTicketResult> {
  // Refused in Node so a malformed digest never becomes a database round trip
  // that comes back as U0100 and has to be classified.
  if (!isCanonicalQueryHash(queryHash) || !isCanonicalQueryHash(ticketId)) {
    return { kind: 'rejected', reason: 'malformed' }
  }
  if (!isProjectId(expectedProjectId)) return unboundProject()

  try {
    const rows = await withOrganizationDatabaseContext(() =>
      db.execute(sql`
        SELECT outcome, used, quota
        FROM uellix_stella_ops.bind_operation_ticket(
          ${ticketId}::char(64),
          ${expectedProjectId}::uuid,
          ${queryHash}::char(64)
        )
      `),
    )
    const row = readOutcomeRow(rows)
    if (!row) return { kind: 'rejected', reason: 'unavailable' }

    switch (row.outcome) {
      // `bound` covers BOTH a fresh reservation and an idempotent re-bind of a
      // ticket that already held one — the package returns the row's status
      // verbatim in the second case. They are deliberately NOT told apart
      // here: to the caller both mean "the reservation is held, run the work",
      // and the only thing that distinguishes them in the result row is `used`
      // being NULL on the idempotent path, which is a weaker signal than the
      // status itself and not worth branching on.
      case 'bound':
        return { kind: 'bound', used: row.used, quota: row.quota }
      // `completed` is the one that must NEVER be read as "proceed". The work
      // already ran and was already charged; re-running it would produce a
      // second answer for a single charge. This is what FASE 11 turns on.
      case 'completed':
        return { kind: 'already_completed' }
      case 'quota_exceeded':
        return { kind: 'quota_exceeded', used: row.used, quota: row.quota }
      case 'no_quota':
        return { kind: 'no_quota', used: row.used, quota: row.quota }
      default:
        return { kind: 'rejected', reason: 'unavailable' }
    }
  } catch (error) {
    return { kind: 'rejected', reason: classifyTicketError(error) }
  }
}

/* -------------------------------------------------------------------------- */
/* 3. complete — settle and charge                                            */
/* -------------------------------------------------------------------------- */

/**
 * Settle the ticket and charge exactly one unit.
 *
 * `replayed` and `completed` are BOTH successful settlements and both mean
 * "the ledger holds exactly one row for this ticket". They are kept apart
 * because only one of them charged on THIS call, and the observability event
 * that distinguishes `quota_consumed` from `quota_reuse_detected` needs to say
 * which.
 */
export async function completeOperationTicket(
  ticketId: string,
  expectedProjectId: string,
  queryHash: string,
): Promise<CompleteTicketResult> {
  if (!isCanonicalQueryHash(queryHash) || !isCanonicalQueryHash(ticketId)) {
    return { kind: 'rejected', reason: 'malformed' }
  }
  if (!isProjectId(expectedProjectId)) return unboundProject()

  try {
    const rows = await withOrganizationDatabaseContext(() =>
      db.execute(sql`
        SELECT outcome, used, quota
        FROM uellix_stella_ops.complete_operation_ticket(
          ${ticketId}::char(64),
          ${expectedProjectId}::uuid,
          ${queryHash}::char(64)
        )
      `),
    )
    const row = readOutcomeRow(rows)
    if (!row) return { kind: 'rejected', reason: 'unavailable' }

    switch (row.outcome) {
      case 'completed':
        return { kind: 'completed', used: row.used, quota: row.quota }
      case 'replayed':
        return { kind: 'replayed' }
      // R1. `quota_exceeded` and `no_quota` from THIS function mean the ledger
      // refused a charge for work that already ran. One name for both, because
      // the caller's obligation is identical: abort with `quota_refused` and
      // refuse to present the answer.
      case 'quota_exceeded':
      case 'no_quota':
        return { kind: 'quota_refused', used: row.used, quota: row.quota }
      default:
        return { kind: 'rejected', reason: 'unavailable' }
    }
  } catch (error) {
    return { kind: 'rejected', reason: classifyTicketError(error) }
  }
}

/* -------------------------------------------------------------------------- */
/* 3b. complete (sibling) — settle, charge AND file the interaction row       */
/* -------------------------------------------------------------------------- */

/**
 * The audit payload the five sibling Stella actions used to write themselves.
 *
 * Every field here was, until Train 4.3, a column in a `db.insert(stellaInteractions)`
 * call inside a server action. They are the same values; what changed is who
 * writes them. `uellix_app` now holds NO write privilege on
 * `public.stella_interactions` (prepared stella_0017 §1), so this object is
 * ARGUMENTS TO A GOVERNED FUNCTION rather than a row the runtime composes.
 *
 * FOUR COLUMNS ARE ABSENT ON PURPOSE, and their absence is the security
 * property rather than an omission:
 *
 *   organization_id   read off the ticket row, under the row lock
 *   project_id        idem — and re-proved against `expectedProjectId` first
 *   created_by        `auth.uid()`, inside the function; there is no parameter
 *   stella_role       the ticket's own `category`, welded at issue
 *   context_hash      the digest the ticket was BOUND to, fixed write-once
 *   idempotency_key   derived from a nonce no function returns
 *
 * A caller therefore cannot move the charge to another organization, another
 * project, another actor, another capability or another identity — not by
 * lying, and not by being wrong. What it CAN supply is what only it knows: what
 * the model was asked to do, which model answered, how much it cost, and what
 * it said.
 *
 * `riskLevel` and `riskFlags` have no parameter in prepared stella_0017 and are
 * therefore NOT filed by this path. Declared, not silently dropped: see
 * docs/ops/contracts/CONTRACT_LEDGER.md — the validator and reviewer rows lose
 * two derived columns whose values remain fully recoverable from
 * `response_json`, and closing that gap means a new package argument rather
 * than a runtime workaround.
 */
export interface StellaInteractionPayload {
  /** `stella_interactions.pipeline_step`. Defaults to the category in SQL when null. */
  readonly pipelineStep: string | null
  /** `stella_interactions.model_used` — as reported by the adapter that answered. */
  readonly modelUsed: string | null
  /** `stella_interactions.tokens_used`. Refused by SQL (`U0100`) when negative. */
  readonly tokensUsed: number | null
  /** `stella_interactions.response_json` — the parsed, schema-validated output. */
  readonly responseJson: unknown
}

/**
 * Settle a SIBLING ticket: charge exactly one unit AND file the interaction row
 * that unit pays for, in ONE transaction.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SECOND FUNCTION AND NOT A FOURTH ARGUMENT ON THE FIRST
 * ---------------------------------------------------------------------------
 * It mirrors the package. `stella_0017` publishes a seven-argument OVERLOAD of
 * `complete_operation_ticket` next to the three-argument one rather than
 * replacing it, because a grounded query has no `stella_interactions`
 * representation to file and would have to pass four NULLs to say so. Two
 * shapes, two wrappers, and a reader comparing this file against the package is
 * comparing two lists in the same order.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE RESULT MEANS
 * ---------------------------------------------------------------------------
 * `completed` — the unit is charged and the row is filed. Only now may the
 * caller return the answer.
 * `replayed` — a delivery of this ticket already completed. The ledger holds
 * exactly one row; nothing was charged again, and the row was NOT overwritten
 * with this delivery's payload (an append-only trail is not edited).
 * `quota_refused` — UNREACHABLE against the healthy stella_0016 chain, and kept
 * anyway. The conversion evaluates no limit, so a refusal here could only come
 * from a database where `settle_reserved_quota` still charges through the
 * limit-checking path — i.e. an installation missing stella_0016. Fail-closed
 * beats fail-silent: the caller aborts and withholds the answer.
 */
export async function completeStellaInteractionTicket(
  ticketId: string,
  expectedProjectId: string,
  operationHash: string,
  payload: StellaInteractionPayload,
): Promise<CompleteTicketResult> {
  if (!isCanonicalQueryHash(operationHash) || !isCanonicalQueryHash(ticketId)) {
    return { kind: 'rejected', reason: 'malformed' }
  }
  if (!isProjectId(expectedProjectId)) return unboundProject()
  // Refused in Node rather than sent to come back as `U0100`. A negative token
  // count is not a transport accident — it is an adapter reporting something
  // impossible — and the abort path the caller takes on a rejection is the
  // right response to it.
  if (payload.tokensUsed !== null && !Number.isInteger(payload.tokensUsed)) {
    return { kind: 'rejected', reason: 'malformed' }
  }
  if (payload.tokensUsed !== null && payload.tokensUsed < 0) {
    return { kind: 'rejected', reason: 'malformed' }
  }

  try {
    const rows = await withOrganizationDatabaseContext(() =>
      db.execute(sql`
        SELECT outcome, used, quota
        FROM uellix_stella_ops.complete_operation_ticket(
          ${ticketId}::char(64),
          ${expectedProjectId}::uuid,
          ${operationHash}::char(64),
          ${payload.pipelineStep}::varchar(100),
          ${payload.modelUsed}::varchar(100),
          ${payload.tokensUsed}::integer,
          ${JSON.stringify(payload.responseJson ?? null)}::jsonb
        )
      `),
    )
    const row = readOutcomeRow(rows)
    if (!row) return { kind: 'rejected', reason: 'unavailable' }

    switch (row.outcome) {
      case 'completed':
        return { kind: 'completed', used: row.used, quota: row.quota }
      case 'replayed':
        return { kind: 'replayed' }
      case 'quota_exceeded':
      case 'no_quota':
        return { kind: 'quota_refused', used: row.used, quota: row.quota }
      default:
        return { kind: 'rejected', reason: 'unavailable' }
    }
  } catch (error) {
    return { kind: 'rejected', reason: classifyTicketError(error) }
  }
}

/* -------------------------------------------------------------------------- */
/* 4. abort — release the reservation                                         */
/* -------------------------------------------------------------------------- */

/**
 * Release the reservation of a ticket of THIS execution project.
 *
 * The project argument is not symmetry with bind/complete: without it one
 * project's surface could discard the reservation another project's in-flight
 * operation is holding. Nothing is charged either way, so it is not a billing
 * defect — it is a denial of service, and the victim discovers it as a `settled`
 * refusal on a `complete` whose work has already run.
 */
export async function abortOperationTicket(
  ticketId: string,
  expectedProjectId: string,
  reason: OperationTicketAbortReason,
): Promise<AbortTicketResult> {
  if (!isCanonicalQueryHash(ticketId)) {
    return { kind: 'rejected', reason: 'malformed' }
  }
  if (!isProjectId(expectedProjectId)) return unboundProject()

  try {
    const rows = await withOrganizationDatabaseContext(() =>
      db.execute(sql`
        SELECT uellix_stella_ops.abort_operation_ticket(
          ${ticketId}::char(64),
          ${expectedProjectId}::uuid,
          ${reason}::varchar(40)
        ) AS outcome
      `),
    )
    const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
    const outcome = row?.outcome
    if (outcome === 'aborted') return { kind: 'aborted' }
    if (outcome === 'expired') return { kind: 'expired' }
    return { kind: 'rejected', reason: 'unavailable' }
  } catch (error) {
    return { kind: 'rejected', reason: classifyTicketError(error) }
  }
}

/* -------------------------------------------------------------------------- */
/* 5. inspect — status only, never the digest                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a ticket's lifecycle state. Returns `has_query_hash` as a BOOLEAN, not
 * the digest: knowing whether a ticket has been bound is operationally useful,
 * and knowing WHICH question it was bound to is not something any caller of
 * this adapter needs.
 */
export async function inspectOperationTicket(
  ticketId: string,
  expectedProjectId: string,
): Promise<OperationTicketInspection | null> {
  if (!isCanonicalQueryHash(ticketId)) return null
  // `null` and not a rejection: this function's contract is already "the state,
  // or nothing". A caller with no execution project gets the same answer as a
  // caller asking about a ticket it may not read, which is the answer it should
  // have got in either case.
  if (!isProjectId(expectedProjectId)) return null

  try {
    const rows = await withOrganizationDatabaseContext(() =>
      db.execute(sql`
        SELECT status, category, expires_at, has_query_hash
        FROM uellix_stella_ops.inspect_operation_ticket(
          ${ticketId}::char(64),
          ${expectedProjectId}::uuid
        )
      `),
    )
    const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
    if (!row || typeof row.status !== 'string') return null
    return {
      status: row.status as OperationTicketInspection['status'],
      category: String(row.category ?? ''),
      expiresAt: String(row.expires_at ?? ''),
      hasQueryHash: row.has_query_hash === true,
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* 6. expire — hygiene only                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Transition stale tickets to `expired`.
 *
 * OPERATIONAL HYGIENE, NOT A GUARANTEE. `bind`'s headroom count already
 * excludes reservations whose `expires_at` has passed, so an orphaned ticket
 * stops consuming quota whether or not this is ever called (INT-INT-001 §4,
 * "la reserva huérfana"). Nothing in the runtime path calls it; it exists so
 * an operator's view of the table eventually agrees with the truth.
 */
export async function expireOperationTickets(max: number): Promise<number> {
  try {
    const rows = await withOrganizationDatabaseContext(() =>
      db.execute(sql`SELECT uellix_stella_ops.expire_operation_tickets(${max}::integer) AS expired`),
    )
    const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
    return Number(row?.expired ?? 0)
  } catch {
    return 0
  }
}
