// lib/grounding/contracts/answer.ts
// GROUNDING line — what a grounded answer is allowed to look like.
//
// The central requirement of this contract is a separation that prose alone
// has never been able to enforce:
//
//   EVIDENCE       what a document says. Requires at least one citation.
//   INFERENCE      what follows from what documents say. Requires at least one
//                  citation AND an explicit statement of the reasoning step.
//   RECOMMENDATION what someone should do. May cite nothing, but can never be
//                  presented as a finding and always requires human review.
//   ABSENCE        the evidence does not answer the question. Structurally
//                  forbidden from carrying citations at all.
//
// These are modelled as a discriminated union with a non-empty tuple type for
// citations, so "an evidence claim with no source" and "an abstention that
// cites something anyway" are both compile errors, not lint rules. That is the
// point: the failure mode this whole workstream exists to prevent is a
// confident sentence with a citation that supports something else.

import type { ContentHash, NonEmptyReadonlyArray } from './core'
import type { ChunkLocation } from './chunks'
import type { PromptInjectionSignal } from './safety'
import type { RetrievalQuery } from './retrieval'

// ---------------------------------------------------------------------------
// Citation
// ---------------------------------------------------------------------------

/**
 * A pointer to an exact passage. Everything needed to resolve and verify it is
 * here: the chunk's content-addressed id, the evidence item it came from, the
 * location, and the hash of the quoted text.
 *
 * `quotedTextHash` is what turns a citation from a reference into a claim that
 * can be falsified: a reviewer re-slices the normalized document at
 * `location.span`, hashes it, and either it matches or the citation is wrong.
 */
export interface CitationReference {
  readonly chunkId: ContentHash
  readonly evidenceId: string
  readonly versionId: ContentHash
  readonly location: ChunkLocation
  /** SHA-256 of the cited chunk text (GroundingChunk.contentHash). */
  readonly quotedTextHash: ContentHash
}

// ---------------------------------------------------------------------------
// Abstention
// ---------------------------------------------------------------------------

/**
 * Why no grounded answer was produced. The codes are distinct because they
 * lead to different actions: `no_matching_evidence` asks the user to upload
 * something, `below_relevance_threshold` says the upload exists but does not
 * address the question, and `content_quarantined` is a security event.
 * Collapsing them into "I don't know" would hide all three.
 */
export type AbstentionReasonCode =
  /** Nothing indexed within scope matched the query at all. */
  | 'no_matching_evidence'
  /** Matches existed but every one scored below the relevance threshold. */
  | 'below_relevance_threshold'
  /** The only matches sat outside the requester's organization/project scope. */
  | 'out_of_scope'
  /** The source document could not be extracted (unsupported format, error). */
  | 'evidence_unreadable'
  /** Matches contradict each other; resolution is a human decision. */
  | 'contradictory_evidence'
  /** Every match was withheld by the injection-signal policy. */
  | 'content_quarantined'
  /** The retrieval layer itself was unavailable. Not an evidence statement. */
  | 'retrieval_unavailable'

export interface AbstentionReason {
  readonly code: AbstentionReasonCode
  /**
   * A sentence a reviewer can act on. It must describe the state of the
   * evidence, never speculate about the answer — an abstention that hints at
   * a conclusion is an ungrounded claim wearing a disclaimer.
   */
  readonly explanation: string
  /** The query that produced no answer, for reproducibility. */
  readonly query: RetrievalQuery | null
  /** How many candidates were seen and rejected, by cause. */
  readonly inspected: {
    readonly total: number
    readonly belowThreshold: number
    readonly quarantined: number
  }
}

// ---------------------------------------------------------------------------
// Contradiction
// ---------------------------------------------------------------------------

/**
 * Two cited passages that cannot both be true.
 *
 * `resolution` is a single literal on purpose. Stella does not average two
 * figures, does not prefer the more recent document, and does not drop the
 * inconvenient side — it reports both anchors and stops. Making the field a
 * one-member union means no future code path can quietly add a
 * 'resolved_automatically' state without editing this contract in a diff a
 * reviewer will see.
 */
export interface ContradictionMarker {
  readonly id: string
  readonly summary: string
  readonly sideA: NonEmptyReadonlyArray<CitationReference>
  readonly sideB: NonEmptyReadonlyArray<CitationReference>
  readonly resolution: 'requires_human_resolution'
  readonly severity: 'warning'
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export type GroundingAssertionKind = 'evidence' | 'inference' | 'recommendation' | 'absence'

/** A statement quoting or paraphrasing what a document says. */
export interface EvidenceAssertion {
  readonly kind: 'evidence'
  readonly statement: string
  readonly citations: NonEmptyReadonlyArray<CitationReference>
}

/** A statement derived from evidence. The derivation itself must be stated. */
export interface InferenceAssertion {
  readonly kind: 'inference'
  readonly statement: string
  readonly derivedFrom: NonEmptyReadonlyArray<CitationReference>
  /** The reasoning step, in one sentence. Not optional: an unexplained
   *  inference is indistinguishable from an assertion of fact. */
  readonly inferenceBasis: string
}

/** A proposed action. Never a finding, always human-reviewed. */
export interface RecommendationAssertion {
  readonly kind: 'recommendation'
  readonly statement: string
  /** May be empty: procedural advice need not quote a document. */
  readonly supportedBy: readonly CitationReference[]
  readonly requiresHumanReview: true
}

/** An explicit statement that the evidence does not answer this. */
export interface AbsenceAssertion {
  readonly kind: 'absence'
  readonly statement: string
  readonly abstention: AbstentionReason
  /** Structurally uncitable — an absence with a source is a contradiction. */
  readonly citations?: never
  readonly derivedFrom?: never
  readonly supportedBy?: never
}

export type GroundingAssertion =
  | EvidenceAssertion
  | InferenceAssertion
  | RecommendationAssertion
  | AbsenceAssertion

/** Every citation an assertion carries, regardless of which field holds them. */
export function citationsOf(assertion: GroundingAssertion): readonly CitationReference[] {
  switch (assertion.kind) {
    case 'evidence':
      return assertion.citations
    case 'inference':
      return assertion.derivedFrom
    case 'recommendation':
      return assertion.supportedBy
    case 'absence':
      return []
  }
}

// ---------------------------------------------------------------------------
// Answer state
// ---------------------------------------------------------------------------

/**
 * `grounded`           every assertion that makes a factual claim is cited.
 * `partially_grounded` some part of the question was answered and some part
 *                      abstained. Kept distinct from `grounded` so a UI cannot
 *                      present a half-answer as complete.
 * `abstained`          nothing was answered. Carries no assertions.
 */
export type GroundingAnswerStatus = 'grounded' | 'partially_grounded' | 'abstained'

interface GroundingAnswerBase {
  readonly query: RetrievalQuery
  readonly contradictions: readonly ContradictionMarker[]
  /** Signals from the content that reached this answer's context. */
  readonly signals: readonly PromptInjectionSignal[]
  /**
   * Hard guardrail, unchanged from the existing Stella contract: no grounded
   * output is ever a decision. Literal type, so it cannot be set to false.
   */
  readonly requiresHumanReview: true
}

export interface GroundedAnswerState extends GroundingAnswerBase {
  readonly status: 'grounded' | 'partially_grounded'
  readonly assertions: NonEmptyReadonlyArray<GroundingAssertion>
  readonly abstention: AbstentionReason | null
}

export interface AbstainedAnswerState extends GroundingAnswerBase {
  readonly status: 'abstained'
  readonly abstention: AbstentionReason
  readonly assertions?: never
}

export type GroundingAnswerState = GroundedAnswerState | AbstainedAnswerState

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

export interface AnswerValidationIssue {
  readonly code:
    | 'citation_without_source'
    | 'citation_hash_mismatch'
    | 'citation_out_of_scope'
    | 'partial_without_abstention'
    | 'grounded_with_abstention'
    | 'contradiction_unresolved_but_answered'
  readonly detail: string
}

/**
 * The runtime half of "no citation without a source".
 *
 * The type system guarantees that a citation LIST is non-empty; it cannot
 * guarantee that the citations point at chunks that exist, since a model can
 * emit a plausible-looking chunk id. So every citation is checked against the
 * candidate set that was actually placed in context, by id AND by quoted-text
 * hash — an id that resolves to a chunk whose text hashes differently is a
 * citation that has drifted off its passage.
 *
 * Returns issues rather than throwing: a caller usually wants to degrade the
 * answer to an abstention, not crash the request.
 */
export function validateAnswerCitations(
  state: GroundingAnswerState,
  availableChunks: ReadonlyMap<ContentHash, { contentHash: ContentHash; organizationId: string }>,
): readonly AnswerValidationIssue[] {
  const issues: AnswerValidationIssue[] = []
  const assertions: readonly GroundingAssertion[] = state.status === 'abstained' ? [] : state.assertions

  const allCitations = [
    ...assertions.flatMap((assertion) => citationsOf(assertion)),
    ...state.contradictions.flatMap((c) => [...c.sideA, ...c.sideB]),
  ]

  for (const citation of allCitations) {
    const chunk = availableChunks.get(citation.chunkId)
    if (!chunk) {
      issues.push({
        code: 'citation_without_source',
        detail: `Citation references chunk ${citation.chunkId} which was not in the retrieved context`,
      })
      continue
    }
    if (chunk.contentHash !== citation.quotedTextHash) {
      issues.push({
        code: 'citation_hash_mismatch',
        detail: `Citation to chunk ${citation.chunkId} carries quotedTextHash ${citation.quotedTextHash} but the chunk hashes to ${chunk.contentHash}`,
      })
    }
    if (chunk.organizationId !== state.query.scope.organizationId) {
      issues.push({
        code: 'citation_out_of_scope',
        detail: `Citation to chunk ${citation.chunkId} belongs to another organization`,
      })
    }
  }

  if (state.status === 'partially_grounded' && state.abstention === null) {
    issues.push({
      code: 'partial_without_abstention',
      detail: 'A partially grounded answer must state what it could not answer',
    })
  }
  if (state.status === 'grounded' && state.abstention !== null) {
    issues.push({
      code: 'grounded_with_abstention',
      detail: 'A fully grounded answer must not also carry an abstention',
    })
  }

  return issues
}
