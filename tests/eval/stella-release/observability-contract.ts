// tests/eval/stella-release/observability-contract.ts
// RELEASE line — minimal observability event contract
// (STELLA_RELEASE_RUNTIME_GATE_FOUNDATION_TRAIN_3, Fase 4).
//
// This is a CONTRACT, not an implementation: no event is ever emitted by this
// file, and nothing here wires into a real logger/exporter. RELEASE develops
// "observabilidad, logging, métricas" per its workstream grant
// (docs/ops/workstreams/RELEASE.md §Rutas autorizadas); until a real emitter
// exists, defining what a runtime event MAY carry — and, just as importantly,
// what it may NEVER carry — is the actionable unit of that grant, matching
// the same discipline the matrix uses for metrics that require gate G1: never
// fabricate the number, never fabricate the field.
//
// Two contracts live here:
//
// 1. EVENT PAYLOADS — one allowlist per event name. `validateObservabilityEvent`
//    fails closed on any field not on the list, any string value over the
//    length cap (prompts/evidence/full text are long; identifiers and codes
//    are not), and any string value matching the same secret-pattern detector
//    the release harness already uses for provider-error presentation
//    (hasForbiddenPattern, lib/stella/context/sanitize.ts) — reused rather
//    than reimplemented, so the two contracts cannot drift.
//
// 2. METRIC CATEGORIES — the 7 dimensions Fase 4 requires kept separate
//    (latency, token usage, cost, isolation, unsupported claims, abstention,
//    errors). The 3 that need a real provider round-trip are, exactly like
//    PROVIDER_DEPENDENT_METRICS in matrix.ts, always null with a structured
//    reason absent gate G1/G9 — never estimated, never collapsed into a
//    different category to avoid reporting null.

import { hasForbiddenPattern } from '@/lib/stella/context/sanitize'
import { STELLA_DECISION_VALUES, type StellaDecisionValue } from '@/app/actions/stella/decisions-schema'

/** No event payload field may hold a string longer than this. Prompts, full
 *  document text and evidence excerpts are all well over this length in
 *  practice; identifiers, codes and short labels are not. */
export const MAX_EVENT_FIELD_VALUE_LENGTH = 200

export const STELLA_OBSERVABILITY_EVENT_NAMES = [
  'ingestion.started',
  'ingestion.completed',
  'ingestion.failed',
  'retrieval.started',
  'retrieval.completed',
  'retrieval.abstained',
  'citations.validated',
  'citations.rejected',
  'response.produced',
  'human_decision.recorded',
  'retry.attempted',
  'quota.rejected',
  'permission.rejected',
  // ---------------------------------------------------------------------
  // Train 4.1 (STELLA_RELEASE_IDEMPOTENCY_GATE_TRAIN_4_1) — the operation-
  // ticket protocol's own lifecycle (tests/eval/stella-release/ticket-protocol.ts).
  // Additive only: the 13 events above are untouched, and every rule below
  // this point (allowlist, forbidden names, length cap, secret detector)
  // applies to these 10 exactly as it already applies to the first 13 — no
  // second contract, no relaxed path.
  // ---------------------------------------------------------------------
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
  // Train 4.3 (STELLA_RELEASE_RESERVED_QUOTA_GATE_TRAIN_4_3) — the shared
  // capacity contract between a grounded reservation and the six sibling
  // categories (tests/eval/stella-release/reserved-quota-protocol.ts).
  // Additive only: the 23 events above are untouched, and every rule below
  // this point (allowlist, forbidden names, length cap, secret detector)
  // applies to these 6 exactly as it already applies to the first 23 — no
  // second contract, no relaxed path.
  // ---------------------------------------------------------------------
  'quota_reservation_created',
  'quota_reservation_released',
  'quota_reservation_expired',
  'quota_reservation_converted',
  'quota_capacity_rejected',
  'quota_cross_operation_contention',
] as const

export type StellaObservabilityEventName = (typeof STELLA_OBSERVABILITY_EVENT_NAMES)[number]

/** Present on every event, regardless of name. No field here is free text. */
const COMMON_ALLOWED_FIELDS = ['eventName', 'timestamp', 'organizationId', 'projectId', 'interactionId', 'requestId'] as const

/**
 * Per-event allowlist, IN ADDITION to COMMON_ALLOWED_FIELDS. Deliberately an
 * allowlist rather than a denylist of forbidden names: a denylist only knows
 * what it has already thought to forbid, and "prompt", "context",
 * "evidenceText", "fullText", "systemPrompt" are all names a future edit could
 * add without ever matching a denylist entry someone wrote before that edit
 * existed. An allowlist fails closed on anything unanticipated instead.
 */
const EVENT_SPECIFIC_ALLOWED_FIELDS: Record<StellaObservabilityEventName, readonly string[]> = {
  'ingestion.started': ['documentId', 'sourceKind'],
  'ingestion.completed': ['documentId', 'chunkCount', 'durationMs'],
  'ingestion.failed': ['documentId', 'errorCode'],
  'retrieval.started': ['queryId'],
  'retrieval.completed': ['queryId', 'resultCount', 'topScore', 'durationMs'],
  'retrieval.abstained': ['queryId', 'reasonCode'],
  'citations.validated': ['citationCount'],
  'citations.rejected': ['rejectedCount', 'reasonCode'],
  'response.produced': ['assertionCount', 'requiresHumanReview'],
  'human_decision.recorded': ['decision', 'suggestionKey'],
  'retry.attempted': ['attempt', 'errorCode'],
  'quota.rejected': ['limit', 'windowHours'],
  'permission.rejected': ['requiredRole'],
  // Train 4.1. `ticketId` and `chargeId` are opaque, server-minted
  // identifiers — same status as `interactionId` in COMMON_ALLOWED_FIELDS,
  // never the query text or anything derived from it. `reasonCode` on
  // `replay_rejected` is one of the stable codes ticket-protocol.ts's
  // `OperationOutcome.reason` returns (e.g. "query_mismatch",
  // "scope_mismatch", "ticket_aborted") — never a sentence.
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
  // Train 4.3. `reservationId` and `chargeId` are opaque, server-minted
  // identifiers, same status as `ticketId`/`chargeId` above — never the
  // query text or anything derived from it. `reasonCode` on
  // `quota_capacity_rejected`/`quota_cross_operation_contention` is one of
  // the stable codes reserved-quota-protocol.ts's outcome types return
  // (e.g. "quota_exceeded", "sibling_consumed_between_bind_and_complete") —
  // never a sentence. `quota_cross_operation_contention` is R1's own event:
  // it distinguishes the SAFE, discard-and-refuse outcome from an ordinary
  // capacity rejection, without ever naming which sibling category won.
  quota_reservation_created: ['reservationId'],
  quota_reservation_released: ['reservationId'],
  quota_reservation_expired: ['reservationId'],
  quota_reservation_converted: ['reservationId', 'chargeId'],
  quota_capacity_rejected: ['reasonCode'],
  quota_cross_operation_contention: ['reservationId', 'reasonCode'],
}

/** Field names that must NEVER appear on any event, whatever the allowlist
 *  above says — a second, independent line of defense against the allowlists
 *  drifting to include one of these by mistake in a future edit. */
const ALWAYS_FORBIDDEN_FIELD_NAMES = [
  'prompt', 'systemPrompt', 'fullText', 'text', 'evidenceText', 'evidence',
  'documentText', 'content', 'quote', 'apiKey', 'secret', 'password',
  'authToken', 'sessionToken', 'bearerToken', 'accessToken',
] as const

export interface StellaObservabilityEventPayload {
  eventName: StellaObservabilityEventName
  timestamp: string
  organizationId: string
  projectId?: string
  interactionId?: string
  requestId: string
  [field: string]: unknown
}

export interface ObservabilityValidationResult {
  ok: boolean
  violations: string[]
}

/**
 * Fails closed on: an unknown event name, a field not on that event's
 * allowlist, a field name on ALWAYS_FORBIDDEN_FIELD_NAMES regardless of the
 * allowlist, a string value over MAX_EVENT_FIELD_VALUE_LENGTH, or a string
 * value matching the shared secret-pattern detector.
 */
export function validateObservabilityEvent(payload: Record<string, unknown>): ObservabilityValidationResult {
  const violations: string[] = []
  const eventName = payload.eventName as StellaObservabilityEventName | undefined

  if (!eventName || !STELLA_OBSERVABILITY_EVENT_NAMES.includes(eventName)) {
    return { ok: false, violations: [`unknown or missing eventName: ${String(payload.eventName)}`] }
  }

  const allowed = new Set<string>([...COMMON_ALLOWED_FIELDS, ...EVENT_SPECIFIC_ALLOWED_FIELDS[eventName]])

  for (const [key, value] of Object.entries(payload)) {
    if (ALWAYS_FORBIDDEN_FIELD_NAMES.includes(key as (typeof ALWAYS_FORBIDDEN_FIELD_NAMES)[number])) {
      violations.push(`field "${key}" is on the permanent forbidden list — never allowed on any event`)
      continue
    }
    if (!allowed.has(key)) {
      violations.push(`field "${key}" is not on the allowlist for "${eventName}"`)
      continue
    }
    if (typeof value === 'string') {
      if (value.length > MAX_EVENT_FIELD_VALUE_LENGTH) {
        violations.push(`field "${key}" is ${value.length} chars, over the ${MAX_EVENT_FIELD_VALUE_LENGTH}-char cap — events carry identifiers and codes, not prose`)
      }
      if (hasForbiddenPattern(value)) {
        violations.push(`field "${key}" matches the secret-pattern detector`)
      }
    }
  }

  return { ok: violations.length === 0, violations }
}

/** The human-decision event's `decision` field must be one of the 4 real
 *  values the decisions-schema.ts contract defines — never recreated. */
export function isValidObservedDecisionValue(value: unknown): value is StellaDecisionValue {
  return typeof value === 'string' && (STELLA_DECISION_VALUES as readonly string[]).includes(value)
}

// -----------------------------------------------------------------------------
// Metric categories — Fase 4's 7 required dimensions, kept separate.
// -----------------------------------------------------------------------------

export const STELLA_OBSERVABILITY_METRIC_CATEGORIES = [
  'latency',
  'token-usage',
  'cost',
  'isolation',
  'unsupported-claims',
  'abstention',
  'errors',
] as const

export type StellaObservabilityMetricCategory = (typeof STELLA_OBSERVABILITY_METRIC_CATEGORIES)[number]

/** The 3 categories no offline signal can produce — mirrors
 *  matrix.ts's PROVIDER_DEPENDENT_METRICS, over the runtime-observability
 *  vocabulary instead of the eval-harness one. Kept as a SEPARATE constant
 *  (not imported from matrix.ts) because the two contracts describe
 *  different things — one is what an EVAL CHECK may compute, the other is
 *  what a PRODUCTION EVENT may report — and importing one into the other
 *  would make an edit to either silently change both. */
export const PROVIDER_DEPENDENT_OBSERVABILITY_METRICS: readonly StellaObservabilityMetricCategory[] = [
  'latency',
  'token-usage',
  'cost',
]

export interface ObservabilityMetricNullReason {
  code: 'requires-provider-call' | 'requires-provider-usage-metadata' | 'requires-token-usage-and-calibration'
  gate: 'G1' | 'G9'
  detail: string
}

export interface ObservabilityMetricValue {
  category: StellaObservabilityMetricCategory
  measurable: boolean
  value: number | null
  nullReason: ObservabilityMetricNullReason | null
}

/**
 * Fails closed the same way assertMetricsMatchMatrix does in harness.ts: a
 * provider-dependent category reported as measurable, or carrying a value
 * without a real provider round-trip, is a fabricated number — this rejects
 * it outright rather than logging it.
 */
export function assertProviderDependentMetricsAreNull(metrics: readonly ObservabilityMetricValue[]): string[] {
  const problems: string[] = []
  for (const category of PROVIDER_DEPENDENT_OBSERVABILITY_METRICS) {
    const metric = metrics.find((m) => m.category === category)
    if (!metric) continue
    if (metric.measurable || metric.value !== null || metric.nullReason === null) {
      problems.push(`"${category}" is provider-dependent and must be reported as measurable:false, value:null, with a structured nullReason — got measurable=${metric.measurable}, value=${metric.value}`)
    }
  }
  for (const metric of metrics) {
    if (metric.value === null && metric.nullReason === null) {
      problems.push(`"${metric.category}" is null with no structured reason`)
    }
    if (metric.value !== null && metric.nullReason !== null) {
      problems.push(`"${metric.category}" carries both a value and a null reason`)
    }
  }
  return problems
}
