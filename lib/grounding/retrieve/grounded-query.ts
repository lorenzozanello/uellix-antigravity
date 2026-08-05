// lib/grounding/retrieve/grounded-query.ts
// GROUNDING line — the whole query journey as one pure application function.
//
//   scope
//     -> query
//     -> repository        (injected; scope-guarded, optionally scope-attested)
//     -> retrieval         (scored, thresholded, deduplicated, diversified)
//     -> extractive generator
//     -> citation validation
//     -> canonical classification
//     -> grounded result
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS ALONGSIDE orchestrateGroundedResponse
// ---------------------------------------------------------------------------
// `orchestrateGroundedResponse` takes a generator as an argument and has no
// opinion about which one. That is correct for a composition root, and it is
// exactly what left every caller having to answer the same question — "which
// generator?" — with the honest answer being "there isn't one" (see
// `absentAnswerDraftProvider` in the server action, which rejects on purpose).
//
// This function answers it: the DEFAULT is the local extractive strategy, a
// real generator that runs offline and deterministically. A caller that has a
// model plugs it in through the same seam and everything else is unchanged.
//
// ---------------------------------------------------------------------------
// NO NEW VOCABULARY
// ---------------------------------------------------------------------------
// R8 was closed by integration deciding that the canonical vocabulary at the
// action boundary is {@link GroundingOrchestrationClassification} — six
// members — and that `GroundedOutcomeKind` is not read there. Reading both
// would be the beginning of a third vocabulary.
//
// So this function DEFINES NO CLASSIFICATION, no status enum, no result kind.
// It returns {@link GroundingOrchestrationResult} verbatim and adds one field
// of PROVENANCE — which components produced the answer — because "which
// generator wrote this?" is a question the existing types genuinely could not
// answer, not a restatement of one they already do.
//
// ---------------------------------------------------------------------------
// WHAT IS PRESERVED, AND WHERE IT LIVES
// ---------------------------------------------------------------------------
//   R6  one `no_matching_evidence` code, with `inspected.total` separating
//       "nothing was indexed" from "passages existed and none got grounded".
//       Lives in `grounded-answer.ts#abstentionFor`; untouched here.
//   R7  the two-distinct-source floor, still PROVISIONAL and uncalibrated.
//       Lives in `retrieve.ts#DEFAULT_MIN_DISTINCT_SOURCES`; this function
//       does not override it and reports which floor was applied so a future
//       calibration pass can attribute results to it.
//   R8  resolved as above: one vocabulary, no mapping added here.
//
//   contradictions   attributed, and only from declared markers — the
//                    extractive generator never infers one.
//   provider_unavailable  kept separate from every evidence state: it means
//                    "we could not look", never "your evidence does not say".
//   scope errors     RETHROWN, from retrieval and now from the generator too.
//   operational errors  degrade to `provider_unavailable`.
//
// PURE except through the injected repository. Zero imports from `db/**`, no
// fetch, no clock, no provider call, no fixture.

import type { GroundingScope, RetrievalStrategy } from '../contracts'
import { createExtractiveAnswerProvider, type ExtractiveGeneratorOptions } from './extractive-generator'
import { DEFAULT_MIN_DISTINCT_SOURCES } from './retrieve'
import type { GroundingChunkRepository } from './repository'
import {
  orchestrateGroundedResponse,
  type AnswerDraftProvider,
  type GroundingOrchestrationResult,
  type OrchestrateGroundedResponseOptions,
} from './orchestrate'

// ---------------------------------------------------------------------------
// Request / result
// ---------------------------------------------------------------------------

export interface GroundedQueryRequest {
  /** Where chunks come from. Wrapped in the scope guard by the orchestrator. */
  readonly repository: GroundingChunkRepository
  readonly scope: GroundingScope
  /** The question, already sanitized by the caller. */
  readonly text: string
  readonly retrieval?: OrchestrateGroundedResponseOptions
  /**
   * The answer generator. Defaults to the local extractive strategy.
   *
   * SUPPLYING ONE IS A STRATEGY CHOICE, NEVER A FALLBACK. The default must not
   * be selected because something else failed — a repository that throws
   * produces `provider_unavailable`, and answering that with quotations from an
   * empty retrieval would report a system fault as an evidence finding.
   */
  readonly generator?: AnswerDraftProvider
  /** Tuning for the default generator. Ignored when `generator` is supplied. */
  readonly extractive?: ExtractiveGeneratorOptions
}

/**
 * Which components produced this answer.
 *
 * Every id is versioned for the same reason `ChunkScorer.id` is: an answer
 * stored today is only reproducible against the components that made it, and a
 * result without their identities cannot be re-run or attributed.
 *
 * Nullable fields are null exactly when retrieval never completed — a
 * `provider_unavailable` outcome carries `retrieval: null`, and inventing a
 * scorer id for a pipeline that did not run would claim work that never
 * happened.
 */
export interface GroundedQueryProvenance {
  readonly repositoryId: string
  readonly generatorId: string
  readonly scorerId: string | null
  readonly strategy: RetrievalStrategy | null
  /**
   * The distinct-source floor that was applied (R7). Reported rather than
   * assumed, because it is the one retrieval threshold whose effect on an
   * answer is visible — it can displace a higher-scoring passage.
   */
  readonly minDistinctSources: number
}

export interface GroundedQueryRun extends GroundingOrchestrationResult {
  readonly provenance: GroundedQueryProvenance
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

/**
 * Ask one scoped question and get back a classified, citation-validated,
 * provenanced answer.
 *
 * THROWS on a scope or repository-contract violation — a programming defect
 * that must not be reported as an answer. Everything else is a returned
 * result, including provider unavailability.
 *
 * SANITIZATION. Nothing in this call path can leak driver text, because
 * nothing in it ever sees any: the repository adapter is the only component
 * that touches a database, and it is contractually required to sanitize before
 * rejecting (see the persisted adapter's own header). What reaches
 * `providerUnavailableOutcome` is that already-sanitized message, prefixed with
 * the repository's public id. A caller that needs a narrower message can read
 * `provenance.repositoryId` and write its own; it must not assume this layer
 * added redaction it did not.
 */
export async function runGroundedQuery(request: GroundedQueryRequest): Promise<GroundedQueryRun> {
  const generator = request.generator ?? createExtractiveAnswerProvider(request.extractive)
  const options = request.retrieval ?? {}

  const result = await orchestrateGroundedResponse(
    request.repository,
    generator,
    request.scope,
    request.text,
    options,
  )

  const retrieval = result.outcome.retrieval

  return {
    ...result,
    provenance: {
      repositoryId: request.repository.id,
      generatorId: generator.id,
      scorerId: retrieval?.scorerId ?? null,
      strategy: retrieval?.strategy ?? null,
      minDistinctSources: options.minDistinctSources ?? DEFAULT_MIN_DISTINCT_SOURCES,
    },
  }
}
