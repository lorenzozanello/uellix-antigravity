// lib/stella/operation-ticket/governed-operation.ts
// INTEGRATION — Train 4.3, FASE 6. ONE protocol for every governed Stella
// operation, and the reason there are not five of them.
//
// ---------------------------------------------------------------------------
// WHAT THIS REPLACES
// ---------------------------------------------------------------------------
// Until this train the five sibling actions each carried their own copy of:
//
//     checkStellaQuota(org)          // an UNLOCKED count, then...
//     ...call the provider...
//     a direct INSERT into stella_interactions   // ...an UNGOVERNED write
//
// Three things were wrong with it and all three are the same thing. The count
// took no lock, so two actions could both read "one unit left" and both file a
// row — the organization sold a unit it did not have. The count could not see a
// live grounded RESERVATION, so a sibling could spend the unit a bound ticket
// was holding, and that ticket's `complete` was then refused on work that had
// already run (R1). And the write was a direct INSERT by `uellix_app`, so the
// arithmetic was advisory: a correct calculation in front of a door anyone
// could walk around (R6-INT).
//
// The replacement is not "the same steps, better". It is a different shape:
//
//     issue    server mints a ticket; category, scope and identity welded on
//     bind     RESERVE one unit under the per-organization advisory lock
//     execute  the provider call — OUTSIDE that transaction, holding no lock
//     complete convert the reservation into a charge AND file the audit row,
//              in one transaction, through a function `uellix_app` cannot call
//              any other way
//     abort    release without charging, on every failure path
//
// ---------------------------------------------------------------------------
// WHY IT IS A DRIVER AND NOT A BASE CLASS OR FIVE COPIES
// ---------------------------------------------------------------------------
// "No crees cinco implementaciones separadas" is not a tidiness request. The
// ordering below IS the security property — bind before execute, complete
// before the answer is returned, abort on every exit that is neither — and a
// property spread across five files is a property that will be true in four of
// them after the next edit. Here it is written once, and `execute` is a
// CALLBACK: an action supplies what it does, and cannot supply WHEN.
//
// Specifically, an action has no way to return its result early. The driver
// returns `{ kind: 'completed', data }` only on the branch that reached
// `completeStellaInteractionTicket` and got `completed` back. There is no
// parameter, no option and no overload that hands back `data` on any other
// path.
//
// ---------------------------------------------------------------------------
// WHAT THE DRIVER REFUSES TO TAKE FROM ITS CALLER
// ---------------------------------------------------------------------------
//   the category      a constant of the ISSUANCE surface, welded onto the
//                     ticket in SQL, and re-checked here against the ticket
//   the organization  from `requireOrganizationAccess()`, by the action
//   the project       the server-bound route param, by the action
//   the actor         `auth.uid()`, inside SQL; there is no parameter at all
//   the identity      derived in SQL from a nonce no function returns
//
// What it does take is the REQUEST DESCRIPTOR (`requestParts`), and that is
// hashed, not trusted: see operation-request-hash.ts for why the digest bounds
// reuse of a ticket and is emphatically not the operation's identity.

import { randomUUID } from 'node:crypto'
import {
  abortOperationTicket,
  bindOperationTicket,
  completeStellaInteractionTicket,
  inspectOperationTicket,
  type OperationTicketAbortReason,
  type OperationTicketRejection,
} from '@/db/stella/operation-tickets'
import { emitTicketEvent, type TicketEventScope } from './ticket-observability'
import { operationRequestHash } from './operation-request-hash'
import type { StellaInteractionCategory } from './categories'

/* -------------------------------------------------------------------------- */
/* What an action supplies                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The result of ONE provider round trip, as the action observed it.
 *
 * The failure half carries the action's OWN error value (`F`), untouched. The
 * driver does not learn the twelve-code Stella taxonomy and does not map it:
 * its only interest in a failure is that the reservation must be released and
 * nothing charged. Keeping `F` opaque is what lets the advisor return
 * `GEMINI_ERROR`, the composer return a numeric-guard refusal and the reviewer
 * return `PARSE_ERROR` through one driver that knows none of them.
 */
export type StellaOperationExecution<T, F> =
  | {
      readonly ok: true
      readonly data: T
      /** `stella_interactions.pipeline_step`. */
      readonly pipelineStep: string | null
      /** `stella_interactions.model_used`, as reported by the adapter. */
      readonly modelUsed: string | null
      /** `stella_interactions.tokens_used`. */
      readonly tokensUsed: number | null
    }
  | {
      readonly ok: false
      readonly failure: F
      /**
       * Why the reservation is being released. `no_result` when the operation
       * ran and produced nothing usable (a refused draft, an empty finding
       * set); `execution_failed` when it broke. Both charge zero — the
       * distinction is for the operator reading `operation_tickets`, not for
       * the ledger.
       */
      readonly abortReason: OperationTicketAbortReason
    }

export interface GovernedStellaOperationInput<T, F> {
  /** Fixed by the ISSUANCE surface, never by a request. */
  readonly category: StellaInteractionCategory
  /** From `requireOrganizationAccess()`. */
  readonly organizationId: string
  /** The server-bound execution project. */
  readonly projectId: string
  /** The opaque ticket the client presented. Never trusted; always re-proved in SQL. */
  readonly ticket: string
  /**
   * The functional arguments, in a fixed order the ACTION chooses. Hashed into
   * the bind digest so one ticket cannot be reused for a different request.
   */
  readonly requestParts: readonly (string | null | undefined)[]
  /**
   * The work. Runs BETWEEN bind and complete, in neither transaction, holding
   * no ticket row lock and no advisory lock — which is what keeps one
   * reviewer's provider round trip from serialising their whole organization.
   */
  readonly execute: () => Promise<StellaOperationExecution<T, F>>
}

/* -------------------------------------------------------------------------- */
/* What the driver returns                                                    */
/* -------------------------------------------------------------------------- */

export type GovernedStellaOperationOutcome<T, F> =
  /** Charged exactly one unit, filed exactly one row. ONLY now may `data` be returned. */
  | { readonly kind: 'completed'; readonly data: T }
  /**
   * Refused BEFORE the work ran — the only point at which refusing is free. The
   * ticket stays `issued`: nothing reserved, nothing charged, provider never
   * called.
   */
  | {
      readonly kind: 'quota_exceeded'
      readonly reason: 'quota_exceeded' | 'no_quota'
      readonly used: number | null
      readonly quota: number | null
    }
  /**
   * This ticket already ran and was already charged, and the answer it paid for
   * is not recoverable.
   *
   * The three things NOT done here are the point: the work is not re-run (a
   * second answer for one charge), no answer is invented, and nothing is
   * charged again. Same disposition `app/actions/stella/grounded-query.ts` took
   * for its own post-complete retry, and the same operational code —
   * `ALREADY_COMPLETED_RESULT_UNAVAILABLE` — reaches the reviewer.
   */
  | { readonly kind: 'already_completed' }
  /** A forged, borrowed, expired, cross-scope, cross-category or settled ticket. */
  | { readonly kind: 'rejected'; readonly reason: OperationTicketRejection }
  /** The work failed. The reservation was released; nothing was charged. */
  | { readonly kind: 'execution_failed'; readonly failure: F }
  /**
   * The settlement itself failed and we do NOT know whether the charge landed.
   * The answer is withheld: presenting it would be presenting an answer that
   * may never have been accounted for.
   */
  | { readonly kind: 'settlement_failed' }
  /**
   * R1's fail-closed remnant. The conversion refused a charge for work that has
   * already run.
   *
   * UNREACHABLE against the healthy stella_0016 chain — the conversion
   * evaluates no limit, because the unit was committed at bind and has counted
   * against the cap ever since. It survives as a NEGATIVE CONTROL: a database
   * where `settle_reserved_quota` still charges through the limit-checking path
   * (i.e. stella_0016 not applied) reaches it, and the answer is discarded
   * rather than given away silently. See docs/ops/workstreams/RELEASE.md.
   */
  | {
      readonly kind: 'quota_refused_after_execution'
      readonly used: number | null
      readonly quota: number | null
    }

/* -------------------------------------------------------------------------- */
/* The driver                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run one governed Stella operation end to end.
 *
 * ORDER IS THE SECURITY PROPERTY. Read the branches top to bottom: every exit
 * after `bind` succeeds either COMPLETES the ticket or ABORTS it, and the only
 * branch that returns `data` is the one that completed. There is no path that
 * returns while leaving a reservation silently bound — and the one place an
 * unguarded exception could have created one (`execute` throwing) is caught.
 */
export async function runGovernedStellaOperation<T, F>(
  input: GovernedStellaOperationInput<T, F>,
): Promise<GovernedStellaOperationOutcome<T, F>> {
  const { category, organizationId, projectId, ticket } = input

  // The digest this ticket is bound to. Computed BEFORE any row is read, from
  // the request alone, so a retry thirty seconds later produces the same value
  // even if the project's data has moved underneath it.
  const operationHash = operationRequestHash({ category, projectId, parts: input.requestParts })

  // Telemetry correlation only. Minted per INVOCATION, so a retry carries a NEW
  // one while reusing the SAME ticket — the opposite of an identity. It never
  // reaches the database.
  const events: TicketEventScope = { organizationId, projectId, requestId: randomUUID() }

  // -----------------------------------------------------------------------
  // 1. BIND — reserve one unit under the per-organization advisory lock. The
  //    transaction closes here; from this point the reservation is a ROW STATE
  //    (`status='bound'` with a live `expires_at`), not a held lock.
  // -----------------------------------------------------------------------
  //
  //    THIS IS ALSO THE QUOTA CHECK, and there is no other one. The unlocked
  //    `checkStellaQuota` read the five actions used to perform is gone: it
  //    counted the same rows `bind` counts, without the lock `bind` takes and
  //    without seeing a live reservation at all, so keeping both would mean two
  //    numbers that can disagree — and the losing one is the one the reviewer
  //    was shown.
  //
  //    AND THIS IS ALSO THE CATEGORY CHECK, since prepared stella_0018. The
  //    surface's own constant travels with the call and SQL compares it against
  //    the value welded onto the ticket at issue, BEFORE the advisory lock and
  //    before any capacity is read. A cross-category presentation therefore
  //    reserves nothing — where the Node comparison below, which is older,
  //    could only release a reservation it had already taken.
  const bound = await bindOperationTicket(ticket, projectId, operationHash, category)

  if (bound.kind === 'already_completed') {
    emitTicketEvent('grounded_query_retried', events, { ticketId: ticket, attempt: 2 })
    emitTicketEvent('quota_reuse_detected', events, { ticketId: ticket })
    return { kind: 'already_completed' }
  }

  if (bound.kind === 'quota_exceeded' || bound.kind === 'no_quota') {
    // The organization has no headroom — counting CHARGED rows and LIVE
    // RESERVATIONS together, which is the whole of R1. The provider is never
    // called, so there is no work to give away and nothing to abort.
    emitTicketEvent('quota_capacity_rejected', events, { reasonCode: bound.kind })
    return { kind: 'quota_exceeded', reason: bound.kind, used: bound.used, quota: bound.quota }
  }

  if (bound.kind === 'rejected') {
    // `category_mismatch` arrives here since stella_0018 — refused by SQL at
    // bind, with nothing reserved and nothing to release. The event is emitted
    // with the same reason code the Node comparison below emits, so an operator
    // reading the stream cannot tell which layer refused and does not have to.
    emitTicketEvent('replay_rejected', events, { ticketId: ticket, reasonCode: bound.reason })
    return { kind: 'rejected', reason: bound.reason }
  }

  emitTicketEvent('operation_ticket_bound', events, { ticketId: ticket })
  emitTicketEvent('quota_reservation_created', events, { reservationId: ticket })

  // From here the ticket HOLDS A RESERVATION. Every exit below completes it
  // (charging exactly one unit) or aborts it (charging nothing).

  // -----------------------------------------------------------------------
  // 2. CATEGORY — the ticket's own, compared against the surface's own.
  // -----------------------------------------------------------------------
  //
  //    AFTER bind rather than before it, and the ordering is a deliberate
  //    trade. `inspectOperationTicket` answers "the state, or nothing", so a
  //    connection failure and a ticket the caller may not read are the same
  //    `null` — running it first would report a database outage as
  //    UNAUTHORIZED. `bind` classifies precisely (it distinguishes `expired`,
  //    `settled`, `out_of_scope` and `unavailable`), so letting it speak first
  //    means the common failures are named correctly and the category check
  //    only ever runs against a ticket already proved live and in scope.
  //
  //    The cost is one reservation held for the duration of one round trip on
  //    a path only a cross-category presentation reaches — and it is released
  //    immediately below, charging nothing.
  //
  //    WHY IT MATTERS AT ALL, given that SQL is already safe: the charge's
  //    category is read off the ticket ROW by `complete_operation_ticket`, so a
  //    forged category cannot be billed. What an unchecked mismatch WOULD
  //    produce is a ledger row saying `stella_role = 'advisor'` next to a
  //    `response_json` the validator generated — an attribution defect of the
  //    same shape R2-INT reports for the project, in an append-only table where
  //    it can never be corrected.
  const inspected = await inspectOperationTicket(ticket, projectId)
  if (inspected === null || inspected.category !== category) {
    await releaseReservation(ticket, projectId, 'caller_abort', events)
    emitTicketEvent('replay_rejected', events, {
      ticketId: ticket,
      reasonCode: 'category_mismatch',
    })
    return { kind: 'rejected', reason: 'category_mismatch' }
  }

  // -----------------------------------------------------------------------
  // 3. EXECUTE — the provider round trip. OUTSIDE both transactions.
  // -----------------------------------------------------------------------
  let executed: StellaOperationExecution<T, F>
  try {
    executed = await input.execute()
  } catch (error) {
    // An exception escaping here would leave the ticket `bound`: neither
    // completed nor aborted, holding a unit of the organization's headroom
    // until its window lapses. The SQL-side liveness predicate makes that
    // self-healing rather than permanent, so this is a robustness gap and not
    // a double charge — closed anyway, because the claim above ("every exit
    // completes or aborts") with one uncovered path is worse than no claim.
    await releaseReservation(ticket, projectId, 'execution_failed', events)
    throw error
  }

  if (!executed.ok) {
    await releaseReservation(ticket, projectId, executed.abortReason, events)
    return { kind: 'execution_failed', failure: executed.failure }
  }

  // -----------------------------------------------------------------------
  // 4. COMPLETE AND CHARGE. The answer exists but is NOT yet returnable:
  //    nothing is handed back until the ledger says a unit was accounted for.
  //    This ordering is the reason a failed charge cannot leave a usable
  //    answer behind.
  // -----------------------------------------------------------------------
  const settled = await completeStellaInteractionTicket(ticket, projectId, operationHash, {
    pipelineStep: executed.pipelineStep,
    modelUsed: executed.modelUsed,
    tokensUsed: executed.tokensUsed,
    responseJson: executed.data,
  })

  if (settled.kind === 'quota_refused') {
    // See `quota_refused_after_execution`. Fail-closed remnant of R1.
    await releaseReservation(ticket, projectId, 'quota_refused', events)
    emitTicketEvent('quota_cross_operation_contention', events, {
      reservationId: ticket,
      reasonCode: 'quota_refused',
    })
    return { kind: 'quota_refused_after_execution', used: settled.used, quota: settled.quota }
  }

  if (settled.kind === 'rejected') {
    // We do NOT know whether the charge landed. The abort attempt is safe in
    // BOTH worlds: if the charge did land the ticket is `completed` and SQL
    // refuses to abort it (`U0109`), so a successful charge can never be undone
    // by this line; if it did not, the reservation is released. Its result is
    // ignored for exactly that reason.
    await releaseReservation(ticket, projectId, 'execution_failed', events)
    return { kind: 'settlement_failed' }
  }

  if (settled.kind === 'replayed') {
    // THE CONCURRENT FORM OF THE POST-COMPLETE RETRY. Two deliveries of one
    // ticket that overlap both bind while it is still `bound`, both run the
    // whole operation, and only at `complete` does the loser learn that someone
    // else already settled it.
    //
    // Returning `data` here would hand back a SECOND answer — independently
    // generated, with its own tokens — for ONE charged unit. The ledger would
    // be right and the metering a fiction: the quota measures answers
    // delivered, and two would have been.
    emitTicketEvent('grounded_query_retried', events, { ticketId: ticket, attempt: 2 })
    emitTicketEvent('quota_reuse_detected', events, { ticketId: ticket })
    return { kind: 'already_completed' }
  }

  emitTicketEvent('quota_reservation_converted', events, { reservationId: ticket })
  emitTicketEvent('quota_consumed', events, { ticketId: ticket })

  return { kind: 'completed', data: executed.data }
}

/* -------------------------------------------------------------------------- */
/* One rejection reason -> one product presentation                           */
/* -------------------------------------------------------------------------- */

/**
 * Map a ticket rejection to the pair every sibling action returns.
 *
 * EVERY SCOPE FAILURE COLLAPSES TO ONE SENTENCE. Telling a caller that its
 * ticket belongs to another organization, to another project, to another
 * capability, or that it merely expired, would let it probe the difference —
 * the same tenancy-oracle reasoning `U0102` states in SQL, where "not yours"
 * and "never existed" are deliberately indistinguishable.
 *
 * `unavailable` is the one exception and it is not an exception to the oracle
 * rule: it says nothing about the caller. It means the DATABASE refused or was
 * unreachable — a missing prepared package, a dropped connection — and
 * reporting that as "your operation is no longer valid" would send a reviewer
 * to re-do work when an operator needs to apply a package.
 *
 * Shared, exported, and identical for all five actions ON PURPOSE: five
 * hand-written switches are five chances for one of them to leak the
 * distinction the other four hide.
 */
export function governedRejectionPresentation(
  reason: OperationTicketRejection,
): { readonly code: 'UNAUTHORIZED' | 'UNKNOWN_ERROR'; readonly message: string } {
  if (reason === 'unavailable') {
    return { code: 'UNKNOWN_ERROR', message: 'Stella no pudo completar la operación.' }
  }
  return {
    code: 'UNAUTHORIZED',
    message: 'Esta operación ya no es válida. Volvé a solicitarla.',
  }
}

/**
 * Release a reservation and say so.
 *
 * AWAITED, not fire-and-forget: until the abort lands the ticket still counts
 * against the organization's headroom in every concurrent `bind`. Returning
 * first and releasing later would let a failed operation keep blocking a
 * successful one.
 *
 * Never throws, and its result is not inspected. An abort that fails because
 * the ticket is already `completed` (`U0109`) is not an error to handle — it is
 * the protocol refusing to un-charge a settled operation.
 */
async function releaseReservation(
  ticketId: string,
  projectId: string,
  reason: OperationTicketAbortReason,
  events: TicketEventScope,
): Promise<void> {
  const released = await abortOperationTicket(ticketId, projectId, reason)
  if (released.kind === 'aborted') {
    emitTicketEvent('quota_reservation_released', events, { reservationId: ticketId })
  } else if (released.kind === 'expired') {
    emitTicketEvent('quota_reservation_expired', events, { reservationId: ticketId })
    emitTicketEvent('operation_ticket_expired', events, { ticketId })
  } else {
    emitTicketEvent('replay_rejected', events, { ticketId, reasonCode: released.reason })
  }
}
