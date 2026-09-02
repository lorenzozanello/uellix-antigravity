// tests/eval/stella-release/reserved-quota-protocol.ts
// RELEASE line — Train 4.3 (STELLA_RELEASE_RESERVED_QUOTA_GATE_TRAIN_4_3).
//
// R1 (docs/ops/contracts/CONTRACT_LEDGER.md, "Riesgos residuales abiertos tras
// el cierre" of INT-INT-001): "Acción hermana cobra el ledger entre `bind` y
// `complete`" — MAJOR, declared and NOT patched; billing decision pending for
// tren 5. R6-INT (same table): "El sobreconsumo de cuota entre acciones
// Stella hermanas sigue siendo posible: las otras cinco escriben
// `stella_interactions` con `db.insert` sin lock tras una lectura sin lock" —
// is what makes R1 reachable in production. `db/prepared/stella_0013_grounded_query_quota.sql`
// §6 confirms the shape: ONE monthly pool per organization
// (`organizations.stella_monthly_quota`), shared by seven governed
// categories (`v_governed`) — six read-then-insert directly
// (advisor/validator/composer/proxy_reviewer/evidence_reviewer/audit_assistant,
// via `checkStellaQuota` in lib/stella/quota.ts, no lock) and one
// (`grounded_query`) goes through `consume_stella_quota`'s single
// per-organization `pg_advisory_xact_lock` — a lock that serialises
// `grounded_query` against itself, never against the other six.
//
// This module builds the independent evaluator Train 4.3 was asked for: an
// ABSTRACT model — neutral of SQL names, neutral of `consume_stella_quota`,
// neutral of `operation_tickets` — that represents BOTH kinds of caller
// sharing one capacity pool, and lets the oracle in reserved-quota-oracle.ts
// check `Consumed + LiveReserved <= Limit` at EVERY transition, not merely on
// the final state.
//
// WHY A SEPARATE MODEL FROM ticket-protocol.ts, RATHER THAN REUSING bind/complete
// ticket-protocol.ts's `bind` deliberately does NOT check capacity — Train 4.1
// established that as correct FOR THAT MODEL, because `complete`/`chargeOnce`
// is the only place capacity is enforced there, and every case in
// idempotency-matrix.ts (2 through 20) was proven true of exactly that
// behaviour. Fase 2/3 of THIS train requires the opposite property for a
// reservation observed from a SHARED-capacity point of view: "grounded
// reserva última unidad" then "sibling intenta consumir y se rechaza" (cases
// 1-2 below) can only hold if a LIVE reservation already occupies capacity
// before it completes. Silently changing what ticket-protocol.ts's `bind`
// means would invalidate every case idempotency-harness.ts and
// project-binding-harness.ts already proved true of it — so this file is its
// OWN, independent, deterministic in-memory model instead. Same "shape
// mirrors deliberately rather than importing" discipline
// project-binding-harness.ts's own header already states, for the same
// reason: the two harnesses must be able to diverge without either one
// silently breaking the other.
//
// DETERMINISM. Same discipline as ticket-protocol.ts: every method that would
// otherwise read a wall clock takes an explicit `now: number` (a logical
// tick, never Date.now()). Ids are minted by an injectable, monotonic
// counter — never randomUUID().
//
// THIS IS NOT db/**, NOT a server action, and NOT wired into
// app/actions/stella/grounded-query.ts or any sibling action. Nothing here is
// imported by runtime code.

import { createHash } from 'node:crypto'

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/** The three axes a reservation is bound to — same shape as
 *  ticket-protocol.ts's TicketScope, kept as an independent type rather than
 *  imported so the two models can diverge (see header). */
export interface CapacityScope {
  readonly organizationId: string
  readonly projectId: string
  readonly actorId: string
}

export function capacityScopesEqual(a: CapacityScope, b: CapacityScope): boolean {
  return a.organizationId === b.organizationId && a.projectId === b.projectId && a.actorId === b.actorId
}

/**
 * The six sibling categories db/prepared/stella_0013_grounded_query_quota.sql
 * §6's `v_governed` array names ALONGSIDE `grounded_query` — read from that
 * file, not re-derived. `grounded_query` itself is excluded here: it is
 * reached only through the reservation half of this protocol
 * (`reserveGroundedOperation`/`completeGroundedReservation`), never through
 * `consumeSiblingOperation`.
 */
export const SIBLING_CATEGORIES = [
  'advisor',
  'validator',
  'composer',
  'proxy_reviewer',
  'evidence_reviewer',
  'audit_assistant',
] as const
export type SiblingCategory = (typeof SIBLING_CATEGORIES)[number]

export type CapacityChargeOrigin = 'grounded' | SiblingCategory

export type GroundedReservationStatus = 'reserved' | 'completed' | 'aborted' | 'expired'

export interface GroundedReservation {
  readonly reservationId: string
  readonly scope: CapacityScope
  readonly status: GroundedReservationStatus
  readonly reservedAt: number
  readonly expiresAt: number
  readonly chargeId: string | null
}

export interface CapacityChargeRecord {
  readonly chargeId: string
  readonly organizationId: string
  readonly projectId: string
  readonly origin: CapacityChargeOrigin
  /** Null for a sibling charge — only a grounded charge is ever attributable
   *  to a reservation. */
  readonly reservationId: string | null
  readonly periodKey: string
}

export interface CapacitySnapshot {
  readonly organizationId: string
  readonly periodKey: string
  readonly limit: number
  readonly consumed: number
  readonly liveReserved: number
  /** May be negative transiently ONLY under a deliberately-defective
   *  configuration — the oracle's job is to prove the healthy model never
   *  lets that happen. */
  readonly available: number
}

/* -------------------------------------------------------------------------- */
/* Errors — structural failures throw; business outcomes are returned         */
/* -------------------------------------------------------------------------- */

export class ReservedQuotaProtocolError extends Error {
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}
export class ReservationNotFoundError extends ReservedQuotaProtocolError {
  constructor(reservationId: string) {
    super('ReservationNotFoundError', `no reservation with id ${reservationId}`)
  }
}
export class ReservationScopeViolationError extends ReservedQuotaProtocolError {
  constructor(reservationId: string) {
    super('ReservationScopeViolationError', `reservation ${reservationId} does not belong to the calling scope`)
  }
}
export class ReservationAlreadyCompletedError extends ReservedQuotaProtocolError {
  constructor(reservationId: string) {
    super('ReservationAlreadyCompletedError', `reservation ${reservationId} is already completed and cannot be mutated`)
  }
}
export class ReservationAbortedError extends ReservedQuotaProtocolError {
  constructor(reservationId: string) {
    super('ReservationAbortedError', `reservation ${reservationId} was aborted`)
  }
}
export class ReservationExpiredError extends ReservedQuotaProtocolError {
  constructor(reservationId: string) {
    super('ReservationExpiredError', `reservation ${reservationId} has expired`)
  }
}

/* -------------------------------------------------------------------------- */
/* Outcomes — the shared vocabulary Fase 3 requires distinguishable           */
/* -------------------------------------------------------------------------- */

export type ReservationAttemptKind = 'reservation_held' | 'quota_exceeded'

export interface ReservationAttemptOutcome {
  readonly kind: ReservationAttemptKind
  readonly reservation: GroundedReservation | null
  readonly reason: string | null
}

export type SiblingConsumptionKind = 'consumed' | 'quota_exceeded'

export interface SiblingConsumptionOutcome {
  readonly kind: SiblingConsumptionKind
  readonly category: SiblingCategory
  readonly chargeId: string | null
  readonly reason: string | null
}

/**
 * `quota_refused` is R1's OWN vocabulary, restated as data: the reservation
 * was live and legitimately held, but by the time `completeGroundedReservation`
 * ran, a sibling had already spent the capacity it was holding. R1's policy —
 * "la respuesta calculada se descarta, el ticket se aborta con quota_refused,
 * y se devuelve QUOTA_EXCEEDED" — is the discard/never-oversell contract this
 * outcome exists to make checkable. See reserved-quota-oracle.ts and case 7
 * ("grounded complete vs sibling concurrente") for how it is proven reachable
 * WITHOUT ever letting the ledger actually oversell.
 */
export type GroundedCompletionKind = 'charged' | 'replayed' | 'quota_refused' | 'rejected'

export interface GroundedCompletionOutcome {
  readonly kind: GroundedCompletionKind
  readonly reservationId: string
  readonly chargeId: string | null
  readonly reason: string | null
  /** True exactly when kind === 'quota_refused' — see the type doc above. */
  readonly discardedComputedResponse: boolean
}

/* -------------------------------------------------------------------------- */
/* The abstract protocol — Fase 2                                             */
/* -------------------------------------------------------------------------- */

/**
 * Seven verbs, matching Fase 2 exactly: reserve grounded operation; consume
 * sibling operation; complete grounded reservation; abort reservation; expire
 * reservation; retry; inspect capacity. No SQL name appears here — an adapter
 * over `operation_tickets` + `stella_interactions`, or this in-memory model,
 * can both implement it.
 */
export interface ReservedQuotaProtocol {
  /** Reserve capacity for a grounded operation. Fails CLOSED — `quota_exceeded`
   *  with no reservation minted — when `Consumed + LiveReserved >= Limit`
   *  already; a reservation that is granted therefore always represents one
   *  real, currently-uncontended unit of capacity. */
  reserveGroundedOperation(scope: CapacityScope, now: number): ReservationAttemptOutcome
  /** The DIRECT, unreserved consumption path the six sibling categories take
   *  today (checkStellaQuota then db.insert, per R6-INT — no reservation
   *  phase exists for them, and none is added here: adding one would no
   *  longer be evaluating what R6-INT actually reports). */
  consumeSiblingOperation(scope: CapacityScope, category: SiblingCategory, now: number): SiblingConsumptionOutcome
  /** Convert a reservation into a charge. Re-derives availability from the
   *  TRUE combined ledger (never merely trusts that the reservation still
   *  holds) — see reserveGroundedOperation's own doc and R1's policy. */
  completeGroundedReservation(reservationId: string, scope: CapacityScope, now: number): GroundedCompletionOutcome
  /** Explicit, irreversible release without charging. A completed reservation
   *  cannot be aborted — there is nothing left to release. */
  abortReservation(reservationId: string, scope: CapacityScope, now: number): GroundedReservation
  /** Transition a stale, un-completed reservation to `expired`, freeing its
   *  hold on capacity. A COMPLETED reservation's charge record survives
   *  forever (a very late replay must still resolve to `replayed`, never
   *  `not found`) — this call is a no-op on one. */
  expireReservation(reservationId: string, now: number): GroundedReservation
  /** Re-present a reservation. Never throws — every failure mode is a
   *  `rejected` outcome with a reason code, same discipline as
   *  ticket-protocol.ts's own `retry`. On an already-completed reservation
   *  this MUST replay (case 10: "retry grounded no reserva ni cobra de
   *  nuevo") — never mint a new reservation, never charge again. */
  retry(reservationId: string, scope: CapacityScope, now: number): GroundedCompletionOutcome
  /** Read-only. `Consumed + LiveReserved <= Limit` must hold on every
   *  snapshot this returns — the oracle's core assertion. */
  inspectCapacity(organizationId: string, now: number): CapacitySnapshot
}

/* -------------------------------------------------------------------------- */
/* Reference model's extra read surface, for the oracle                       */
/* -------------------------------------------------------------------------- */

export interface ReservedQuotaInspectable {
  snapshotCapacity(organizationId: string, now: number): CapacitySnapshot
  chargesFor(reservationId: string): readonly CapacityChargeRecord[]
  /** ALL charge records ever written, across every reservation, sibling
   *  category and organization — used by the oracle to prove a
   *  rejected/aborted/failed attempt produced literally zero rows, never
   *  merely zero rows "for this reservation". */
  allCharges(): readonly CapacityChargeRecord[]
  allReservations(): readonly GroundedReservation[]
}

/**
 * One synchronous window in which N attempts read capacity state before any
 * of them commit — same "checked-then-acted race" simulation technique
 * ticket-protocol.ts's own `ConcurrencyAttempt` documents, applied here across
 * a MIX of grounded and sibling attempts (never just one kind), because R1's
 * whole premise is a race BETWEEN the two kinds of caller, not within one.
 */
export type ConcurrentCapacityAttempt =
  | { readonly kind: 'grounded-complete'; readonly reservationId: string; readonly scope: CapacityScope }
  | { readonly kind: 'grounded-reserve'; readonly scope: CapacityScope }
  | { readonly kind: 'sibling-consume'; readonly scope: CapacityScope; readonly category: SiblingCategory }

export type ConcurrentCapacityResult =
  | ({ readonly attemptKind: 'grounded-complete' } & GroundedCompletionOutcome)
  | ({ readonly attemptKind: 'grounded-reserve' } & ReservationAttemptOutcome)
  | ({ readonly attemptKind: 'sibling-consume' } & SiblingConsumptionOutcome)

export interface ReservedQuotaReferenceProtocol extends ReservedQuotaProtocol, ReservedQuotaInspectable {
  simulateConcurrentCapacityAttempts(attempts: readonly ConcurrentCapacityAttempt[], now: number): ConcurrentCapacityResult[]
}

/* -------------------------------------------------------------------------- */
/* Defects — Fase 5, one per named mutation, each changing EXACTLY one thing  */
/* -------------------------------------------------------------------------- */

/**
 * Every named way this protocol can fail the R1/R6-INT contract, one per
 * Fase 5 bullet (minus "resultado utilizable sin cargo", which is a CALL-SITE
 * bug reproduced directly in reserved-quota-harness.ts against the healthy
 * protocol — see idempotency-harness.ts's own
 * evaluateReissuingOnEveryRetryDoubleCharges for the precedent — and minus
 * "local-runtime-ready ignora R1", which is a static, gate-level control that
 * lives in reserved-quota-release-gate.test.ts, the same place
 * project-binding-release-gate.test.ts's "control #9" lives). Each defect
 * changes EXACTLY the one behaviour it names; everything else stays identical
 * to the healthy model, so a negative control that catches it is proven to be
 * testing that property and nothing else.
 */
export type ReservedQuotaDefect =
  | 'sibling-ignores-reservations'
  | 'complete-recheck-loses-reservation'
  | 'complete-leaves-reservation-live'
  | 'abort-does-not-release'
  | 'expire-still-counts'
  | 'reservation-not-counted'
  | 'independent-locks'
  | 'concurrent-double-charge'
  | 'period-ignored'
  | 'category-partitioned-independently'
  | 'retry-reissues-reservation'

export interface ReservedQuotaConfig {
  /** organizationId -> monthly limit, shared across the grounded reservation
   *  path AND all six sibling categories — mirrors
   *  organizations.stella_monthly_quota, which db/prepared/stella_0013's §6
   *  reads as ONE column regardless of stella_role. Missing entries mean "not
   *  provisioned" (every attempt is quota_exceeded), matching the SQL's
   *  `no_quota` state. */
  readonly limits: Readonly<Record<string, number>>
  /** In the same unit as every `now` argument — ticks, not milliseconds. */
  readonly reservationTtl: number
  /** Ticks per accounting period (mirrors stella_0013 §6's UTC-month
   *  boundary, expressed as an abstract tick window rather than a calendar
   *  concept — Fase 3 case 12 crosses exactly one of these boundaries). */
  readonly periodLength: number
  /** Absent = the healthy reference model. */
  readonly defect?: ReservedQuotaDefect
}

function deriveChargeId(originTag: string, attempt: number): string {
  return createHash('sha256').update(`stella/reserved-quota/charge/v1\n${originTag}\n${attempt}`, 'utf8').digest('hex')
}

/**
 * Builds either the healthy reference implementation (no `defect`) or one
 * variant with exactly one named defect — same "the good-path matrix and the
 * negative controls run through the SAME evaluator" discipline
 * ticket-protocol.ts's own createReferenceTicketProtocol documents.
 */
export function createReferenceReservedQuotaProtocol(config: ReservedQuotaConfig): ReservedQuotaReferenceProtocol {
  const { limits, reservationTtl, periodLength, defect } = config
  const reservations = new Map<string, GroundedReservation>()
  const chargeLog: CapacityChargeRecord[] = []
  let reservationCounter = 0
  let chargeCounter = 0

  function nextReservationId(): string {
    reservationCounter += 1
    return `reservation-${reservationCounter}`
  }

  /** `period-ignored`: usage never resets across a period boundary — every
   *  tick maps to the SAME key, reproducing "cuota que nunca corta el mes". */
  function periodKeyFor(now: number): string {
    if (defect === 'period-ignored') return 'period-constant'
    return `p${Math.floor(now / periodLength)}`
  }

  function limitFor(organizationId: string): number {
    return limits[organizationId] ?? 0
  }

  /**
   * `category-partitioned-independently`: capacity is tracked per
   * (organization, origin) instead of per organization alone — giving EACH
   * sibling category, and grounded, its OWN independent limit. Contradicts
   * the single shared pool db/prepared/stella_0013_grounded_query_quota.sql
   * §6 actually enforces (`v_used` counts every row of `stella_interactions`
   * for the month, regardless of `stella_role`) — case 13 exists precisely to
   * pin that the real contract does NOT permit independent per-category
   * limits, and this defect is what a wrongly-partitioned implementation
   * would look like.
   */
  function chargesInScope(organizationId: string, now: number, origin: CapacityChargeOrigin | null): CapacityChargeRecord[] {
    const period = periodKeyFor(now)
    const inPeriod = chargeLog.filter((c) => c.organizationId === organizationId && c.periodKey === period)
    if (defect === 'category-partitioned-independently' && origin !== null) {
      return inPeriod.filter((c) => c.origin === origin)
    }
    if (defect === 'independent-locks' && origin !== null) {
      // Grounded's own ledger view never observes a sibling charge, and every
      // sibling's own ledger view never observes a grounded charge — TWO
      // separate serialisation domains instead of one, reproducing R6-INT's
      // actual topology (consume_stella_quota's advisory lock only ever
      // serialises grounded_query against itself).
      return origin === 'grounded' ? inPeriod.filter((c) => c.origin === 'grounded') : inPeriod.filter((c) => c.origin !== 'grounded')
    }
    return inPeriod
  }

  function liveReservationsInScope(organizationId: string, origin: CapacityChargeOrigin | null): GroundedReservation[] {
    if (defect === 'reservation-not-counted') return []
    const live = [...reservations.values()].filter((r) => r.scope.organizationId === organizationId && r.status === 'reserved')
    // Only `grounded` ever reserves — under EITHER defect below, a caller
    // asking from the SIBLING side never sees a grounded reservation, exactly
    // like it never sees a grounded CHARGE under the same two defects (see
    // chargesInScope above): the failure is "this axis is invisible from
    // here", stated once per property.
    if ((defect === 'category-partitioned-independently' || defect === 'independent-locks' || defect === 'sibling-ignores-reservations') && origin !== null && origin !== 'grounded') {
      return []
    }
    return live
  }

  /** The TRUE, undefected combined view — what the oracle (and R1's own
   *  "second line of defense" inside completeGroundedReservation) reads.
   *  Deliberately bypasses every per-origin filter above: a final gate that
   *  could itself be blinded by the same defect it exists to catch would not
   *  be a second line of defense at all. */
  function trueChargesInScope(organizationId: string, now: number): CapacityChargeRecord[] {
    const period = periodKeyFor(now)
    return chargeLog.filter((c) => c.organizationId === organizationId && c.periodKey === period)
  }
  function trueLiveReservations(organizationId: string): GroundedReservation[] {
    return [...reservations.values()].filter((r) => r.scope.organizationId === organizationId && r.status === 'reserved')
  }

  function requireReservation(reservationId: string): GroundedReservation {
    const reservation = reservations.get(reservationId)
    if (!reservation) throw new ReservationNotFoundError(reservationId)
    return reservation
  }

  function isExpired(reservation: GroundedReservation, now: number): boolean {
    return reservation.status !== 'completed' && now >= reservation.expiresAt
  }

  function snapshot(organizationId: string, now: number, perspective: CapacityChargeOrigin | null): CapacitySnapshot {
    const limit = limitFor(organizationId)
    const consumed = chargesInScope(organizationId, now, perspective).length
    const liveReserved = liveReservationsInScope(organizationId, perspective).length
    return { organizationId, periodKey: periodKeyFor(now), limit, consumed, liveReserved, available: limit - consumed - liveReserved }
  }

  const protocol: ReservedQuotaReferenceProtocol = {
    reserveGroundedOperation(scope, now) {
      const view = snapshot(scope.organizationId, now, 'grounded')
      if (view.available <= 0) {
        return { kind: 'quota_exceeded', reservation: null, reason: 'quota_exceeded' }
      }
      const reservationId = nextReservationId()
      const reservation: GroundedReservation = {
        reservationId,
        scope,
        status: 'reserved',
        reservedAt: now,
        expiresAt: now + reservationTtl,
        chargeId: null,
      }
      reservations.set(reservationId, reservation)
      return { kind: 'reservation_held', reservation, reason: null }
    },

    consumeSiblingOperation(scope, category, now) {
      const view = snapshot(scope.organizationId, now, category)
      if (view.available <= 0) {
        return { kind: 'quota_exceeded', category, chargeId: null, reason: 'quota_exceeded' }
      }
      chargeCounter += 1
      const chargeId = deriveChargeId(`sibling:${category}:${scope.organizationId}`, chargeCounter)
      chargeLog.push({
        chargeId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        origin: category,
        reservationId: null,
        periodKey: periodKeyFor(now),
      })
      return { kind: 'consumed', category, chargeId, reason: null }
    },

    completeGroundedReservation(reservationId, scope, now) {
      const reservation = requireReservation(reservationId)
      if (!capacityScopesEqual(reservation.scope, scope)) throw new ReservationScopeViolationError(reservationId)
      if (reservation.status === 'aborted') throw new ReservationAbortedError(reservationId)
      if (isExpired(reservation, now)) {
        reservations.set(reservationId, { ...reservation, status: 'expired' })
        throw new ReservationExpiredError(reservationId)
      }
      if (reservation.status === 'completed') {
        return { kind: 'replayed', reservationId, chargeId: reservation.chargeId, reason: null, discardedComputedResponse: false }
      }

      // R1's "second line of defense" — re-derive availability from the
      // combined ledger (TRUE view unless `independent-locks` has blinded
      // this side too — see trueChargesInScope's own doc), excluding every
      // OTHER live reservation and every charge already logged, then
      // confirming there is still room for THIS reservation's own unit.
      const consumed =
        defect === 'independent-locks' ? chargesInScope(scope.organizationId, now, 'grounded').length : trueChargesInScope(scope.organizationId, now).length
      const otherLiveReserved =
        (defect === 'independent-locks' ? liveReservationsInScope(scope.organizationId, 'grounded') : trueLiveReservations(scope.organizationId)).filter(
          (r) => r.reservationId !== reservationId,
        ).length
      const limit = limitFor(scope.organizationId)
      // `complete-recheck-loses-reservation`: an off-by-one that demands one
      // MORE unit of slack than the reservation actually needs, so a
      // perfectly valid, uncontended reservation is wrongly refused.
      const requiredSlack = defect === 'complete-recheck-loses-reservation' ? 1 : 0
      const roomForThisUnit = consumed + otherLiveReserved + requiredSlack < limit

      if (!roomForThisUnit) {
        reservations.set(reservationId, { ...reservation, status: 'aborted' })
        return { kind: 'quota_refused', reservationId, chargeId: null, reason: 'sibling_consumed_between_bind_and_complete', discardedComputedResponse: true }
      }

      chargeCounter += 1
      const chargeId = deriveChargeId(`grounded:${reservationId}`, chargeCounter)
      chargeLog.push({ chargeId, organizationId: scope.organizationId, projectId: scope.projectId, origin: 'grounded', reservationId, periodKey: periodKeyFor(now) })
      // `complete-leaves-reservation-live`: the charge lands, but the
      // reservation's OWN status is never flipped to 'completed' — so the
      // same unit counts as both a live reservation and a completed charge
      // simultaneously, which is exactly the property Fase 4's "no quedan
      // simultáneamente reserva y cargo" exists to catch.
      const nextStatus = defect === 'complete-leaves-reservation-live' ? 'reserved' : 'completed'
      reservations.set(reservationId, { ...reservation, status: nextStatus, chargeId })
      return { kind: 'charged', reservationId, chargeId, reason: null, discardedComputedResponse: false }
    },

    abortReservation(reservationId, scope, now) {
      const reservation = requireReservation(reservationId)
      if (!capacityScopesEqual(reservation.scope, scope)) throw new ReservationScopeViolationError(reservationId)
      if (reservation.status === 'completed') throw new ReservationAlreadyCompletedError(reservationId)
      if (reservation.status === 'aborted') return reservation
      if (isExpired(reservation, now)) {
        reservations.set(reservationId, { ...reservation, status: 'expired' })
        throw new ReservationExpiredError(reservationId)
      }
      const aborted: GroundedReservation = { ...reservation, status: defect === 'abort-does-not-release' ? reservation.status : 'aborted' }
      reservations.set(reservationId, aborted)
      return aborted
    },

    expireReservation(reservationId, now) {
      const reservation = requireReservation(reservationId)
      if (reservation.status === 'completed') return reservation // permanent — see the interface doc comment
      if (defect === 'expire-still-counts') return reservation
      if (now < reservation.expiresAt) return reservation
      const expired: GroundedReservation = { ...reservation, status: 'expired' }
      reservations.set(reservationId, expired)
      return expired
    },

    retry(reservationId, scope, now) {
      const reservation = reservations.get(reservationId)
      if (!reservation) return { kind: 'rejected', reservationId, chargeId: null, reason: 'reservation_not_found', discardedComputedResponse: false }
      if (!capacityScopesEqual(reservation.scope, scope)) {
        return { kind: 'rejected', reservationId, chargeId: null, reason: 'scope_mismatch', discardedComputedResponse: false }
      }
      if (reservation.status === 'aborted') {
        return { kind: 'rejected', reservationId, chargeId: null, reason: 'reservation_aborted', discardedComputedResponse: false }
      }
      if (isExpired(reservation, now)) {
        reservations.set(reservationId, { ...reservation, status: 'expired' })
        return { kind: 'rejected', reservationId, chargeId: null, reason: 'reservation_expired', discardedComputedResponse: false }
      }
      if (reservation.status === 'reserved') {
        return { kind: 'rejected', reservationId, chargeId: null, reason: 'not_yet_completed', discardedComputedResponse: false }
      }
      // status === 'completed' at this point — a replay.
      if (defect === 'retry-reissues-reservation') {
        // BUG, reproduced honestly: mints a BRAND NEW reservation and charges
        // it, instead of replaying the existing chargeId — case 10's "no
        // reserva ni cobra de nuevo" exists to catch exactly this.
        const fresh = protocol.reserveGroundedOperation(scope, now)
        if (fresh.kind !== 'reservation_held' || !fresh.reservation) {
          return { kind: 'rejected', reservationId, chargeId: null, reason: 'quota_exceeded', discardedComputedResponse: false }
        }
        return protocol.completeGroundedReservation(fresh.reservation.reservationId, scope, now)
      }
      return { kind: 'replayed', reservationId, chargeId: reservation.chargeId, reason: null, discardedComputedResponse: false }
    },

    inspectCapacity(organizationId, now) {
      return snapshot(organizationId, now, null)
    },

    snapshotCapacity(organizationId, now) {
      return snapshot(organizationId, now, null)
    },

    chargesFor(reservationId) {
      return chargeLog.filter((c) => c.reservationId === reservationId)
    },

    allCharges() {
      return [...chargeLog]
    },

    allReservations() {
      return [...reservations.values()]
    },

    /**
     * See ConcurrentCapacityAttempt's doc comment. The healthy model drains
     * attempts ONE AT A TIME — each one's read happening strictly after the
     * previous one's write, the same ordering `pg_advisory_xact_lock` would
     * give a SINGLE shared lock domain. The `concurrent-double-charge` defect
     * removes that: every attempt's pre-state is read BEFORE any of them
     * write, reproducing a checked-then-acted race across a MIX of grounded
     * and sibling attempts.
     */
    simulateConcurrentCapacityAttempts(attempts, now) {
      if (defect !== 'concurrent-double-charge') {
        return attempts.map((attempt): ConcurrentCapacityResult => {
          if (attempt.kind === 'grounded-complete') {
            return { attemptKind: 'grounded-complete', ...protocol.completeGroundedReservation(attempt.reservationId, attempt.scope, now) }
          }
          if (attempt.kind === 'grounded-reserve') {
            return { attemptKind: 'grounded-reserve', ...protocol.reserveGroundedOperation(attempt.scope, now) }
          }
          return { attemptKind: 'sibling-consume', ...protocol.consumeSiblingOperation(attempt.scope, attempt.category, now) }
        })
      }

      // Every attempt's availability is read BEFORE any attempt writes —
      // the race. Mirrors ticket-protocol.ts's own simulateConcurrentAttempts
      // under 'concurrent-double-charge'.
      const reads = attempts.map((attempt) => {
        const organizationId = attempt.scope.organizationId
        const perspective: CapacityChargeOrigin = attempt.kind === 'sibling-consume' ? attempt.category : 'grounded'
        return { attempt, view: snapshot(organizationId, now, perspective) }
      })

      return reads.map(({ attempt, view }): ConcurrentCapacityResult => {
        if (attempt.kind === 'grounded-reserve') {
          if (view.available <= 0) return { attemptKind: 'grounded-reserve', kind: 'quota_exceeded', reservation: null, reason: 'quota_exceeded' }
          const reservationId = nextReservationId()
          const reservation: GroundedReservation = {
            reservationId,
            scope: attempt.scope,
            status: 'reserved',
            reservedAt: now,
            expiresAt: now + reservationTtl,
            chargeId: null,
          }
          reservations.set(reservationId, reservation)
          return { attemptKind: 'grounded-reserve', kind: 'reservation_held', reservation, reason: null }
        }
        if (attempt.kind === 'sibling-consume') {
          if (view.available <= 0) {
            return { attemptKind: 'sibling-consume', kind: 'quota_exceeded', category: attempt.category, chargeId: null, reason: 'quota_exceeded' }
          }
          chargeCounter += 1
          const chargeId = deriveChargeId(`sibling:${attempt.category}:${attempt.scope.organizationId}`, chargeCounter)
          chargeLog.push({
            chargeId,
            organizationId: attempt.scope.organizationId,
            projectId: attempt.scope.projectId,
            origin: attempt.category,
            reservationId: null,
            periodKey: periodKeyFor(now),
          })
          return { attemptKind: 'sibling-consume', kind: 'consumed', category: attempt.category, chargeId, reason: null }
        }
        // grounded-complete
        const reservation = reservations.get(attempt.reservationId)
        if (!reservation) throw new ReservationNotFoundError(attempt.reservationId)
        if (view.available < 0) {
          reservations.set(attempt.reservationId, { ...reservation, status: 'aborted' })
          return {
            attemptKind: 'grounded-complete',
            kind: 'quota_refused',
            reservationId: attempt.reservationId,
            chargeId: null,
            reason: 'sibling_consumed_between_bind_and_complete',
            discardedComputedResponse: true,
          }
        }
        chargeCounter += 1
        const chargeId = deriveChargeId(`grounded:${attempt.reservationId}`, chargeCounter)
        chargeLog.push({
          chargeId,
          organizationId: attempt.scope.organizationId,
          projectId: attempt.scope.projectId,
          origin: 'grounded',
          reservationId: attempt.reservationId,
          periodKey: periodKeyFor(now),
        })
        reservations.set(attempt.reservationId, { ...reservation, status: 'completed', chargeId })
        return { attemptKind: 'grounded-complete', kind: 'charged', reservationId: attempt.reservationId, chargeId, reason: null, discardedComputedResponse: false }
      })
    },
  }

  return protocol
}
