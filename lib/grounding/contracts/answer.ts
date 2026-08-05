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

import type { ContentHash, GroundingScope, NonEmptyReadonlyArray } from './core'
import { scopeContains } from './core'
import type { ChunkLocation, GroundingChunk } from './chunks'
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
    | 'citation_evidence_mismatch'
    | 'citation_version_mismatch'
    | 'citation_location_mismatch'
    | 'citation_duplicated'
    | 'partial_without_abstention'
    | 'grounded_with_abstention'
    | 'contradiction_unresolved_but_answered'
  readonly detail: string
}

/**
 * What a citation is checked AGAINST: the chunk as retrieval actually returned
 * it, carrying its full isolation boundary rather than an organization id.
 *
 * The distinction is the whole of A-F1. The previous shape of this map could
 * only express `{ contentHash, organizationId }`, so the project half of the
 * boundary was not merely unchecked — it was unrepresentable, and no amount of
 * care at the call site could have supplied it. Widening the record is what
 * makes {@link scopeContains} reachable from production code at all.
 */
export interface CitableChunkRecord {
  readonly chunkId: ContentHash
  readonly contentHash: ContentHash
  /** Full isolation boundary of the chunk: organization AND project. */
  readonly scope: GroundingScope
  readonly evidenceId: string
  readonly versionId: ContentHash
  readonly location: ChunkLocation
}

/**
 * Project a retrieved chunk onto the record citations are checked against.
 *
 * Callers should build the validation map with this rather than by hand: every
 * field copied manually is a field that can be copied from the wrong place,
 * and the fields in question are precisely the isolation boundary.
 */
export function toCitableChunkRecord(chunk: GroundingChunk): CitableChunkRecord {
  return {
    chunkId: chunk.chunkId,
    contentHash: chunk.contentHash,
    scope: chunk.scope,
    evidenceId: chunk.evidenceId,
    versionId: chunk.versionId,
    location: chunk.location,
  }
}

/**
 * Whether a citation's location addresses the same passage the chunk occupies.
 *
 * `coordinateSpace` is compared as strictly as the offsets. Two spans with
 * identical integers but different coordinate spaces are not the same passage:
 * they index two different normalized texts, and the citation would resolve in
 * range and quote something else.
 */
function sameLocation(a: ChunkLocation, b: ChunkLocation): boolean {
  return (
    a.coordinateSpace === b.coordinateSpace &&
    a.span.start === b.span.start &&
    a.span.end === b.span.end &&
    a.page === b.page
  )
}

/** Identity of a citation for duplicate detection within one claim. */
function citationKey(citation: CitationReference): string {
  return `${citation.chunkId}\n${citation.location.span.start}\n${citation.location.span.end}`
}

/**
 * The runtime half of "no citation without a source".
 *
 * The type system guarantees that a citation LIST is non-empty; it cannot
 * guarantee that the citations point at chunks that exist, since a model can
 * emit a plausible-looking chunk id. So every citation is checked against the
 * candidate set that was actually placed in context along the whole
 * verification chain: scope, evidence item, version, chunk, quoted-text hash
 * and location. A citation that satisfies five of the six is not a weaker
 * citation — it is a citation to something other than what it claims.
 *
 * Every violation a citation commits is reported, not just the first. A forged
 * citation typically breaks several links at once, and truncating to the first
 * would make the audit trail describe a narrower problem than the real one.
 *
 * Returns issues rather than throwing: a caller usually wants to degrade the
 * answer to an abstention, not crash the request.
 */
export function validateAnswerCitations(
  state: GroundingAnswerState,
  availableChunks: ReadonlyMap<ContentHash, CitableChunkRecord>,
): readonly AnswerValidationIssue[] {
  const issues: AnswerValidationIssue[] = []
  const assertions: readonly GroundingAssertion[] = state.status === 'abstained' ? [] : state.assertions

  // Citations are grouped by the claim that carries them. A duplicate is
  // "one claim counting a passage twice", so the groups must stay separate:
  // two assertions resting on the same chunk is ordinary corroboration.
  const citationGroups: readonly (readonly CitationReference[])[] = [
    ...assertions.map((assertion) => citationsOf(assertion)),
    ...state.contradictions.flatMap((c) => [c.sideA, c.sideB] as const),
  ]

  for (const group of citationGroups) {
    const seen = new Set<string>()
    for (const citation of group) {
      const key = citationKey(citation)
      if (seen.has(key)) {
        issues.push({
          code: 'citation_duplicated',
          detail: `Citation to chunk ${citation.chunkId} appears more than once in the same claim`,
        })
        continue
      }
      seen.add(key)

      const chunk = availableChunks.get(citation.chunkId)
      if (!chunk) {
        issues.push({
          code: 'citation_without_source',
          detail: `Citation references chunk ${citation.chunkId} which was not in the retrieved context`,
        })
        continue
      }

      // Scope first: a chunk outside the boundary must be reported as such,
      // never demoted to a milder issue about its contents.
      if (!scopeContains(state.query.scope, chunk.scope)) {
        issues.push({
          code: 'citation_out_of_scope',
          detail: `Citation to chunk ${citation.chunkId} resolves to organization ${chunk.scope.organizationId} / project ${chunk.scope.projectId ?? '(org-wide)'}, outside the queried organization ${state.query.scope.organizationId} / project ${state.query.scope.projectId ?? '(org-wide)'}`,
        })
      }
      if (chunk.evidenceId !== citation.evidenceId) {
        issues.push({
          code: 'citation_evidence_mismatch',
          detail: `Citation to chunk ${citation.chunkId} names evidence item ${citation.evidenceId} but the chunk comes from ${chunk.evidenceId}`,
        })
      }
      if (chunk.versionId !== citation.versionId) {
        issues.push({
          code: 'citation_version_mismatch',
          detail: `Citation to chunk ${citation.chunkId} names version ${citation.versionId} but the chunk belongs to version ${chunk.versionId}`,
        })
      }
      if (chunk.contentHash !== citation.quotedTextHash) {
        issues.push({
          code: 'citation_hash_mismatch',
          detail: `Citation to chunk ${citation.chunkId} carries quotedTextHash ${citation.quotedTextHash} but the chunk hashes to ${chunk.contentHash}`,
        })
      }
      if (!sameLocation(chunk.location, citation.location)) {
        issues.push({
          code: 'citation_location_mismatch',
          detail: `Citation to chunk ${citation.chunkId} points at span [${citation.location.span.start}, ${citation.location.span.end}) in coordinate space ${citation.location.coordinateSpace}, but the chunk occupies [${chunk.location.span.start}, ${chunk.location.span.end}) in ${chunk.location.coordinateSpace}`,
        })
      }
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
