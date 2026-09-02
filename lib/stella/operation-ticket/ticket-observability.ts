// lib/stella/operation-ticket/ticket-observability.ts
// INTEGRATION — Train 4.1, FASE 9. The RUNTIME emitter for the ten
// operation-ticket lifecycle events.
//
// ---------------------------------------------------------------------------
// WHY A NEW MODULE AND NOT `reportStellaFailure`
// ---------------------------------------------------------------------------
// `lib/stella/observability.ts` reports FAILURES: it takes an `unknown` error,
// sanitizes it and captures an exception. Eight of the ten events here are not
// failures — a ticket being issued, bound, reserved or completed is the happy
// path — and routing them through an exception reporter would file normal
// operation as Sentry issues. The privacy contract is the same one, restated
// below as an allowlist rather than inherited by proximity.
//
// ---------------------------------------------------------------------------
// THE ALLOWLIST IS RESTATED HERE, AND PROVEN NOT TO DRIFT
// ---------------------------------------------------------------------------
// The authoritative contract lives in
// `tests/eval/stella-release/observability-contract.ts` (RELEASE owns it).
// Production code cannot import from `tests/**`, so the field lists below are
// stated again — and `tests/stella-ticket-observability-cross.test.ts` feeds
// REAL emissions from this module into RELEASE's `validateObservabilityEvent`
// and asserts every one validates clean, plus that the two name sets are
// equal. The duplication is checked by machine, not by discipline: adding a
// field here without adding it there fails a test.
//
// ---------------------------------------------------------------------------
// WHAT MAY NEVER APPEAR — AND WHY THE QUERY HASH IS ON THAT LIST
// ---------------------------------------------------------------------------
// No query text, no prompt, no evidence, no excerpt, no answer, no secret, no
// auth token, no charge nonce.
//
// The QUERY HASH is excluded too, and that deserves a sentence because it is
// not obviously sensitive. It is a digest, so it does not reveal the question
// directly — but it is a STABLE digest of a short, low-entropy, human-authored
// string, which makes it dictionary-attackable by anyone holding the (public,
// documented) canonicalization rules. Emitting it would put a searchable
// fingerprint of every reviewer's question into the log stream. `ticketId`
// already correlates a lifecycle end to end and has no such preimage, so
// nothing is lost by leaving the digest out.
//
// ---------------------------------------------------------------------------
// TELEMETRY MUST NOT MOVE THE QUOTA
// ---------------------------------------------------------------------------
// `emitTicketEvent` cannot throw. A logging failure that propagated would, at
// the wrong moment, turn a completed-and-charged operation into an error the
// caller reads as "it failed" — and the caller would then abort or retry a
// ticket the ledger has already charged. So the emit is wrapped, and failures
// are COUNTED in a process-local scalar rather than swallowed silently: FASE 9
// requires the failure be visible without being able to change state.

import * as Sentry from '@sentry/nextjs'

/**
 * The ten events, byte-identical to the names RELEASE added to
 * `STELLA_OBSERVABILITY_EVENT_NAMES` in Train 4.1.
 */
export const TICKET_LIFECYCLE_EVENT_NAMES = [
  'operation_ticket_issued',
  'operation_ticket_bound',
  'operation_ticket_expired',
  'grounded_query_reserved',
  'grounded_query_completed',
  'grounded_query_aborted',
  'grounded_query_retried',
  'quota_consumed',
  'quota_reuse_detected',
  'replay_rejected',
  // ---------------------------------------------------------------------
  // TRAIN 4.3 — the six reservation events (FASE 12).
  // ---------------------------------------------------------------------
  // RELEASE added these names to `STELLA_OBSERVABILITY_EVENT_NAMES` in the same
  // train; `tests/stella-ticket-observability-cross.test.ts` proves the two sets
  // are EQUAL, so a name added on one side and not the other fails a test rather
  // than producing an event nobody validates.
  //
  // WHY THEY ARE NOT JUST THE `grounded_query_*` FOUR RENAMED. Those four are
  // scoped to one capability by their names, and Train 4.3's whole subject is
  // that SIX capabilities share one pool. An operator asking "what is holding
  // this organization's headroom right now?" needs events that do not have to be
  // enumerated per capability first. The grounded four are KEPT — removing them
  // would break every dashboard and every assertion built on Train 4.1 — and the
  // grounded path emits both, which is a duplication in the log stream and not
  // in the ledger.
  'quota_reservation_created',
  'quota_reservation_released',
  'quota_reservation_expired',
  'quota_reservation_converted',
  'quota_capacity_rejected',
  'quota_cross_operation_contention',
] as const

export type TicketLifecycleEventName = (typeof TICKET_LIFECYCLE_EVENT_NAMES)[number]

/** Mirrors RELEASE's `COMMON_ALLOWED_FIELDS`. */
const COMMON_FIELDS = ['eventName', 'timestamp', 'organizationId', 'projectId', 'interactionId', 'requestId'] as const

/**
 * Per-event allowlist, mirroring `EVENT_SPECIFIC_ALLOWED_FIELDS`. Every value
 * is an opaque server-minted identifier, a small integer, or a stable code
 * from a closed vocabulary — never a sentence and never free text.
 */
export const TICKET_EVENT_ALLOWED_FIELDS: Record<TicketLifecycleEventName, readonly string[]> = {
  operation_ticket_issued: ['ticketId'],
  operation_ticket_bound: ['ticketId'],
  operation_ticket_expired: ['ticketId'],
  grounded_query_reserved: ['ticketId'],
  grounded_query_completed: ['ticketId', 'chargeId'],
  grounded_query_aborted: ['ticketId'],
  grounded_query_retried: ['ticketId', 'attempt'],
  quota_consumed: ['ticketId', 'chargeId'],
  quota_reuse_detected: ['ticketId', 'chargeId'],
  replay_rejected: ['ticketId', 'reasonCode'],
  // TRAIN 4.3. `reservationId` IS the ticket id — the reservation is a state of
  // the ticket row, not a second object with an identity of its own — and it is
  // carried under RELEASE's field name rather than under `ticketId` so the two
  // sides validate byte-identically.
  //
  // NO `category` FIELD ANYWHERE BELOW, and that is a deliberate refusal rather
  // than an oversight. Which capability an organization is spending its quota on
  // is a usage profile, and the events already carry `organizationId` and
  // `projectId` — putting the capability next to them would make the log stream
  // a per-tenant behavioural record. `ticketId` correlates a lifecycle end to
  // end, and the ledger (which is access-controlled) is where capability
  // attribution belongs.
  quota_reservation_created: ['reservationId'],
  quota_reservation_released: ['reservationId'],
  quota_reservation_expired: ['reservationId'],
  quota_reservation_converted: ['reservationId', 'chargeId'],
  // No `reservationId`: a rejection happens when NO reservation was minted.
  // Reporting one would be reporting an object that does not exist.
  quota_capacity_rejected: ['reasonCode'],
  quota_cross_operation_contention: ['reservationId', 'reasonCode'],
}

/** RELEASE's `MAX_EVENT_FIELD_VALUE_LENGTH`, restated; the cross test proves equality. */
const MAX_FIELD_VALUE_LENGTH = 200

/** Scalars only — the type makes an object or an array unrepresentable. */
export type TicketEventFields = Record<string, string | number | boolean>

/**
 * The scope every event carries.
 *
 * `requestId` is a TELEMETRY CORRELATION ID and nothing else. It is minted
 * once per server-action invocation so the events of one invocation can be
 * read together in a log. It is deliberately NOT the operation's identity:
 * it is never sent to the database, never reaches `consume_stella_quota`,
 * and a retry carries a NEW one while reusing the SAME `ticketId` — which is
 * exactly the distinction the ticket exists to draw. Reading correlation as
 * identity is the failure mode INT-INT-001 §1 names ("un valor que elige el
 * cliente no es una identidad"); the inverse mistake, treating a fresh
 * correlation id as a fresh operation, would re-charge every retry.
 */
export interface TicketEventScope {
  readonly organizationId: string
  readonly projectId: string
  readonly requestId: string
}

let telemetryFailures = 0

/**
 * Process-local count of telemetry emissions that dropped a field or failed to
 * write. FASE 9: "un fallo de telemetría no puede cambiar el estado de cuota,
 * pero debe ser visible". Read by the E2E so "observability ran and did not
 * silently no-op" is a measured fact rather than an assumption.
 */
export function ticketTelemetryFailureCount(): number {
  return telemetryFailures
}

/** Test/E2E seam only — never called by the runtime path. */
export function resetTicketTelemetryFailureCount(): void {
  telemetryFailures = 0
}

/**
 * Build the payload, dropping any field not on the event's allowlist.
 *
 * FAIL CLOSED, and closed means DROPPED rather than THROWN: a caller that
 * accidentally passes an extra key must not be able to abort a charged
 * operation by doing so. Each drop is counted, so the mistake stays visible.
 */
export function ticketEventPayload(
  name: TicketLifecycleEventName,
  scope: TicketEventScope,
  fields: TicketEventFields,
  timestamp: string,
): Record<string, unknown> {
  const allowed = new Set<string>([...COMMON_FIELDS, ...TICKET_EVENT_ALLOWED_FIELDS[name]])
  const payload: Record<string, unknown> = {
    eventName: name,
    timestamp,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    requestId: scope.requestId,
  }

  for (const key of Object.keys(fields)) {
    const value = fields[key]!
    if (!allowed.has(key)) {
      telemetryFailures += 1
      continue
    }
    if (typeof value === 'string' && value.length > MAX_FIELD_VALUE_LENGTH) {
      telemetryFailures += 1
      continue
    }
    payload[key] = value
  }
  return payload
}

/**
 * Emit one lifecycle event.
 *
 * NEVER THROWS. Both sinks are best-effort and a failure in either increments
 * the counter instead of propagating. See the header for why propagation would
 * be a correctness bug rather than a nuisance.
 */
export function emitTicketEvent(
  name: TicketLifecycleEventName,
  scope: TicketEventScope,
  fields: TicketEventFields = {},
): void {
  let payload: Record<string, unknown>
  try {
    payload = ticketEventPayload(name, scope, fields, new Date().toISOString())
  } catch {
    telemetryFailures += 1
    return
  }

  try {
    Sentry.addBreadcrumb({
      category: 'stella.operation_ticket',
      type: 'info',
      level: 'info',
      message: name,
      data: payload,
    })
  } catch {
    telemetryFailures += 1
  }

  try {
    // `console.log`, not `console.error`: eight of these ten are the happy
    // path, and filing normal operation at error level is how an error log
    // stops being read.
    console.log('[stella-ticket]', payload)
  } catch {
    telemetryFailures += 1
  }
}
