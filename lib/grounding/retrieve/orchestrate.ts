// lib/grounding/retrieve/orchestrate.ts
// GROUNDING line — the single scoped entry point for "answer this question
// against this evidence".
//
//   scope + query text
//     -> GroundingChunkRepository   (scope-guarded; caller-supplied)
//     -> retrieveGroundedChunks     (scoped retrieval; ../retrieve.ts)
//     -> AnswerDraftProvider        (caller-supplied; the ONLY seam a real
//                                     model plugs into — see below)
//     -> buildGroundedAnswer        (construction + citation validation)
//     -> classify                   (the six-way outward classification)
//
// This file is a COMPOSITION ROOT, not a place new policy is invented. Every
// decision it makes — scope enforcement, retrieval, citation validation —
// already lives in repository.ts / retrieve.ts / grounded-answer.ts; this
// module only wires them together in the order the callers of this workstream
// (an API route, a job, a test harness) would otherwise have to reproduce by
// hand, and adds the one thing none of those files provides on their own: a
// SINGLE classification a caller can switch on, instead of reading
// GroundedOutcomeKind and AbstentionReason.code separately to know what to do.
//
// PURE except through the two injected seams. Nothing here imports db/**,
// calls fetch, touches an embedding provider, or reaches the network — see
// tests/cross-workstream-style assertion "zero external providers" in
// __tests__/orchestrate.test.ts. `GroundingChunkRepository` is the interface
// GR-001/GR-002 will implement over prepared SQL; `AnswerDraftProvider` is the
// interface a real generation step (out of scope for this workstream) will
// implement. Until either exists, `InMemoryChunkRepository` and a
// deterministic test double stand in — the orchestrator cannot tell the
// difference, which is the point of depending on interfaces.

import {
  GroundingScopeViolationError,
  assertValidScope,
  type AbstentionReasonCode,
  type GroundingScope,
} from '../contracts'
import {
  buildGroundedAnswer,
  providerUnavailableOutcome,
  type AnswerDraft,
  type GroundedOutcome,
} from './grounded-answer'
import {
  enforceRepositoryScope,
  RepositoryContractViolationError,
  type GroundingChunkRepository,
} from './repository'
import { retrieveGroundedChunks, type ScopedRetrievalOptions, type ScopedRetrievalResult } from './retrieve'

// ---------------------------------------------------------------------------
// The draft-provider seam
// ---------------------------------------------------------------------------

/**
 * What the orchestrator asks of the answer-generation step.
 *
 * Carried as a distinct type (rather than reusing {@link ScopedRetrievalResult}
 * alone) so a provider implementation's signature does not have to change if
 * the orchestrator later needs to pass it something retrieval does not carry,
 * such as caller-supplied generation options.
 */
export interface AnswerDraftRequest {
  readonly scope: GroundingScope
  readonly text: string
  readonly retrieval: ScopedRetrievalResult
}

/**
 * The seam a real answer generator (an LLM call, out of scope for this
 * workstream) implements. Nothing in `lib/grounding/**` calls a provider —
 * this interface exists so that when one is wired in elsewhere, it plugs in
 * here without this file changing.
 *
 * `draftAnswer` is expected to REJECT, not return a degraded draft, when the
 * provider itself could not be reached — see {@link orchestrateGroundedResponse},
 * which turns that rejection into the `provider_unavailable` classification.
 * A draft with zero claims is a different fact ("nothing to say") from a
 * provider that never ran, and collapsing them would misreport which one
 * happened.
 */
export interface AnswerDraftProvider {
  /** Versioned identity, for the same reason `ChunkScorer.id` is: which draft came from where. */
  readonly id: string
  draftAnswer(request: AnswerDraftRequest): Promise<AnswerDraft>
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * The outward classification a caller actually switches on.
 *
 * Finer than {@link GroundedOutcomeKind} on one point, deliberately:
 * `buildGroundedAnswer` maps EVERY non-contradictory, non-unavailable
 * abstention to `insufficient_evidence`, including `out_of_scope` and
 * `content_quarantined` — states its own module header calls "a security
 * event", not a statement that evidence is missing (see
 * `grounded-answer.ts`'s `abstentionFor`). Collapsing those into
 * `insufficient_evidence` at the orchestrator boundary would be exactly the
 * thing that module warns against doing. So this classification keeps
 * `insufficient_evidence` for the codes that really do mean "nothing found or
 * nothing relevant" (`no_matching_evidence`, `below_relevance_threshold`,
 * `evidence_unreadable`) and routes everything else abstained — quarantine,
 * out-of-scope, a failed citation validation pass — to the more general
 * `abstention`, so a caller cannot mistake a security withholding for a
 * request to "please upload more evidence".
 */
export type GroundingOrchestrationClassification =
  | 'grounded'
  | 'partially_grounded'
  | 'contradictory'
  | 'insufficient_evidence'
  | 'abstention'
  | 'provider_unavailable'

export interface GroundingOrchestrationResult {
  readonly classification: GroundingOrchestrationClassification
  readonly outcome: GroundedOutcome
}

const EVIDENCE_GAP_CODES: readonly AbstentionReasonCode[] = [
  'no_matching_evidence',
  'below_relevance_threshold',
  'evidence_unreadable',
]

function classify(outcome: GroundedOutcome): GroundingOrchestrationClassification {
  switch (outcome.kind) {
    case 'sufficient_evidence':
      return 'grounded'
    case 'partial_evidence':
      return 'partially_grounded'
    case 'contradictory_evidence':
      return 'contradictory'
    case 'provider_unavailable':
      return 'provider_unavailable'
    case 'insufficient_evidence': {
      const code = outcome.answer.status === 'abstained' ? outcome.answer.abstention.code : null
      return code !== null && EVIDENCE_GAP_CODES.includes(code) ? 'insufficient_evidence' : 'abstention'
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Retrieval policy for one orchestrated request.
 *
 * An alias rather than an empty extending interface: today the orchestrator
 * adds no options of its own, and an interface that declares no members is
 * indistinguishable from its supertype. Publishing the name anyway means a
 * caller writes `OrchestrateGroundedResponseOptions` and keeps compiling on
 * the day the orchestrator does gain an option retrieval has no notion of.
 */
export type OrchestrateGroundedResponseOptions = ScopedRetrievalOptions

/**
 * Ask one scoped question of one repository, and get back a classified,
 * citation-validated answer.
 *
 * Two failure surfaces are treated differently, on purpose:
 *
 *   - A `GroundingScopeViolationError` or `RepositoryContractViolationError`
 *     from the repository is a PROGRAMMING DEFECT — a broken WHERE clause, a
 *     repository that ignored its authorization filters — and is rethrown
 *     rather than reported as an answer. `enforceRepositoryScope` (below) is
 *     what makes this reachable: it verifies every chunk the repository
 *     returns before this function sees it. Swallowing that into
 *     `provider_unavailable` would hide a boundary break behind a status a
 *     caller might just retry.
 *   - Any OTHER error while fetching candidates (a database connection
 *     refused, a network timeout) is an OPERATIONAL condition, not a claim
 *     about the evidence, and is reported as `provider_unavailable` via
 *     {@link providerUnavailableOutcome} — the same distinction that function's
 *     own header draws between "your evidence does not answer this" and "we
 *     could not look".
 *   - A `draftProvider.draftAnswer` rejection is always `provider_unavailable`
 *     — see {@link AnswerDraftProvider}.
 */
export async function orchestrateGroundedResponse(
  repository: GroundingChunkRepository,
  draftProvider: AnswerDraftProvider,
  scope: GroundingScope,
  text: string,
  options: OrchestrateGroundedResponseOptions = {},
): Promise<GroundingOrchestrationResult> {
  assertValidScope(scope)

  const guarded = enforceRepositoryScope(repository)

  let retrieval: ScopedRetrievalResult
  try {
    retrieval = await retrieveGroundedChunks(guarded, scope, text, options)
  } catch (error) {
    if (error instanceof GroundingScopeViolationError || error instanceof RepositoryContractViolationError) {
      throw error
    }
    const outcome = providerUnavailableOutcome(scope, text, describeFailure(repository.id, error))
    return { classification: 'provider_unavailable', outcome }
  }

  let draft: AnswerDraft
  try {
    draft = await draftProvider.draftAnswer({ scope, text, retrieval })
  } catch (error) {
    const outcome = providerUnavailableOutcome(scope, text, describeFailure(draftProvider.id, error))
    return { classification: 'provider_unavailable', outcome }
  }

  const outcome = buildGroundedAnswer(retrieval, draft)
  return { classification: classify(outcome), outcome }
}

function describeFailure(sourceId: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `${sourceId}: ${message}`
}
