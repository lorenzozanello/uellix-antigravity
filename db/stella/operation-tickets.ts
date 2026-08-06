// db/stella/operation-tickets.ts
// INTEGRATION — Train 4.1, INT-INT-001 §7 (2). The adapter for
// `db/prepared/stella_0014_operation_tickets.sql`.
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

/* -------------------------------------------------------------------------- */
/* Vocabulary — mirrored from the package, never widened                      */
/* -------------------------------------------------------------------------- */

/**
 * The governed capability this integration issues tickets for. `stella_0014`'s
 * `operation_tickets_category_check` admits seven; this line uses exactly one,
 * and naming it as a constant rather than a parameter means no caller can
 * choose a category — which is one of the things FASE 5 forbids the client
 * from supplying.
 */
export const GROUNDED_QUERY_TICKET_CATEGORY = 'grounded_query' as const

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
} as const

export type OperationTicketRejection =
  | 'malformed'
  | 'out_of_scope'
  | 'ungoverned'
  | 'query_mismatch'
  | 'expired'
  | 'settled'
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
    default:
      // A connection failure, a package that is not applied, a permission
      // error. Deliberately NOT collapsed into any of the above: "the database
      // refused you" and "the database was not reachable" are different facts
      // and the caller charges/aborts differently on each.
      return 'unavailable'
  }
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
): Promise<IssueTicketResult> {
  try {
    const rows = await withOrganizationDatabaseContext(() =>
      db.execute(sql`
        SELECT uellix_stella_ops.issue_operation_ticket(
          ${organizationId}::uuid,
          ${projectId}::uuid,
          ${GROUNDED_QUERY_TICKET_CATEGORY}::varchar(50)
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
export async function bindOperationTicket(ticketId: string, queryHash: string): Promise<BindTicketResult> {
  // Refused in Node so a malformed digest never becomes a database round trip
  // that comes back as U0100 and has to be classified.
  if (!isCanonicalQueryHash(queryHash) || !isCanonicalQueryHash(ticketId)) {
    return { kind: 'rejected', reason: 'malformed' }
  }

  try {
    const rows = await withOrganizationDatabaseContext(() =>
      db.execute(sql`
        SELECT outcome, used, quota
        FROM uellix_stella_ops.bind_operation_ticket(
          ${ticketId}::char(64),
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
  queryHash: string,
): Promise<CompleteTicketResult> {
  if (!isCanonicalQueryHash(queryHash) || !isCanonicalQueryHash(ticketId)) {
    return { kind: 'rejected', reason: 'malformed' }
  }

  try {
    const rows = await withOrganizationDatabaseContext(() =>
      db.execute(sql`
        SELECT outcome, used, quota
        FROM uellix_stella_ops.complete_operation_ticket(
          ${ticketId}::char(64),
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
/* 4. abort — release the reservation                                         */
/* -------------------------------------------------------------------------- */

export async function abortOperationTicket(
  ticketId: string,
  reason: OperationTicketAbortReason,
): Promise<AbortTicketResult> {
  if (!isCanonicalQueryHash(ticketId)) {
    return { kind: 'rejected', reason: 'malformed' }
  }

  try {
    const rows = await withOrganizationDatabaseContext(() =>
      db.execute(sql`
        SELECT uellix_stella_ops.abort_operation_ticket(
          ${ticketId}::char(64),
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
export async function inspectOperationTicket(ticketId: string): Promise<OperationTicketInspection | null> {
  if (!isCanonicalQueryHash(ticketId)) return null

  try {
    const rows = await withOrganizationDatabaseContext(() =>
      db.execute(sql`
        SELECT status, category, expires_at, has_query_hash
        FROM uellix_stella_ops.inspect_operation_ticket(${ticketId}::char(64))
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
