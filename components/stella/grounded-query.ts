// components/stella/grounded-query.ts
// PRODUCT TRAIN 3 — typed contract for one grounded-query round trip.
//
// This is the seam between the presentation layer and a not-yet-implemented
// orchestrator entry point (see docs/ops/contracts/PRODUCT-002 — grounded
// query orchestrator entry point). It represents exactly what a caller
// receives, nothing about how it was produced:
//
//   - the answer, its claims, its citations and its attributed
//     contradictions — all inside GroundedAnswerView, unchanged from
//     grounding-adapter.ts;
//   - abstention — GroundedAnswerView.abstention, same as above;
//   - human approval required — GroundedAnswerView.requiresHumanReview, a
//     literal `true` every successful answer already carries;
//   - availability, permission, quota and provider failure — the SAME
//     12-code StellaPanelErrorCode taxonomy every other Stella server
//     action already returns (app/actions/stella/advisor.ts, composer.ts),
//     reused rather than reinvented so a caller does not learn a second
//     error vocabulary and StellaErrorNotice renders it unchanged.
//
// This module executes no retrieval, calls no provider and validates no
// scope: it has exactly one runtime export, a type guard, and it touches
// nothing from `@/lib/grounding`.

import type { StellaPanelErrorCode } from './error-messages'
import type { GroundedAnswerView } from './grounding-adapter'

/**
 * What the caller is asking. Scope (organization/project) is deliberately
 * NOT part of this: it must come from the authenticated server context,
 * never from the client (PRODUCT-002 — "no confiar organizationId/
 * projectId desde cliente").
 */
export interface StellaGroundedQueryRequest {
  readonly query: string
}

/**
 * WHAT PRODUCED THIS ANSWER — the disclosure input (R9).
 *
 * ---------------------------------------------------------------------------
 * WHY `kind` IS SENT AND NOT COMPUTED HERE
 * ---------------------------------------------------------------------------
 * The obvious shape is for the panel to compare `generatorId` against
 * `'grounding-local-extractive'` and show the notice on a match. That would
 * put the generator's identity — a `lib/grounding` constant — into the
 * presentation layer as a duplicated string literal, and a duplicated literal
 * drifts: the day the generator is versioned to `extractive-2` the comparison
 * silently stops matching and the disclosure silently disappears, which is the
 * one failure mode a disclosure must not have.
 *
 * So the CLASSIFICATION travels with the result. It is derived server-side
 * from the run's own provenance (`GroundedQueryProvenance.generatorId`) by the
 * layer that already imports `lib/grounding`, and this module — which
 * deliberately touches nothing from `@/lib/grounding` — reads a two-value
 * discriminant it cannot get wrong.
 *
 * `generatorId` rides along for display and for support tickets. Nothing
 * branches on it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * An optional field would let a runner return a successful answer with no
 * declared strategy, and the panel would then render nothing — a missing
 * disclosure that looks exactly like a strategy that needs none. A required
 * field makes "I did not say" unrepresentable.
 */
export interface AnswerStrategyDescriptor {
  /** e.g. `grounding-local-extractive/extractive-1`. Displayed, never branched on. */
  readonly generatorId: string
  /**
   * `extractive` — every sentence is a verbatim slice of a retrieved passage.
   * `generative` — a model wrote prose. Nothing produces this today; the
   * member exists so the disclosure has something to be ABSENT for, rather
   * than being unconditional in practice while pretending to be conditional.
   */
  readonly kind: 'extractive' | 'generative'
}

export interface StellaGroundedQuerySuccess {
  readonly status: 'ok'
  /**
   * Stable identity of this exchange. Required so a human decision
   * (accept/edit/reject/undo — see decision-types.ts) has something to
   * attach to. Never derived client-side; the future runner must supply it.
   */
  readonly answerId: string
  readonly answer: GroundedAnswerView
  /** R9 — see {@link AnswerStrategyDescriptor}. */
  readonly answerStrategy: AnswerStrategyDescriptor
}

export interface StellaGroundedQueryFailure {
  readonly status: 'error'
  readonly code: StellaPanelErrorCode
  readonly message: string
}

export type StellaGroundedQueryResult = StellaGroundedQuerySuccess | StellaGroundedQueryFailure

/**
 * What the future INTEGRATION-OWNED server action (PRODUCT-002) must
 * satisfy. The presentation layer accepts an implementation of this type as
 * a caller-supplied prop and never constructs one itself — see
 * StellaGroundedQueryPanel. No default implementation exists anywhere in
 * `components/stella/**`, on purpose: there is nothing to fall back to.
 */
export type StellaGroundedQueryRunner = (
  request: StellaGroundedQueryRequest,
  ticket: StellaOperationTicket,
) => Promise<StellaGroundedQueryResult>

/* -------------------------------------------------------------------------- */
/* Train 4.1 — the operation ticket (INT-INT-001)                             */
/* -------------------------------------------------------------------------- */

/**
 * An opaque, server-issued operation ticket.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A SECOND ARGUMENT AND NOT A FIELD OF THE REQUEST
 * ---------------------------------------------------------------------------
 * `StellaGroundedQueryRequest` stays exactly `{ query }`. That is not
 * cosmetic. The request is the FUNCTIONAL payload — what the reviewer asked —
 * and the ticket is a CREDENTIAL. Folding a credential into the payload would
 * mean the one object a client fully composes now carries the value that
 * decides whether a unit is charged, and "the client cannot smuggle a ticket
 * inside the query" would become a claim about a parser instead of a fact
 * about a type. As two parameters, the query has nowhere to put a ticket and
 * the ticket has nowhere to put a query.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLIENT MAY HOLD IT AT ALL
 * ---------------------------------------------------------------------------
 * Because only the client knows whether the next call is a NEW QUESTION or a
 * RETRY OF THE CURRENT ONE, and that distinction cannot be recovered on the
 * server from anything the request carries. Identical text is a legitimate new
 * question; elapsed time is not identity; a fresh uuid per invocation
 * double-charges every retry. The panel already draws the distinction
 * structurally — `handleSubmit` versus `handleRetry` are two different
 * functions reached by two different affordances — so the ticket rides that
 * existing seam rather than a new heuristic.
 *
 * Holding it is safe because it is not trusted. The server re-validates it in
 * SQL on every presentation: `bind_operation_ticket` and
 * `complete_operation_ticket` re-derive the actor from `auth.uid()`, and RLS
 * plus a trigger re-check organization and project. A borrowed or invented
 * ticket finds nothing, and finds nothing in a way indistinguishable from an
 * id that never existed. The ticket is an OPERATION identity; it is not, and
 * never substitutes for, authentication.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CARRIES
 * ---------------------------------------------------------------------------
 * 64 lowercase hex characters and nothing else. Not the charge nonce (no
 * server function returns it), not the stored query digest, not an
 * organization, project or actor id, and nothing from which any of those can
 * be derived. It is opaque by construction, not by convention: `stella_0014`
 * mints it as a digest of two independent uuid4 draws, so it is not a uuid a
 * consumer could try to parse or re-derive.
 */
export type StellaOperationTicket = string

/**
 * What the server surface that MINTS tickets returns.
 *
 * `disabled` is a first-class member rather than an error because a false
 * feature flag must cost zero database work and emit zero telemetry — see the
 * issuing action. It is distinct from `unavailable`, which means the flag was
 * on and the mint genuinely failed.
 */
export type StellaOperationTicketIssueResult =
  | { readonly status: 'issued'; readonly ticket: StellaOperationTicket }
  | { readonly status: 'disabled' }
  | { readonly status: 'error'; readonly code: StellaPanelErrorCode; readonly message: string }

/**
 * The server surface that issues one ticket.
 *
 * TAKES NO ARGUMENTS, and that is the point. Organization, project, actor,
 * category, TTL and nonce are all derived server-side; there is no parameter
 * for any of them, so "the client cannot choose its own scope" is a property
 * of this signature rather than of a validation the server remembers to run.
 */
export type StellaOperationTicketIssuer = () => Promise<StellaOperationTicketIssueResult>

export function isStellaGroundedQuerySuccess(
  result: StellaGroundedQueryResult,
): result is StellaGroundedQuerySuccess {
  return result.status === 'ok'
}
