// tests/eval/stella-release/ticket-protocol.ts
// RELEASE line — Train 4.1 (STELLA_RELEASE_IDEMPOTENCY_GATE_TRAIN_4_1).
//
// WHAT THIS FILE IS, AND WHAT IT IS NOT
//
// INT-INT-001 (docs/ops/contracts/CONTRACT_LEDGER.md) reports that
// `uellix_stella.consume_stella_quota` (db/prepared/stella_0013_grounded_query_quota.sql)
// requires an idempotency key with no canonical server-side source, and lists
// three closures — a request-scoped id from middleware, A TABLE OF ISSUED
// OPERATION TICKETS with re-execution rejected on an already-charged ticket,
// or a dedicated signing secret — all explicitly "fuera del alcance de una
// integración". This train builds the EVALUATION CONTRACT for the second
// closure: what any future ticket protocol implementation MUST satisfy,
// independent of how it is eventually stored.
//
// `OperationTicketProtocol` below is an ABSTRACT interface — no SQL table
// name, no column name, no ORM type appears anywhere in it. `createReferenceTicketProtocol`
// is a deterministic, in-memory MODEL that satisfies that interface, used to
// prove the interface's semantics are coherent and to drive the matrix in
// idempotency-matrix.ts / idempotency-harness.ts before any real
// implementation exists — the same "criterion before implementation"
// discipline `grounding-retrieval-score-ordering` already uses for a
// retrieval engine that does not exist yet (see RELEASE.md, train 2).
//
// This is NOT db/**, NOT a server action, and NOT wired into
// app/actions/stella/grounded-query.ts. Nothing here is imported by runtime
// code. It exists so the 20-case matrix, the quota oracle and the 15 negative
// controls have a real, non-tautological evaluator to run against — and so
// that evaluator is ready to be pointed at a real adapter the day integration
// supplies one, per Fase 6.
//
// DETERMINISM. Every method that would otherwise read a wall clock takes an
// explicit `now: number` (a logical tick, not milliseconds since epoch) —
// same reasoning the harness-report / local-release-gate modules already
// state: a determinism gate cannot compare two runs if either one reads
// Date.now(). Ticket ids are minted by an injectable, monotonic counter for
// the same reason — never `randomUUID()` inside this file.

import { createHash } from 'node:crypto'

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The three axes a ticket is bound to. All three are required on every
 * operation — Fase 2 cases 5/6/7 (cross-organization/project/actor) exist
 * precisely because an implementation that silently drops one of these from
 * its comparison is representable and dangerous.
 */
export interface TicketScope {
  readonly organizationId: string
  readonly projectId: string
  readonly actorId: string
}

export function scopesEqual(a: TicketScope, b: TicketScope): boolean {
  return a.organizationId === b.organizationId && a.projectId === b.projectId && a.actorId === b.actorId
}

export type OperationTicketStatus = 'issued' | 'reserved' | 'completed' | 'aborted' | 'expired'

export interface OperationTicket {
  /** Server-minted, opaque. NEVER accepted as a caller-supplied argument by
   *  `issue` — there is no parameter for it anywhere in this interface. */
  readonly ticketId: string
  readonly scope: TicketScope
  /** Server-derived from `ticketId` alone. See deriveIdempotencyKey — never a
   *  function of the query text, a timestamp, or a caller-supplied value. */
  readonly idempotencyKey: string
  readonly status: OperationTicketStatus
  readonly issuedAt: number
  readonly expiresAt: number
  /** Set once, by `bind`. Null until the ticket is bound to one operation. */
  readonly queryFingerprint: string | null
  /** Present only once `complete`/`retry` has actually charged a unit. */
  readonly chargeId: string | null
}

export type OperationOutcomeKind = 'charged' | 'replayed' | 'quota_exceeded' | 'expired' | 'rejected'

export interface OperationOutcome {
  readonly kind: OperationOutcomeKind
  readonly ticketId: string
  readonly chargeId: string | null
  /** Present exactly when kind === 'rejected'. A stable code, never free text
   *  — the same discipline observability-contract.ts already requires of
   *  reasonCode/errorCode fields (short, not prose). */
  readonly reason: string | null
}

export class TicketProtocolError extends Error {
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}
export class TicketNotFoundError extends TicketProtocolError {
  constructor(ticketId: string) { super('TicketNotFoundError', `no ticket with id ${ticketId}`) }
}
export class TicketScopeViolationError extends TicketProtocolError {
  constructor(ticketId: string) { super('TicketScopeViolationError', `ticket ${ticketId} does not belong to the calling scope`) }
}
export class TicketAlreadyCompletedError extends TicketProtocolError {
  constructor(ticketId: string) { super('TicketAlreadyCompletedError', `ticket ${ticketId} is already completed and cannot be mutated`) }
}
export class TicketAbortedError extends TicketProtocolError {
  constructor(ticketId: string) { super('TicketAbortedError', `ticket ${ticketId} was aborted`) }
}
export class TicketExpiredError extends TicketProtocolError {
  constructor(ticketId: string) { super('TicketExpiredError', `ticket ${ticketId} has expired`) }
}
export class TicketNotReservedError extends TicketProtocolError {
  constructor(ticketId: string) { super('TicketNotReservedError', `ticket ${ticketId} was never bound to an operation`) }
}
export class TicketQueryMismatchError extends TicketProtocolError {
  constructor(ticketId: string) { super('TicketQueryMismatchError', `ticket ${ticketId} is bound to a different query`) }
}
/**
 * RELEASE line — Train 4.2 (STELLA_RELEASE_PROJECT_BOUND_TICKET_GATE_TRAIN_4_2).
 * Thrown by the `*ForExecution` verbs below when a caller asserts an
 * `executionProjectId` that differs from the ticket's OWN `scope.projectId`.
 * This is a DIFFERENT failure than `TicketScopeViolationError`: scope
 * violations are about who is PRESENTING the ticket (org/project/actor of the
 * caller); this is about which project the WORK actually executed against,
 * independent of who presented the ticket — the exact distinction R2-INT
 * names (docs/ops/contracts/CONTRACT_LEDGER.md#r2-int) as unenforced today,
 * because `bind_operation_ticket`/`complete_operation_ticket` have no
 * parameter through which to receive it at all.
 */
export class TicketExecutionProjectMismatchError extends TicketProtocolError {
  constructor(ticketId: string) {
    super('TicketExecutionProjectMismatchError', `ticket ${ticketId} is bound to a different project than the one this operation executed against`)
  }
}

/* -------------------------------------------------------------------------- */
/* The abstract protocol — Fase 1                                             */
/* -------------------------------------------------------------------------- */

/**
 * Seven verbs, matching Fase 1 exactly: issue; bind (reserve); complete;
 * abort; retry; expire; inspect outcome. No SQL name appears here — an
 * adapter over a Postgres table, a Redis hash, or this in-memory model can
 * all implement it.
 *
 * `retry` is deliberately the only verb that never throws: it models "the
 * same request came in again", and a caller that must catch a typed error to
 * find out whether its retry was safe has not been given a safe retry.
 * Every other verb throws a typed `TicketProtocolError` subtype instead of
 * returning a sentinel, because those are operations a trusted orchestrator
 * chooses to invoke and can be expected to branch on `instanceof`.
 */
export interface OperationTicketProtocol {
  /** Mint a fresh ticket scoped to (organization, project, actor). There is
   *  no parameter through which a caller can influence `ticketId` or
   *  `idempotencyKey` — see Fase 2 case 18 / Fase 7 client-cannot-select-idempotency. */
  issue(scope: TicketScope, now: number): OperationTicket
  /** Bind (reserve) an issued ticket to exactly one operation. Re-binding
   *  with the SAME fingerprint is a no-op (safe to call twice while composing
   *  a retry); re-binding with a DIFFERENT fingerprint is rejected — a ticket
   *  is not a blank cheque a caller can repoint at a new question. */
  bind(ticketId: string, scope: TicketScope, queryFingerprint: string, now: number): OperationTicket
  /** Attempt to charge a reserved ticket exactly once. Already-completed is
   *  NOT an error: it returns `{ kind: 'replayed' }` with the original
   *  chargeId, because the caller asked "may I proceed" and the honest answer
   *  is "you already did". */
  complete(ticketId: string, scope: TicketScope, now: number): OperationOutcome
  /** Explicit, irreversible release without charging. A completed ticket
   *  cannot be aborted — there is nothing left to release. */
  abort(ticketId: string, scope: TicketScope, now: number): OperationTicket
  /** Re-present a ticket. Safe to call any number of times, from any state.
   *  Never throws — every failure mode is a `rejected` outcome with a reason
   *  code. See the per-status behaviour documented on each implementation. */
  retry(ticketId: string, scope: TicketScope, queryFingerprint: string, now: number): OperationOutcome
  /** Transition a stale, un-completed ticket to `expired`, freeing its
   *  reservation. A COMPLETED ticket's charge record survives forever
   *  (needed so a very late replay still resolves to `replayed`, never
   *  `ticket_not_found`) — this call is a no-op on one. */
  expire(ticketId: string, now: number): OperationTicket
  /** Read-only. Never mutates state, never triggers expiry. */
  inspect(ticketId: string): OperationTicket | null
}

/* -------------------------------------------------------------------------- */
/* Quota ledger — the oracle's read surface (Fase 3)                          */
/* -------------------------------------------------------------------------- */

export interface ChargeRecord {
  readonly chargeId: string
  readonly ticketId: string
  readonly organizationId: string
  /**
   * Train 4.2 — the project this charge is ATTRIBUTED to. Under every verb
   * that predates Train 4.2 (`complete`, `retry`, `simulateConcurrentAttempts`)
   * this is always `ticket.scope.projectId`, because those verbs have no
   * other project to attribute to — the same structural limitation R2-INT
   * names in the real `complete_operation_ticket` signature. The
   * `*ForExecution` verbs are what let this value be PROVEN equal to an
   * independently-asserted execution project, rather than merely assumed.
   */
  readonly projectId: string
  readonly idempotencyKey: string
}

export interface QuotaLedgerSnapshot {
  readonly organizationId: string
  readonly quota: number
  readonly used: number
  readonly activeReservations: number
  readonly completedOperations: number
  readonly abortedOperations: number
}

/** The extra, non-abstract read surface the reference model exposes so the
 *  oracle can assert on ledger state without reaching into private fields.
 *  A real adapter over a database would satisfy this with real queries; nothing
 *  here is SQL. */
export interface QuotaLedgerInspectable {
  snapshotLedger(organizationId: string): QuotaLedgerSnapshot
  chargesFor(ticketId: string): readonly ChargeRecord[]
  /** ALL charge records ever written, across every ticket and organization —
   *  used by the oracle to prove a rejected/aborted/failed attempt produced
   *  literally zero rows, not merely zero rows "for this ticket". */
  allCharges(): readonly ChargeRecord[]
}

/**
 * A single synchronous window in which N attempts read ledger state before
 * any of them commit. Models what an implementation WITHOUT a serializing
 * lock does under concurrency (checked-then-acted, two callers both seeing
 * "one unit left"), and what one WITH a lock does (each attempt's read
 * happens only after the previous attempt's write) — see
 * `simulateConcurrentAttempts` on each reference variant. Real thread
 * concurrency cannot be produced in a synchronous evaluator; this is the
 * narrower, honest claim: "does the model serialize checked-then-acted
 * reads against writes", which is exactly the property
 * `pg_advisory_xact_lock` in stella_0013 exists to hold.
 */
export interface ConcurrencyAttempt {
  readonly ticketId: string
  readonly scope: TicketScope
}

export interface OperationTicketReferenceProtocol extends OperationTicketProtocol, QuotaLedgerInspectable {
  simulateConcurrentAttempts(attempts: readonly ConcurrencyAttempt[], now: number): OperationOutcome[]
  /**
   * TESTING-ONLY entry points — deliberately NOT part of the abstract
   * `OperationTicketProtocol`, which has no parameter anywhere for a
   * caller-supplied key or scope. These exist so the negative controls for
   * "client-provided idempotencyKey" / "client-provided scope" (Fase 4) have
   * something concrete to call: they model an adapter that has ALREADY made
   * the prohibited mistake of forwarding a request field into `issue`. Under
   * the healthy (no-`defect`) model both behave EXACTLY like `issue` and
   * silently ignore the extra argument — that refusal is itself the good-path
   * proof (see attemptClientSuppliedIdempotencyKey / attemptClientSuppliedScope
   * below). Only the two matching `defect` variants honour the extra value.
   */
  issueTrustingClientIdempotencyKey(scope: TicketScope, now: number, clientSuppliedKey: string): OperationTicket
  issueTrustingClientScope(sessionScope: TicketScope, now: number, requestedScope: TicketScope): OperationTicket

  /**
   * Train 4.2 (STELLA_RELEASE_PROJECT_BOUND_TICKET_GATE_TRAIN_4_2) — the
   * PROJECT-BOUND verbs. Additive siblings of bind/complete/abort/inspect/
   * retry: every one of the five verbs above remains exactly as Train 4.1
   * left it, because that is precisely what R2-INT reports as true of the
   * REAL `bind_operation_ticket`/`complete_operation_ticket` today — they
   * have no parameter for the project the work executes against, so they
   * cannot enforce it (see `nc-legacy-signature-bypasses-project-gate` in
   * project-binding-harness.ts, which proves this by calling them directly).
   *
   * Each `*ForExecution` verb takes one additional argument,
   * `executionProjectId` — the project the caller asserts the work is
   * ACTUALLY executing against, independent of the ticket's own
   * `scope.projectId`. The healthy model requires the two to be equal and
   * throws `TicketExecutionProjectMismatchError` otherwise, BEFORE any
   * charge, mutation, or read is allowed through to the corresponding
   * legacy verb. This is the abstract shape R2-INT's fix must have; nothing
   * here is SQL or a server-action signature.
   */
  bindForExecution(ticketId: string, scope: TicketScope, executionProjectId: string, queryFingerprint: string, now: number): OperationTicket
  completeForExecution(ticketId: string, scope: TicketScope, executionProjectId: string, now: number): OperationOutcome
  abortForExecution(ticketId: string, scope: TicketScope, executionProjectId: string, now: number): OperationTicket
  /** Never throws for query/retry-style callers the way `retry` doesn't —
   *  a mismatch resolves to `{kind:'rejected', reason:'execution_project_mismatch'}`. */
  retryForExecution(ticketId: string, scope: TicketScope, executionProjectId: string, queryFingerprint: string, now: number): OperationOutcome
  /** Read-only, like `inspect` — but THROWS on a foreign executionProjectId
   *  rather than silently returning ticket state to a caller asserting the
   *  wrong project, matching Fase 2 case 6's "inspect A desde B" requirement. */
  inspectForExecution(ticketId: string, executionProjectId: string): OperationTicket | null
}

/* -------------------------------------------------------------------------- */
/* Reference model — deterministic, in-memory, honestly labelled as a model   */
/* -------------------------------------------------------------------------- */

/** Server-derived, from the ticket identity alone — never the query text,
 *  never a timestamp, never a caller-supplied value. Mirrors the shape of
 *  stella_0013's own sha256 derivation (namespaced preimage, hex digest)
 *  without importing anything from db/**. */
export function deriveIdempotencyKey(ticketId: string): string {
  return createHash('sha256').update(`stella/ticket/v1\n${ticketId}`, 'utf8').digest('hex')
}

function deriveChargeId(ticketId: string, attempt: number): string {
  return createHash('sha256').update(`stella/charge/v1\n${ticketId}\n${attempt}`, 'utf8').digest('hex')
}

/**
 * Every named way a ticket-protocol implementation can fail the contract,
 * one per Fase 4 bullet (minus the 15th, which is a gate-level control — see
 * idempotency-release-gate.ts). Each defect changes EXACTLY the one behaviour
 * it names; everything else stays identical to the healthy model, so a
 * negative control that catches it is proven to be testing that property and
 * nothing else.
 */
export type TicketProtocolDefect =
  | 'idempotency-key-from-query-hash'
  | 'idempotency-key-from-timestamp-bucket'
  | 'ticket-missing-actor-scope'
  | 'ticket-missing-organization-scope'
  | 'ticket-missing-project-scope'
  | 'ticket-missing-expiry'
  | 'query-fingerprint-rewritable'
  | 'complete-not-idempotent'
  | 'abort-does-not-release'
  | 'reservation-never-recoverable'
  | 'concurrent-double-charge'
  | 'client-supplied-idempotency-key-honoured'
  | 'client-supplied-scope-honoured'
  // Train 4.2 — one per `*ForExecution` verb, each isolating exactly that
  // verb's execution-project check (Fase 4: "bind/complete/abort/inspect sin
  // expected project"), plus one storage-layer defect that misattributes a
  // charge EVEN THOUGH the check itself passed (Fase 4: "cargo correcto en
  // organización pero proyecto incorrecto") — a different failure mode than
  // "the check was skipped", proving the oracle inspects the STORED
  // attribution and not merely whether an exception was thrown.
  | 'bind-ignores-execution-project'
  | 'complete-ignores-execution-project'
  | 'abort-ignores-execution-project'
  | 'inspect-ignores-execution-project'
  | 'charge-attributed-to-wrong-project-same-org'

export interface ReferenceProtocolConfig {
  /** organizationId -> monthly quota. Missing entries mean "not provisioned"
   *  (every completion returns quota_exceeded), matching the SQL's `no_quota` state. */
  readonly quotas: Readonly<Record<string, number>>
  /** In the same unit as every `now` argument — ticks, not milliseconds. */
  readonly ticketTtl: number
  /** Absent = the healthy reference model. */
  readonly defect?: TicketProtocolDefect
}

function scopeKeyIgnoring(scope: TicketScope, defect: TicketProtocolDefect | undefined): string {
  const org = defect === 'ticket-missing-organization-scope' ? '*' : scope.organizationId
  const project = defect === 'ticket-missing-project-scope' ? '*' : scope.projectId
  const actor = defect === 'ticket-missing-actor-scope' ? '*' : scope.actorId
  return `${org}::${project}::${actor}`
}

/** Scope comparison used by bind/complete/retry/abort. Defective variants
 *  that drop one axis compare `'*'` on that axis against the ticket's OWN
 *  `'*'` — i.e. the axis stops being checked at all, exactly what "a ticket
 *  without an actor/organization/project" means operationally: the field is
 *  absent from the comparison, not merely absent from storage. */
function scopeMatches(defect: TicketProtocolDefect | undefined, issued: TicketScope, presented: TicketScope): boolean {
  return scopeKeyIgnoring(issued, defect) === scopeKeyIgnoring(presented, defect)
}

/**
 * Builds either the healthy reference implementation (no `defect`) or one
 * variant with exactly one named defect. This is the SAME evaluator both the
 * good-path matrix cases and the negative controls run against — a control
 * builds a defective protocol and re-runs an ordinary scenario through it,
 * per Fase 4's "cada control debe usar el mismo evaluador que el caso bueno".
 */
export function createReferenceTicketProtocol(config: ReferenceProtocolConfig): OperationTicketReferenceProtocol {
  const { quotas, ticketTtl, defect } = config
  const tickets = new Map<string, OperationTicket>()
  const chargesByKey = new Map<string, ChargeRecord>() // `${organizationId}::${idempotencyKey}` -> charge
  const chargeLog: ChargeRecord[] = []
  let ticketCounter = 0
  let attemptCounter = 0

  function nextTicketId(): string {
    ticketCounter += 1
    return `ticket-${ticketCounter}`
  }

  /** DERIVED from the charge log, never a separately-maintained counter — the
   *  same reasoning stella_0013 counts `stella_interactions` rows rather than
   *  keeping a running tally: a counter that two racing writers each set from
   *  their OWN stale read can silently overwrite instead of accumulate, which
   *  would hide exactly the oversell `simulateConcurrentAttempts` exists to
   *  reproduce. */
  function usedCount(organizationId: string): number {
    return chargeLog.filter((c) => c.organizationId === organizationId).length
  }

  function keyFor(ticket: OperationTicket): string {
    if (defect === 'idempotency-key-from-query-hash') {
      return deriveIdempotencyKey(`qhash:${ticket.queryFingerprint ?? ''}`)
    }
    if (defect === 'idempotency-key-from-timestamp-bucket') {
      const bucket = Math.floor(ticket.issuedAt / 10)
      return deriveIdempotencyKey(`tsbucket:${bucket}`)
    }
    return ticket.idempotencyKey
  }

  function isExpired(ticket: OperationTicket, now: number): boolean {
    if (defect === 'ticket-missing-expiry') return false
    return ticket.status !== 'completed' && now >= ticket.expiresAt
  }

  function requireTicket(ticketId: string): OperationTicket {
    const ticket = tickets.get(ticketId)
    if (!ticket) throw new TicketNotFoundError(ticketId)
    return ticket
  }

  function chargeOnce(ticket: OperationTicket): OperationOutcome {
    const orgQuota = quotas[ticket.scope.organizationId]
    const used = usedCount(ticket.scope.organizationId)

    const effectiveKey = keyFor(ticket)
    const chargeMapKey = `${ticket.scope.organizationId}::${effectiveKey}`
    const existingByKey = chargesByKey.get(chargeMapKey)

    // A defective key derivation makes two DIFFERENT tickets collide here —
    // this is precisely the "new question is free" failure INT-INT-001 names
    // as prohibited, reproduced honestly rather than special-cased away.
    if (existingByKey && defect !== 'complete-not-idempotent') {
      const replayedTicket: OperationTicket = { ...ticket, status: 'completed', chargeId: existingByKey.chargeId }
      tickets.set(ticket.ticketId, replayedTicket)
      return { kind: 'replayed', ticketId: ticket.ticketId, chargeId: existingByKey.chargeId, reason: null }
    }

    if (orgQuota === undefined || used >= orgQuota) {
      return { kind: 'quota_exceeded', ticketId: ticket.ticketId, chargeId: null, reason: 'quota_exceeded' }
    }

    attemptCounter += 1
    const chargeId = deriveChargeId(ticket.ticketId, attemptCounter)
    // Every verb that reaches chargeOnce — including the *ForExecution verbs,
    // which delegate here only AFTER their own execution-project check has
    // already passed — attributes the charge to the ticket's OWN project.
    // That is correct precisely because, by the time any verb gets here, an
    // executionProjectId (if one was asserted at all) has already been proven
    // equal to it. The one exception is the `charge-attributed-to-wrong-
    // project-same-org` defect: it deliberately drifts the STORED value away
    // from that already-verified project, to prove the oracle inspects the
    // charge's own projectId rather than merely trusting that the check ran.
    const projectId =
      defect === 'charge-attributed-to-wrong-project-same-org'
        ? `${ticket.scope.projectId}::drifted-sibling-project`
        : ticket.scope.projectId
    const record: ChargeRecord = { chargeId, ticketId: ticket.ticketId, organizationId: ticket.scope.organizationId, projectId, idempotencyKey: effectiveKey }
    chargesByKey.set(chargeMapKey, record)
    chargeLog.push(record)

    const completed: OperationTicket = { ...ticket, status: 'completed', chargeId }
    tickets.set(ticket.ticketId, completed)
    return { kind: 'charged', ticketId: ticket.ticketId, chargeId, reason: null }
  }

  const protocol: OperationTicketReferenceProtocol = {
    issue(scope, now) {
      const ticketId = nextTicketId()
      const ticket: OperationTicket = {
        ticketId,
        scope,
        idempotencyKey: deriveIdempotencyKey(ticketId),
        status: 'issued',
        issuedAt: now,
        expiresAt: now + ticketTtl,
        queryFingerprint: null,
        chargeId: null,
      }
      tickets.set(ticketId, ticket)
      return ticket
    },

    bind(ticketId, scope, queryFingerprint, now) {
      const ticket = requireTicket(ticketId)
      if (!scopeMatches(defect, ticket.scope, scope)) throw new TicketScopeViolationError(ticketId)
      if (ticket.status === 'completed') throw new TicketAlreadyCompletedError(ticketId)
      if (ticket.status === 'aborted') throw new TicketAbortedError(ticketId)
      if (isExpired(ticket, now)) {
        tickets.set(ticketId, { ...ticket, status: 'expired' })
        throw new TicketExpiredError(ticketId)
      }
      if (
        ticket.queryFingerprint !== null &&
        ticket.queryFingerprint !== queryFingerprint &&
        defect !== 'query-fingerprint-rewritable'
      ) {
        throw new TicketQueryMismatchError(ticketId)
      }
      const bound: OperationTicket = { ...ticket, status: 'reserved', queryFingerprint }
      tickets.set(ticketId, bound)
      return bound
    },

    complete(ticketId, scope, now) {
      const ticket = requireTicket(ticketId)
      if (!scopeMatches(defect, ticket.scope, scope)) throw new TicketScopeViolationError(ticketId)
      if (ticket.status === 'aborted') throw new TicketAbortedError(ticketId)
      if (isExpired(ticket, now)) {
        tickets.set(ticketId, { ...ticket, status: 'expired' })
        throw new TicketExpiredError(ticketId)
      }
      if (ticket.status === 'issued') throw new TicketNotReservedError(ticketId)
      if (ticket.status === 'completed' && defect !== 'complete-not-idempotent') {
        return { kind: 'replayed', ticketId, chargeId: ticket.chargeId, reason: null }
      }
      return chargeOnce(ticket)
    },

    abort(ticketId, scope, now) {
      const ticket = requireTicket(ticketId)
      if (!scopeMatches(defect, ticket.scope, scope)) throw new TicketScopeViolationError(ticketId)
      if (ticket.status === 'completed') throw new TicketAlreadyCompletedError(ticketId)
      if (ticket.status === 'aborted') return ticket
      if (isExpired(ticket, now)) {
        tickets.set(ticketId, { ...ticket, status: 'expired' })
        throw new TicketExpiredError(ticketId)
      }
      const aborted: OperationTicket = { ...ticket, status: defect === 'abort-does-not-release' ? ticket.status : 'aborted' }
      tickets.set(ticketId, aborted)
      return aborted
    },

    retry(ticketId, scope, queryFingerprint, now) {
      const ticket = tickets.get(ticketId)
      if (!ticket) return { kind: 'rejected', ticketId, chargeId: null, reason: 'ticket_not_found' }
      if (!scopeMatches(defect, ticket.scope, scope)) {
        return { kind: 'rejected', ticketId, chargeId: null, reason: 'scope_mismatch' }
      }
      if (ticket.status === 'aborted' && defect !== 'abort-does-not-release') {
        return { kind: 'rejected', ticketId, chargeId: null, reason: 'ticket_aborted' }
      }
      if (isExpired(ticket, now)) {
        tickets.set(ticketId, { ...ticket, status: 'expired' })
        return { kind: 'expired', ticketId, chargeId: null, reason: null }
      }
      if (ticket.status === 'issued') {
        return { kind: 'rejected', ticketId, chargeId: null, reason: 'ticket_not_reserved' }
      }
      if (
        ticket.queryFingerprint !== null &&
        ticket.queryFingerprint !== queryFingerprint &&
        defect !== 'query-fingerprint-rewritable'
      ) {
        return { kind: 'rejected', ticketId, chargeId: null, reason: 'query_mismatch' }
      }
      if (ticket.status === 'completed' && defect !== 'complete-not-idempotent') {
        return { kind: 'replayed', ticketId, chargeId: ticket.chargeId, reason: null }
      }
      return chargeOnce({ ...ticket, queryFingerprint })
    },

    expire(ticketId, now) {
      const ticket = requireTicket(ticketId)
      if (ticket.status === 'completed') return ticket // permanent — see the interface doc comment
      if (defect === 'reservation-never-recoverable') return ticket
      if (now < ticket.expiresAt) return ticket
      const expired: OperationTicket = { ...ticket, status: 'expired' }
      tickets.set(ticketId, expired)
      return expired
    },

    inspect(ticketId) {
      return tickets.get(ticketId) ?? null
    },

    snapshotLedger(organizationId) {
      const quota = quotas[organizationId] ?? 0
      const used = usedCount(organizationId)
      let activeReservations = 0
      let completedOperations = 0
      let abortedOperations = 0
      for (const ticket of tickets.values()) {
        if (ticket.scope.organizationId !== organizationId) continue
        if (ticket.status === 'reserved') activeReservations += 1
        if (ticket.status === 'completed') completedOperations += 1
        if (ticket.status === 'aborted') abortedOperations += 1
      }
      return { organizationId, quota, used, activeReservations, completedOperations, abortedOperations }
    },

    chargesFor(ticketId) {
      return chargeLog.filter((c) => c.ticketId === ticketId)
    },

    allCharges() {
      return [...chargeLog]
    },

    /**
     * See the ConcurrencyAttempt doc comment. The healthy model takes an
     * org-scoped "lock": attempts are drained ONE AT A TIME, each one's read
     * happening strictly after the previous one's write — the same ordering
     * `pg_advisory_xact_lock` gives stella_0013 (taken BEFORE the count, per
     * that file's own §6 comment). The `concurrent-double-charge` defect
     * removes the lock: every attempt's pre-state is read BEFORE any of them
     * write, reproducing a checked-then-acted race.
     */
    simulateConcurrentAttempts(attempts, now) {
      if (defect !== 'concurrent-double-charge') {
        return attempts.map((a) => protocol.complete(a.ticketId, a.scope, now))
      }
      const ticketsInFlight = attempts.map((a) => requireTicket(a.ticketId))
      // Every attempt reads quota state before any of them writes — this is
      // the race. All raw materials for `chargeOnce` are captured up front,
      // from the SAME `usedCount` the healthy path reads, just evaluated for
      // every attempt before any attempt's charge is appended to chargeLog.
      const outcomes = ticketsInFlight.map((ticket) => {
        const orgQuota = quotas[ticket.scope.organizationId]
        const usedAtReadTime = usedCount(ticket.scope.organizationId)
        return { ticket, orgQuota, usedAtReadTime }
      })
      return outcomes.map(({ ticket, orgQuota, usedAtReadTime }) => {
        if (orgQuota === undefined || usedAtReadTime >= orgQuota) {
          return { kind: 'quota_exceeded', ticketId: ticket.ticketId, chargeId: null, reason: 'quota_exceeded' } as OperationOutcome
        }
        attemptCounter += 1
        const chargeId = deriveChargeId(ticket.ticketId, attemptCounter)
        const record: ChargeRecord = {
          chargeId, ticketId: ticket.ticketId, organizationId: ticket.scope.organizationId, projectId: ticket.scope.projectId, idempotencyKey: keyFor(ticket),
        }
        chargeLog.push(record)
        chargesByKey.set(`${ticket.scope.organizationId}::${record.idempotencyKey}`, record)
        tickets.set(ticket.ticketId, { ...ticket, status: 'completed', chargeId })
        return { kind: 'charged', ticketId: ticket.ticketId, chargeId, reason: null } as OperationOutcome
      })
    },

    issueTrustingClientIdempotencyKey(scope, now, clientSuppliedKey) {
      const ticket = protocol.issue(scope, now)
      if (defect !== 'client-supplied-idempotency-key-honoured') return ticket
      const forged: OperationTicket = { ...ticket, idempotencyKey: clientSuppliedKey }
      tickets.set(ticket.ticketId, forged)
      return forged
    },

    issueTrustingClientScope(sessionScope, now, requestedScope) {
      if (defect !== 'client-supplied-scope-honoured') return protocol.issue(sessionScope, now)
      return protocol.issue(requestedScope, now)
    },

    /**
     * Train 4.2. Each `*ForExecution` verb below does exactly two things:
     * (1) require the ticket to exist, (2) check executionProjectId against
     * the ticket's OWN scope.projectId — UNLESS the matching `*-ignores-
     * execution-project` defect is set, in which case it skips straight to
     * (3) delegating to the pre-existing legacy verb, completely unchanged.
     * That delegation is deliberate: it is what proves these are additive
     * wrappers, not a rewrite — the legacy verb's own scope/expiry/status
     * logic still runs exactly as Train 4.1 left it.
     */
    bindForExecution(ticketId, scope, executionProjectId, queryFingerprint, now) {
      const ticket = requireTicket(ticketId)
      if (defect !== 'bind-ignores-execution-project' && executionProjectId !== ticket.scope.projectId) {
        throw new TicketExecutionProjectMismatchError(ticketId)
      }
      return protocol.bind(ticketId, scope, queryFingerprint, now)
    },

    completeForExecution(ticketId, scope, executionProjectId, now) {
      const ticket = requireTicket(ticketId)
      if (defect !== 'complete-ignores-execution-project' && executionProjectId !== ticket.scope.projectId) {
        throw new TicketExecutionProjectMismatchError(ticketId)
      }
      return protocol.complete(ticketId, scope, now)
    },

    abortForExecution(ticketId, scope, executionProjectId, now) {
      const ticket = requireTicket(ticketId)
      if (defect !== 'abort-ignores-execution-project' && executionProjectId !== ticket.scope.projectId) {
        throw new TicketExecutionProjectMismatchError(ticketId)
      }
      return protocol.abort(ticketId, scope, now)
    },

    retryForExecution(ticketId, scope, executionProjectId, queryFingerprint, now) {
      const ticket = tickets.get(ticketId)
      if (ticket && executionProjectId !== ticket.scope.projectId) {
        return { kind: 'rejected', ticketId, chargeId: null, reason: 'execution_project_mismatch' }
      }
      return protocol.retry(ticketId, scope, queryFingerprint, now)
    },

    inspectForExecution(ticketId, executionProjectId) {
      const ticket = tickets.get(ticketId)
      if (!ticket) return null
      if (defect !== 'inspect-ignores-execution-project' && executionProjectId !== ticket.scope.projectId) {
        throw new TicketExecutionProjectMismatchError(ticketId)
      }
      return ticket
    },
  }

  return protocol
}

/* -------------------------------------------------------------------------- */
/* Client-forgery probes (Fase 2 cases 17/18) — the healthy model refuses     */
/* -------------------------------------------------------------------------- */

/**
 * Models "what if a caller could hand `issue` its own idempotency key",
 * via `issueTrustingClientIdempotencyKey` — see that method's doc comment.
 * Under the healthy model this ALWAYS reports `keyWasHonoured: false`: the
 * server-derived key wins regardless of what the caller offered. Only the
 * `client-supplied-idempotency-key-honoured` defect variant reports true.
 */
export function attemptClientSuppliedIdempotencyKey(
  protocol: OperationTicketReferenceProtocol,
  scope: TicketScope,
  now: number,
  clientSuppliedKey: string,
): { ticket: OperationTicket; keyWasHonoured: boolean } {
  const ticket = protocol.issueTrustingClientIdempotencyKey(scope, now, clientSuppliedKey)
  return { ticket, keyWasHonoured: ticket.idempotencyKey === clientSuppliedKey }
}

/**
 * Models "what if a caller could hand `issue` its own scope instead of the
 * one the server derived from the authenticated session", via
 * `issueTrustingClientScope`. `sessionScope` is what
 * `requireOrganizationAccess()` would have produced (per
 * app/actions/stella/grounded-query.ts step 3); `requestedScope` is whatever
 * the payload claims. Under the healthy model this ALWAYS reports
 * `scopeWasForged: false` — the ticket that comes back is scoped to the
 * SESSION regardless of what the request claimed.
 */
export function attemptClientSuppliedScope(
  protocol: OperationTicketReferenceProtocol,
  sessionScope: TicketScope,
  requestedScope: TicketScope,
  now: number,
): { ticket: OperationTicket; scopeWasForged: boolean } {
  const ticket = protocol.issueTrustingClientScope(sessionScope, now, requestedScope)
  return { ticket, scopeWasForged: scopesEqual(ticket.scope, requestedScope) && !scopesEqual(sessionScope, requestedScope) }
}
