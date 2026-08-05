// lib/grounding/retrieve/grounded-answer.ts
// GROUNDING line — assembling an answer that cannot cite what was not retrieved.
//
// The central mechanism is narrow and worth stating plainly: A DRAFT NEVER
// SUPPLIES A CITATION. It supplies a sentence and a chunk id. Every field that
// makes a citation verifiable — evidence item, version, quoted-text hash,
// location — is READ OFF the retrieved chunk. A model that emits a plausible
// versionId or a plausible hash accomplishes nothing, because those fields are
// never taken from it.
//
// This is stronger than validation. Validation detects a forged citation after
// it exists; construction leaves nowhere to put one. Validation still runs
// afterwards — it catches the case where the retrieval result and the query
// scope disagree, which construction cannot — but it is the second line, not
// the first.
//
// Nothing here calls a model or a provider. The draft arrives as data.

import {
  citationsOf,
  hashContent,
  requireNonEmpty,
  toCitableChunkRecord,
  validateAnswerCitations,
  type AbstainedAnswerState,
  type AbstentionReason,
  type AnswerValidationIssue,
  type CitableChunkRecord,
  type CitationReference,
  type ContentHash,
  type ContradictionClaimAttribution,
  type ContradictionMarker,
  type GroundedAnswerState,
  type GroundingAnswerState,
  type GroundingAssertion,
  type GroundingChunk,
  type GroundingScope,
  type RetrievalQuery,
} from '../contracts'
import { buildRetrievalQuery } from '../contracts'
import type { ScopedRetrievalResult } from './retrieve'

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

/**
 * What a generator contributes: prose, and which retrieved chunks it rests on.
 *
 * `chunkIds` and nothing more. There is deliberately no field here for a hash,
 * a version or a location — not because a generator would not fill them in,
 * but because it would, and they would look right.
 */
export interface DraftClaim {
  readonly kind: 'evidence' | 'inference' | 'recommendation'
  readonly statement: string
  readonly chunkIds: readonly ContentHash[]
  /** Required for `inference`: the reasoning step, in one sentence. */
  readonly inferenceBasis?: string
}

/**
 * Which claim asserts one side of a draft contradiction, in the generator's
 * own terms: an id it uses to refer to the claim, and the statement it made.
 * Optional — a contradiction can still be reported without it, exactly as
 * before this field existed; it just cannot be attributed to a specific
 * claim beyond its citations.
 */
export interface DraftContradictionSide {
  readonly claimId: string
  readonly statement: string
}

export interface DraftContradiction {
  readonly summary: string
  readonly sideAChunkIds: readonly ContentHash[]
  readonly sideBChunkIds: readonly ContentHash[]
  readonly sideAClaim?: DraftContradictionSide | null
  readonly sideBClaim?: DraftContradictionSide | null
}

export interface AnswerDraft {
  readonly claims: readonly DraftClaim[]
  readonly contradictions?: readonly DraftContradiction[]
  /** What the generator states it could not answer, if anything. */
  readonly unanswered?: string | null
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/**
 * `provider_unavailable` is separate from every evidence state on purpose.
 *
 * "Your evidence does not answer this" and "we could not look" are different
 * facts about different things, and collapsing them tells a reviewer their
 * documentation is missing something it may well contain. Only one of the two
 * is a statement about the evidence; this union keeps them apart so no caller
 * can render them the same way by accident.
 */
export type GroundedOutcomeKind =
  | 'sufficient_evidence'
  | 'partial_evidence'
  | 'contradictory_evidence'
  | 'insufficient_evidence'
  | 'provider_unavailable'

export type ClaimRejectionReason =
  | 'cites_unretrieved_chunk'
  | 'no_citations'
  | 'inference_without_basis'

export interface RejectedClaim {
  readonly statement: string
  readonly reason: ClaimRejectionReason
  readonly detail: string
}

export interface RejectedContradiction {
  readonly summary: string
  readonly detail: string
}

export interface GroundedOutcome {
  readonly kind: GroundedOutcomeKind
  readonly answer: GroundingAnswerState
  readonly rejectedClaims: readonly RejectedClaim[]
  readonly rejectedContradictions: readonly RejectedContradiction[]
  /** Validator findings on the assembled answer. Non-empty means it was not emitted. */
  readonly issues: readonly AnswerValidationIssue[]
  /** Null only when nothing was retrieved because retrieval itself failed. */
  readonly retrieval: ScopedRetrievalResult | null
}

/** The provider-unavailable outcome, narrowed so `abstention` is always present. */
export interface ProviderUnavailableOutcome extends GroundedOutcome {
  readonly kind: 'provider_unavailable'
  readonly answer: AbstainedAnswerState
  readonly retrieval: null
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function buildGroundedAnswer(
  retrieval: ScopedRetrievalResult,
  draft: AnswerDraft,
): GroundedOutcome {
  const retrieved = new Map<ContentHash, GroundingChunk>(
    retrieval.candidates.map((candidate) => [candidate.chunk.chunkId, candidate.chunk]),
  )

  const assertions: GroundingAssertion[] = []
  const rejectedClaims: RejectedClaim[] = []

  for (const claim of draft.claims) {
    const resolution = resolveCitations(claim.chunkIds, retrieved)
    if (resolution.missing.length > 0) {
      rejectedClaims.push({
        statement: claim.statement,
        reason: 'cites_unretrieved_chunk',
        detail: `Cites chunk(s) not present in the retrieved context: ${resolution.missing.join(', ')}`,
      })
      continue
    }
    // A recommendation may cite nothing; a factual claim may not.
    if (resolution.citations.length === 0 && claim.kind !== 'recommendation') {
      rejectedClaims.push({
        statement: claim.statement,
        reason: 'no_citations',
        detail: 'A factual claim must rest on at least one retrieved passage',
      })
      continue
    }
    if (claim.kind === 'inference' && !claim.inferenceBasis?.trim()) {
      rejectedClaims.push({
        statement: claim.statement,
        reason: 'inference_without_basis',
        detail: 'An inference without a stated reasoning step is indistinguishable from an assertion of fact',
      })
      continue
    }

    assertions.push(toAssertion(claim, resolution.citations))
  }

  // --- contradictions ------------------------------------------------------
  const contradictions: ContradictionMarker[] = []
  const rejectedContradictions: RejectedContradiction[] = []

  draft.contradictions?.forEach((draftContradiction, index) => {
    const sideA = resolveCitations(draftContradiction.sideAChunkIds, retrieved)
    const sideB = resolveCitations(draftContradiction.sideBChunkIds, retrieved)

    // A contradiction with one unresolvable side is not weaker evidence of a
    // conflict — it is no evidence of one. Emitting it with the surviving side
    // alone would let a UI show a conflict resting on a chunk nobody can open.
    if (
      sideA.missing.length > 0 ||
      sideB.missing.length > 0 ||
      sideA.citations.length === 0 ||
      sideB.citations.length === 0
    ) {
      rejectedContradictions.push({
        summary: draftContradiction.summary,
        detail: `Both sides of a contradiction must resolve to retrieved chunks; missing: ${[...sideA.missing, ...sideB.missing].join(', ') || '(empty side)'}`,
      })
      return
    }

    contradictions.push({
      id: `contradiction-${index}`,
      summary: draftContradiction.summary,
      sideA: requireNonEmpty(sideA.citations, 'contradiction sideA'),
      sideB: requireNonEmpty(sideB.citations, 'contradiction sideB'),
      sideAClaim: attributionOf(draftContradiction.sideAClaim),
      sideBClaim: attributionOf(draftContradiction.sideBClaim),
      resolution: 'requires_human_resolution',
      severity: 'warning',
    })
  })

  const available = new Map<ContentHash, CitableChunkRecord>(
    retrieval.candidates.map((candidate) => [
      candidate.chunk.chunkId,
      toCitableChunkRecord(candidate.chunk),
    ]),
  )

  // --- nothing survived ----------------------------------------------------
  if (assertions.length === 0) {
    return {
      kind: 'insufficient_evidence',
      answer: abstain(retrieval, abstentionFor(retrieval, rejectedClaims.length > 0)),
      rejectedClaims,
      rejectedContradictions,
      issues: [],
      retrieval,
    }
  }

  const incomplete =
    rejectedClaims.length > 0 ||
    rejectedContradictions.length > 0 ||
    Boolean(draft.unanswered?.trim())

  const candidate: GroundedAnswerState = {
    status: incomplete ? 'partially_grounded' : 'grounded',
    query: retrieval.query,
    assertions: requireNonEmpty(assertions, 'assertions'),
    abstention: incomplete ? partialAbstention(retrieval, draft, rejectedClaims) : null,
    contradictions,
    signals: assertions.flatMap((assertion) =>
      citationsOf(assertion).flatMap((citation) => retrieved.get(citation.chunkId)?.signals ?? []),
    ),
    requiresHumanReview: true,
  }

  // --- validation ----------------------------------------------------------
  // Construction cannot catch everything: it reads chunks off a retrieval
  // result, so if that result's own query scope disagrees with its candidates,
  // every citation is built faithfully from a chunk that should not be there.
  // The validator is what closes that gap.
  const issues = validateAnswerCitations(candidate, available)
  if (issues.length > 0) {
    return {
      kind: 'insufficient_evidence',
      answer: abstain(retrieval, {
        code: issues.some((issue) => issue.code === 'citation_out_of_scope')
          ? 'out_of_scope'
          : 'no_matching_evidence',
        explanation:
          'The assembled answer failed citation validation and was withheld; see issues for the specific violations.',
        query: retrieval.query,
        inspected: inspectedOf(retrieval),
      }),
      rejectedClaims,
      rejectedContradictions,
      issues,
      retrieval,
    }
  }

  return {
    kind: outcomeKind(contradictions.length > 0, incomplete),
    answer: candidate,
    rejectedClaims,
    rejectedContradictions,
    issues,
    retrieval,
  }
}

/**
 * The outcome for a retrieval layer that could not be reached.
 *
 * Constructed here rather than by the caller so it cannot accidentally be
 * given assertions, an inspected count, or an evidence-flavoured explanation.
 */
export function providerUnavailableOutcome(
  scope: GroundingScope,
  text: string,
  detail: string,
): ProviderUnavailableOutcome {
  const query: RetrievalQuery = buildRetrievalQuery(scope, text)
  return {
    kind: 'provider_unavailable',
    answer: {
      status: 'abstained',
      query,
      abstention: {
        code: 'retrieval_unavailable',
        // Says what failed on OUR side. It makes no claim about the evidence,
        // because none was read.
        explanation: `Retrieval was unavailable, so no evidence was inspected: ${detail}`,
        query,
        inspected: { total: 0, belowThreshold: 0, quarantined: 0 },
      },
      contradictions: [],
      signals: [],
      requiresHumanReview: true,
    },
    rejectedClaims: [],
    rejectedContradictions: [],
    issues: [],
    retrieval: null,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CitationResolution {
  readonly citations: CitationReference[]
  readonly missing: ContentHash[]
}

/**
 * Turn chunk ids into citations by reading the retrieved chunks. Ids that do
 * not resolve are collected rather than skipped: a claim that cited three
 * passages and got two is not a claim with two citations, it is a claim whose
 * support was misdescribed.
 */
function resolveCitations(
  chunkIds: readonly ContentHash[],
  retrieved: ReadonlyMap<ContentHash, GroundingChunk>,
): CitationResolution {
  const citations: CitationReference[] = []
  const missing: ContentHash[] = []
  const seen = new Set<ContentHash>()

  for (const chunkId of chunkIds) {
    const chunk = retrieved.get(chunkId)
    if (!chunk) {
      missing.push(chunkId)
      continue
    }
    // A draft repeating one chunk is a drafting artefact, not extra support.
    if (seen.has(chunkId)) continue
    seen.add(chunkId)
    citations.push({
      chunkId: chunk.chunkId,
      evidenceId: chunk.evidenceId,
      versionId: chunk.versionId,
      location: chunk.location,
      quotedTextHash: chunk.contentHash,
    })
  }

  return { citations, missing }
}

/**
 * Turn a draft's claim reference into published attribution, or null when the
 * draft did not supply one. `assertionHash` is computed here — never
 * transported as-is from the draft — so a caller cannot forge a fingerprint
 * for a statement it never asserted.
 */
function attributionOf(side: DraftContradictionSide | null | undefined): ContradictionClaimAttribution | null {
  if (!side) return null
  return { claimId: side.claimId, assertionHash: hashContent(side.statement) }
}

function toAssertion(claim: DraftClaim, citations: CitationReference[]): GroundingAssertion {
  switch (claim.kind) {
    // requireNonEmpty rather than a cast: the caller has already rejected
    // uncited factual claims, so this can only fire if that check is ever
    // removed — which is exactly when a loud failure is worth having.
    case 'evidence':
      return {
        kind: 'evidence',
        statement: claim.statement,
        citations: requireNonEmpty(citations, 'evidence citations'),
      }
    case 'inference':
      return {
        kind: 'inference',
        statement: claim.statement,
        derivedFrom: requireNonEmpty(citations, 'inference citations'),
        inferenceBasis: claim.inferenceBasis ?? '',
      }
    case 'recommendation':
      return {
        kind: 'recommendation',
        statement: claim.statement,
        supportedBy: citations,
        requiresHumanReview: true,
      }
  }
}

function outcomeKind(hasContradictions: boolean, incomplete: boolean): GroundedOutcomeKind {
  if (hasContradictions) return 'contradictory_evidence'
  return incomplete ? 'partial_evidence' : 'sufficient_evidence'
}

function inspectedOf(retrieval: ScopedRetrievalResult): AbstentionReason['inspected'] {
  return {
    total: retrieval.inspectedCount,
    belowThreshold: retrieval.belowThresholdCount,
    quarantined: retrieval.quarantinedCount,
  }
}

/**
 * Why nothing could be answered. The codes lead to different actions, so the
 * order of these checks is the order of severity: content withheld for safety
 * is a security event and outranks "nothing was relevant enough".
 */
function abstentionFor(
  retrieval: ScopedRetrievalResult,
  claimsWereRejected: boolean,
): AbstentionReason {
  const inspected = inspectedOf(retrieval)

  if (retrieval.candidates.length === 0 && retrieval.quarantinedCount > 0) {
    return {
      code: 'content_quarantined',
      explanation: `Every matching passage was withheld by the injection-signal policy (${retrieval.quarantinedCount} of ${retrieval.inspectedCount} inspected).`,
      query: retrieval.query,
      inspected,
    }
  }
  if (retrieval.candidates.length === 0 && retrieval.belowThresholdCount > 0) {
    return {
      code: 'below_relevance_threshold',
      explanation: `${retrieval.belowThresholdCount} passage(s) were inspected and none reached the ${retrieval.query.minScore} relevance threshold.`,
      query: retrieval.query,
      inspected,
    }
  }
  // R6. `no_matching_evidence` covers two materially different situations, and
  // the DISCRIMINATOR IS WHETHER PASSAGES WERE RETRIEVED — not whether claims
  // were rejected. An empty draft over retrieved passages rejects nothing, yet
  // the corpus is just as non-silent as when a claim was thrown out; keying on
  // `claimsWereRejected` used to send that case to the "nothing indexed"
  // wording while `inspected.total` said otherwise. Metadata and prose
  // disagreeing is worse than either being vague, because prose is what the
  // human reads.
  //
  // The code stays single (see __tests__/r6.test.ts for the decision and its
  // cost/benefit): within `no_matching_evidence`, `inspected.total === 0` is
  // "nothing was there" and `> 0` is "something was there and nothing got
  // grounded", so the two are machine-separable without widening a union that
  // other workstreams consume.
  if (retrieval.candidates.length > 0) {
    return {
      code: 'no_matching_evidence',
      explanation: claimsWereRejected
        ? `${retrieval.candidates.length} passage(s) were retrieved, but no claim could be grounded in one.`
        : `${retrieval.candidates.length} passage(s) were retrieved, but the answer rested no claim on any of them.`,
      query: retrieval.query,
      inspected,
    }
  }
  return {
    code: 'no_matching_evidence',
    explanation: 'No indexed passage within scope addresses the question.',
    query: retrieval.query,
    inspected,
  }
}

function partialAbstention(
  retrieval: ScopedRetrievalResult,
  draft: AnswerDraft,
  rejectedClaims: readonly RejectedClaim[],
): AbstentionReason {
  const parts: string[] = []
  if (draft.unanswered?.trim()) parts.push(draft.unanswered.trim())
  if (rejectedClaims.length > 0) {
    parts.push(`${rejectedClaims.length} statement(s) were dropped for lacking grounded support.`)
  }
  return {
    code: 'no_matching_evidence',
    explanation: parts.join(' ') || 'Part of the question could not be grounded in the retrieved evidence.',
    query: retrieval.query,
    inspected: inspectedOf(retrieval),
  }
}

function abstain(
  retrieval: ScopedRetrievalResult,
  abstention: AbstentionReason,
): AbstainedAnswerState {
  return {
    status: 'abstained',
    query: retrieval.query,
    abstention,
    contradictions: [],
    signals: [],
    requiresHumanReview: true,
  }
}
