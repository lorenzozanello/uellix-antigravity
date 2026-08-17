// lib/stella/adapter/provider-call-log.ts
//
// G1-B — THE PROVIDER INVOCATION COUNTER.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, AND WHY NOTHING ELSE COULD DO IT
// ---------------------------------------------------------------------------
// PB-01 (`PROVIDER_CALL_CONCURRENCY_PER_TICKET`) states that a ticket already
// `bound` admits N concurrent deliveries, each of which can reach the provider
// before one `complete` wins:
//
//     1 ticket  ->  1 bind  ->  N Gemini calls  ->  1 settlement
//
// Every quantity the system already records — `operation_tickets.bound_at`,
// `stella_interactions`, the quota ledger, `audit_logs` — therefore reads 1
// while the provider was invoked N times. They measure UELLIX'S ACCOUNTING, and
// Uellix's accounting is correct. They cannot measure provider calls, and
// reading them as if they could is precisely the false inference this module
// was written to replace.
//
// ---------------------------------------------------------------------------
// THE PROPERTY THESE EVENTS CERTIFY, STATED NARROWLY
// ---------------------------------------------------------------------------
//     "the Uellix runtime invoked the Gemini SDK exactly once"
//
// NOT "Google accepted one request", NOT "Google billed one request", NOT
// "Google completed one request". Those are provider-side facts, they belong to
// the provider's own console, and nothing here claims them. What PB-01 puts at
// risk is the sentence above, so that is the sentence being measured.
//
// ---------------------------------------------------------------------------
// WHY A LOCAL MODULE AND NOT `lib/stella/observability.ts`
// ---------------------------------------------------------------------------
// That module imports `@sentry/nextjs`, and the adapter deliberately does not.
// `StellaGeminiAdapter` is the model boundary (F-GB-01): everything that
// crosses it is reviewed as a thing that reaches Google. Pulling a telemetry
// SDK into that import graph to add two log lines would be a bigger change than
// the change itself.
//
// It is also NOT a logging framework, and must not become one. One sink, one
// shape, three event names.
//
// ---------------------------------------------------------------------------
// NEVER THROWS — AND THAT IS A CORRECTNESS PROPERTY, NOT POLITENESS
// ---------------------------------------------------------------------------
// A telemetry failure that propagated would convert a healthy, already-charged
// provider call into an error — observability taking down the thing it
// observes. Every emitter swallows its own failure and increments a counter, in
// the same shape `emitTicketEvent` uses.

import { randomUUID } from 'node:crypto'
import type { StellaProviderMetadata } from './types'

/** Stable event names. The runbook greps for these literals. */
export const PROVIDER_CALL_STARTED = 'stella.provider_call.started'
export const PROVIDER_CALL_COMPLETED = 'stella.provider_call.completed'
export const PROVIDER_CALL_FAILED = 'stella.provider_call.failed'

/**
 * Why an invocation ended in an error, as a CLOSED SET.
 *
 * A code, never free text — the same rule `operation_tickets.abort_reason`
 * follows. "The invocation failed" is a fact worth counting; WHY it failed in
 * the provider's own words is a payload that can echo the request, and it stays
 * where it already goes: the redacted `console.error` in the adapter and the
 * redacted Sentry report in `reportStellaFailure`.
 */
export type ProviderFailureCategory =
  /** The adapter's own AbortController fired. */
  | 'TIMEOUT'
  /** The provider answered with an error carrying an HTTP status. */
  | 'PROVIDER_ERROR'
  /** Anything else: transport, DNS, a non-Error throw. */
  | 'UNKNOWN_PROVIDER_ERROR'

/** Telemetry failures, for a future health surface. Never surfaced as an error. */
let emitFailures = 0

export function providerCallLogFailureCount(): number {
  return emitFailures
}

export function resetProviderCallLogFailureCountForTests(): void {
  emitFailures = 0
}

/**
 * A fresh id for ONE invocation attempt.
 *
 * PER INVOCATION, never per ticket, per request or per adapter — and that is
 * the entire point. PB-01's defect is two deliveries of ONE ticket; an id
 * derived from anything shared upstream would collapse them into one and the
 * counter would report 1 where 2 happened.
 *
 * `randomUUID` from `node:crypto`: cryptographically random, already used by
 * `runGovernedStellaOperation` for its request correlation id, no new
 * dependency.
 */
export function newProviderInvocationId(): string {
  return randomUUID()
}

/**
 * The one sink.
 *
 * `JSON.stringify` and a SINGLE argument, deliberately. `console.log('[tag]',
 * obj)` — the shape `emitTicketEvent` uses — renders through Node's inspect
 * formatter, which truncates deep values, elides large ones and is not a
 * parseable format. These events are counted by a machine reading Vercel's
 * runtime logs, so they have to survive as JSON.
 *
 * `console.info`, not `console.log` or `console.error`: two of these three
 * events are the happy path, and filing normal operation at error level is how
 * an error log stops being read.
 */
function emit(payload: Record<string, unknown>): void {
  try {
    console.info(JSON.stringify(payload))
  } catch {
    emitFailures += 1
  }
}

export interface ProviderCallScope {
  readonly invocationId: string
  readonly role: string
  /**
   * The model this runtime ASKED for. Not the one that answered — that arrives
   * as `providerModelVersion` on the completed event, and the two can differ
   * (an alias resolving to a dated build), which is exactly why both are here.
   */
  readonly requestedModel: string
}

/**
 * Emitted IMMEDIATELY BEFORE `ai.models.generateContent(...)`, with no `await`
 * between the two statements.
 *
 * THE ORDER IS THE SOUNDNESS ARGUMENT, so state it precisely. Emitting BEFORE
 * makes a started event a NECESSARY CONDITION of the invocation:
 *
 *     0 started  =>  0 invocations
 *
 * which is the direction the negative block of G1-B depends on. Emitting after
 * the SDK returned its Promise would read marginally "truer" for the happy
 * path, and would break that implication: an argument-validation throw inside
 * the SDK would invoke the method and emit nothing, so a negative case could
 * show zero started while the SDK had in fact been called.
 *
 * The cost of choosing BEFORE is the mirror image, and it is the acceptable
 * one: at most an OVER-count of one, if the SDK throws synchronously before
 * doing any work. That case is not silent — it emits `failed` with the same
 * invocationId, so `started == failed` and the pair is visible rather than
 * inferred.
 */
export function emitProviderCallStarted(scope: ProviderCallScope): void {
  emit({
    event: PROVIDER_CALL_STARTED,
    invocationId: scope.invocationId,
    role: scope.role,
    requestedModel: scope.requestedModel,
  })
}

/**
 * Emitted when the invocation's Promise RESOLVES.
 *
 * `latencyMs` MEASURES THIS INVOCATION AND NOTHING ELSE: from the instant
 * `emitProviderCallStarted` ran to the instant this Promise settled.
 *
 * IT IS NOT THE G1-A LATENCY, and the two must never be compared. G1-A's
 * 11,970 ms was measured around `adapter.generate()` by the real-provider eval
 * runner, and that boundary additionally contains the payload cap checks, the
 * model-bound redaction pass, the dynamic `@google/genai` import and the client
 * construction. This number is strictly smaller and strictly narrower. The
 * event name is what disambiguates them: a `latencyMs` inside a
 * `stella.provider_call.completed` record is this one, always.
 *
 * The metadata is projected through `extractProviderMetadata`'s allowlist —
 * the SAME one the response object already uses — and then FLATTENED. Nothing
 * is spread from the provider response, so a future SDK release that starts
 * returning thought text, headers or the echoed request cannot widen this.
 */
export function emitProviderCallCompleted(
  scope: ProviderCallScope,
  metadata: StellaProviderMetadata,
  latencyMs: number,
): void {
  emit({
    event: PROVIDER_CALL_COMPLETED,
    invocationId: scope.invocationId,
    role: scope.role,
    requestedModel: scope.requestedModel,
    // Renamed on the way out: `modelVersion` next to `requestedModel` reads as
    // two spellings of one field, and they are two different facts.
    ...(metadata.modelVersion !== undefined ? { providerModelVersion: metadata.modelVersion } : {}),
    ...(metadata.responseId !== undefined ? { responseId: metadata.responseId } : {}),
    ...(metadata.finishReason !== undefined ? { finishReason: metadata.finishReason } : {}),
    ...metadata.usage,
    latencyMs,
  })
}

/** Emitted when the invocation's Promise REJECTS. Same `latencyMs` boundary. */
export function emitProviderCallFailed(
  scope: ProviderCallScope,
  failureCategory: ProviderFailureCategory,
  latencyMs: number,
): void {
  emit({
    event: PROVIDER_CALL_FAILED,
    invocationId: scope.invocationId,
    role: scope.role,
    requestedModel: scope.requestedModel,
    failureCategory,
    latencyMs,
  })
}

/**
 * Reduce a provider error to one of three codes.
 *
 * Reuses the two distinctions the adapter ALREADY makes rather than inventing a
 * taxonomy: both AbortError shapes (a DOMException and a plain Error named
 * `AbortError` — the Node fetch stack has produced each across versions, and a
 * branch that knows only one turns a timeout into a provider error), and the
 * numeric `status` that `buildGeminiErrorLog` already reads off a
 * `@google/genai` ApiError.
 *
 * Nothing else from the error is inspected, and the error itself never reaches
 * `emit`.
 */
export function classifyProviderFailure(error: unknown): ProviderFailureCategory {
  if (error instanceof DOMException && error.name === 'AbortError') return 'TIMEOUT'
  if (error instanceof Error && error.name === 'AbortError') return 'TIMEOUT'
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number') return 'PROVIDER_ERROR'
  return 'UNKNOWN_PROVIDER_ERROR'
}
