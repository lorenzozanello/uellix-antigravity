// components/stella/grounding-adapter.ts
// PRODUCT TRAIN 2 — the pure GROUNDING → presentation adapter of INTEGRATION-001.
//
// GROUNDING's contracts are the canonical technical record of provenance. This
// module derives, by a pure function, the shape PRODUCT needs to paint. It is
// a ONE-WAY street, and that is the whole design:
//
//   - nothing here is persisted, serialized as a record of origin, or accepted
//     back as an input from which a citation could be reconstructed. There is
//     deliberately no inverse function (INTEGRATION-001 §2);
//   - `excerpt` is derived from GroundingChunk.text and truncated for display.
//     Truncation NEVER touches `quotedTextHash`, which stays the hash of the
//     full chunk text. A citation without its chunk shows no excerpt at all
//     rather than inventing one (§4);
//   - `location.label` is a string FOR HUMANS. The structured span and the
//     coordinateSpace travel beside it and are never replaced by it (§5);
//   - `relevance` buckets are derived from the numeric score through named,
//     versioned thresholds, and the score / strategy / rank ride along so the
//     thresholds can be recalibrated later against historical data (§6);
//   - `'contradictory_evidence'` has exactly ONE producer: a real
//     ContradictionMarker. No statement comparison, no score divergence, no
//     source disagreement may reach it (§7).
//
// PURITY, ENFORCED BY THE COMPILER, NOT BY THIS COMMENT: every import from
// `@/lib/grounding/contracts` is an `import type`. The barrel's `core` module
// imports `node:crypto` at module scope, so a single runtime import here would
// drag Node's crypto into the client bundle of every page that mounts a Stella
// panel. `isolatedModules: true` erases type-only imports in transform, so
// what ships is a module with no grounding dependency at all. The cost is that
// published RUNTIME helpers (`citationsOf`, `scopeContains`) cannot be called;
// where one is genuinely needed it is re-derived locally from the discriminant
// and marked as such. See the purity tests in
// `__tests__/grounding-adapter.test.ts`.
//
// THE ONE VALUE IMPORT, AND WHY (integration, train 2 — INTEGRATION-001 §6):
// `@/lib/grounding/retrieve/calibration` is imported as a VALUE, because the
// relevance classification has exactly one source of truth and it is
// GROUNDING's. PRODUCT published a second set of thresholds (0.6 / 0.3, version
// `product-relevance-v1`) on the same day GROUNDING published 0.4 / 0.2; the two
// were never reconciled because the lines could not see each other. They are now:
// GROUNDING owns score, bucket and version; this module consumes them and
// recomputes nothing.
//
// It is a DEEP import, not the `retrieve` barrel, and that is not a shortcut.
// The barrel re-exports the repository, the scorer and `buildGroundedAnswer`,
// all of which reach `contracts/core.ts` — so importing it as a value would put
// `node:crypto` in the client bundle, the exact failure the rule above exists to
// prevent. `calibration.ts` is a leaf: BOTH of its own imports are `import type`,
// so it erases to a module with no dependencies at all. That leaf property is
// itself pinned by a test, because it is what makes this exception safe, and the
// day someone adds a runtime import to it the exception stops being safe
// silently.

import type {
  AbstentionReason,
  AbstentionReasonCode,
  ChunkLocation,
  CitationReference,
  ContentHash,
  ContradictionClaimAttribution,
  ContradictionMarker,
  GroundingAnswerState,
  GroundingAssertion,
  GroundingAssertionKind,
  GroundingAnswerStatus,
  GroundingChunk,
  RetrievalCandidate,
  RetrievalResult,
  RetrievalStrategy,
  TextSpan,
} from '@/lib/grounding/contracts'
import {
  RELEVANCE_THRESHOLDS,
  RELEVANCE_THRESHOLDS_VERSION,
  relevanceBucket as groundingRelevanceBucket,
} from '@/lib/grounding/retrieve/calibration'
import type { RelevanceBucket } from '@/lib/grounding/retrieve/calibration'
import { decisionStatusFromAction } from './grounding-model'
import type { EvidenceSupportLevel, StellaDecisionStatus } from './grounding-model'

// ---------------------------------------------------------------------------
// Versioned display constants
// ---------------------------------------------------------------------------

/**
 * The canonical thresholds and their version, RE-EXPORTED, not redefined.
 *
 * PRODUCT does not own these numbers and must never own them again. A UI is
 * free to change the wording, the icon or the visual intensity attached to a
 * bucket; it is not free to change WHICH bucket a score falls in, because that
 * is a semantic classification of the evidence and two independent answers to
 * "how relevant is this passage" is the same credibility failure INTEGRATION-001
 * §2 forbids for provenance.
 *
 * OPEN CALIBRATION RISK (INTEGRATION-001 §6, GROUNDING risk R4): the numbers are
 * a first LOCAL calibration and are NOT optimal. There is no retrieval
 * implementation to measure against and `DEFAULT_RETRIEVAL_MIN_SCORE` (0.15) is
 * itself a placeholder. Recalibration happens in `calibration.ts` and reaches
 * this module for free — which is the point of consuming rather than copying.
 */
export { RELEVANCE_THRESHOLDS, RELEVANCE_THRESHOLDS_VERSION }

/** Display budget for one excerpt. A UI decision, not a provenance one. */
export const CITATION_EXCERPT_MAX_LENGTH = 280

// ---------------------------------------------------------------------------
// Presentation model
// ---------------------------------------------------------------------------

/**
 * Alias of GROUNDING's `RelevanceBucket`, not a parallel union. Declaring the
 * three literals again here would compile happily on the day GROUNDING adds a
 * fourth, and the adapter would then narrow a bucket it was handed.
 */
export type CitationRelevanceBucket = RelevanceBucket

/** A bucket that never stands alone: the number it came from travels with it. */
export interface RelevanceAssessment {
  readonly bucket: CitationRelevanceBucket
  /** The original `RetrievalCandidate.score`. Comparable only within one query and strategy. */
  readonly score: number
  readonly strategy: RetrievalStrategy
  readonly rank: number
  /**
   * Identity of the scorer that produced `score`, or null when the caller did
   * not supply it.
   *
   * ADDED BY INTEGRATION (train 2 adversarial review). `calibration.ts` states
   * that the score must travel with "the strategy and scorer identity" so that
   * a scorer changing SCALE under fixed thresholds is noticeable — and this
   * field did not exist, so it structurally could not. Swap the lexical scorer
   * for an embedding scorer whose scale runs 0.6–0.95 and every citation
   * renders "alta" under an unchanged `thresholdsVersion`, with nothing on
   * screen or in a saved view recording which scorer produced the numbers.
   *
   * It is nullable rather than required because it is NOT on the contract's
   * `RetrievalResult` — it lives on GROUNDING's `ScopedRetrievalResult`. A
   * caller that has it passes it; a caller that does not says so, instead of
   * the view implying an identity nobody supplied.
   */
  readonly scorerId: string | null
  readonly thresholdsVersion: typeof RELEVANCE_THRESHOLDS_VERSION
}

/** The displayed passage. `fullLength` is what `quotedTextHash` covers. */
export interface CitationExcerpt {
  readonly text: string
  readonly truncated: boolean
  readonly fullLength: number
}

/**
 * `label` is the human string PRODUCT-001 asked for. It is display-only: it is
 * never parsed, never stored as a location, and never re-enters the system.
 * `span` and `coordinateSpace` remain the authority.
 */
export interface CitationLocationView {
  readonly label: string
  readonly span: TextSpan
  readonly coordinateSpace: ContentHash
  readonly page: number | null
  readonly sectionIndex: number | null
  readonly sectionLabel: string | null
  readonly lineStart: number
  readonly lineEnd: number
}

/**
 * `passage_loaded` — the chunk was handed to presentation; an excerpt exists.
 * `source_unavailable` — the citation is verifiable (ids, hashes, location all
 * present) but its passage was not loaded. The UI says so; it does not fill
 * the gap with text.
 */
export type CitationAvailability = 'passage_loaded' | 'source_unavailable'

export interface GroundedCitationView {
  /** Stable key for React lists and for the caller's navigation target. */
  readonly key: string
  readonly chunkId: ContentHash
  readonly evidenceId: string
  readonly versionId: ContentHash
  readonly quotedTextHash: ContentHash
  readonly location: CitationLocationView
  readonly availability: CitationAvailability
  /** Null exactly when `availability` is `source_unavailable`. */
  readonly excerpt: CitationExcerpt | null
  /** Untrusted display label of the source file. Null when the chunk is absent. */
  readonly sourceLabel: string | null
  /** Null when no RetrievalCandidate backs this citation — not a guessed bucket. */
  readonly relevance: RelevanceAssessment | null
}

/**
 * Which assertion sustains one side of a contradiction.
 *
 * INTEGRATION, TRAIN 3. Train 2 closed with finding A-M open: `sideA`/`sideB`
 * are `CitationReference[]`, and two assertions that cite the same chunk
 * produce the SAME `CitationReference`, so citations alone could never tell
 * two contradicting claims apart. GROUNDING answered it by adding
 * `ContradictionClaimAttribution` to the marker; this view carries it through
 * unchanged.
 *
 * BOTH FIELDS COME FROM THE MARKER AND NOWHERE ELSE. There is deliberately no
 * attempt to match a side back to a `GroundedClaimView`:
 *
 *   - by ORDER — "sideA is claims[0]" — is an invention;
 *   - by TEXT — re-hashing a claim's statement and comparing `assertionHash`
 *     — is the text coincidence the contract forbids, and would need
 *     `hashContent`, a RUNTIME import that would drag `node:crypto` into the
 *     client bundle (see the purity note in this file's header);
 *   - by CITATIONS — is precisely the defect A-M describes.
 *
 * `claimId` is the generator's own identifier for the claim; it is NOT
 * `GroundedClaimView.key` (`${kind}-${index}`, a presentation-local index) and
 * must never be rendered as if it were. `assertionHash` is derived in
 * GROUNDING from the statement text via `hashContent` — never transported
 * from a model — so two assertions over the same chunk differ here even when
 * every citation they carry is identical.
 */
export interface GroundedContradictionClaimView {
  readonly claimId: string
  readonly assertionHash: string
}

export interface GroundedContradictionView {
  readonly id: string
  readonly summary: string
  readonly sideA: readonly GroundedCitationView[]
  readonly sideB: readonly GroundedCitationView[]
  /**
   * `null` when the marker carries no attribution — which is the case for
   * every marker built before GROUNDING train 3, and for any generator that
   * does not track per-claim identity. The UI states that absence explicitly
   * rather than filling it in; see StellaGroundedAnswerPanel.
   */
  readonly sideAClaim: GroundedContradictionClaimView | null
  readonly sideBClaim: GroundedContradictionClaimView | null
  readonly resolution: 'requires_human_resolution'
  readonly severity: 'warning'
}

export interface GroundedAbstentionView {
  readonly code: AbstentionReasonCode
  /** Short Spanish heading for the code. */
  readonly title: string
  /** GROUNDING's own explanation, verbatim. */
  readonly explanation: string
  readonly inspected: {
    readonly total: number
    readonly belowThreshold: number
    readonly quarantined: number
  }
}

export interface GroundedClaimView {
  readonly key: string
  readonly kind: GroundingAssertionKind
  readonly statement: string
  readonly support: EvidenceSupportLevel
  readonly citations: readonly GroundedCitationView[]
  /** Present only for inferences: the reasoning step, stated. */
  readonly inferenceBasis: string | null
  /** Present only for absence assertions. */
  readonly abstention: GroundedAbstentionView | null
}

export interface GroundedAnswerView {
  readonly status: GroundingAnswerStatus
  /** Answer-level badge. `partially_grounded` has a real producer: the status. */
  readonly answerSupport: EvidenceSupportLevel
  readonly claims: readonly GroundedClaimView[]
  readonly contradictions: readonly GroundedContradictionView[]
  readonly abstention: GroundedAbstentionView | null
  /** Literal in the contract; re-stated here so the UI cannot forget it. */
  readonly requiresHumanReview: true
  readonly decisionStatus: StellaDecisionStatus
  /** How many citations could not show a passage — surfaced, never hidden. */
  readonly unresolvedCitationCount: number
}

/**
 * What presentation was handed. Both maps are keyed by `chunkId`; a citation
 * whose chunk is absent from `chunks` renders as `source_unavailable`.
 *
 * SCOPE IS NOT ENFORCED HERE. Organization/project isolation is decided
 * upstream (retrieval scoping and `validateAnswerCitations`). Re-implementing
 * it in a UI module would create a second, divergent answer to "may this be
 * read?" — the exact failure INTEGRATION-001 §2 forbids for provenance. What
 * this module guarantees is narrower and checkable: a chunk it was not given
 * can never acquire an excerpt, a source label or a score.
 */
export interface GroundedPresentationInput {
  readonly chunks: ReadonlyMap<string, GroundingChunk>
  readonly candidates?: ReadonlyMap<string, RetrievalCandidate>
  /**
   * Identity of the scorer that produced the candidates' scores, when the
   * caller knows it. Carried through to `RelevanceAssessment.scorerId` — see
   * the note there for why a bucket without it is unattributable.
   */
  readonly scorerId?: string
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type GroundedCitationErrorCode =
  | 'citation_hash_mismatch'
  | 'citation_chunk_mismatch'
  | 'invalid_score'

/**
 * Thrown when a citation and the chunk offered for it disagree. Deliberately
 * NOT a soft degradation: a citation that resolves to a chunk whose text
 * hashes differently has drifted off its passage, and rendering it anyway
 * would put an unverified quote on screen under a verified-looking badge.
 * A missing chunk is a different thing entirely and degrades gracefully.
 */
export class GroundedCitationError extends Error {
  constructor(
    readonly code: GroundedCitationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GroundedCitationError'
  }
}

// ---------------------------------------------------------------------------
// Relevance
// ---------------------------------------------------------------------------

/**
 * Score → bucket. A THIN DELEGATION to GROUNDING's `relevanceBucket`, kept as a
 * named export only so `components/stella` consumers have one import path; it
 * contains no comparison of its own and no number of its own.
 *
 * The only thing added is the error TYPE. GROUNDING throws a plain `Error` for
 * a score outside [0, 1] — off-scale means the scorer moved and the thresholds
 * did not, which must not pass silently — and PRODUCT surfaces failures as
 * `GroundedCitationError` so a panel can distinguish them from a render bug.
 * Translating the failure is not reclassifying the evidence.
 */
export function relevanceBucket(score: number): CitationRelevanceBucket {
  try {
    return groundingRelevanceBucket(score)
  } catch (cause) {
    throw new GroundedCitationError(
      'invalid_score',
      `El score de recuperación no es válido bajo la calibración canónica ${RELEVANCE_THRESHOLDS_VERSION}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
}

function adaptRelevance(
  candidate: RetrievalCandidate | null,
  scorerId: string | undefined,
): RelevanceAssessment | null {
  if (candidate === null) return null
  return {
    bucket: relevanceBucket(candidate.score),
    score: candidate.score,
    strategy: candidate.strategy,
    rank: candidate.rank,
    scorerId: scorerId ?? null,
    thresholdsVersion: RELEVANCE_THRESHOLDS_VERSION,
  }
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/**
 * The human-facing rendering of a ChunkLocation ("p. 4 · Metodología · líneas
 * 12–18"). Display only — see {@link CitationLocationView}.
 */
export function formatChunkLocation(location: ChunkLocation): string {
  const parts: string[] = []
  if (location.page !== null) parts.push(`p. ${location.page}`)
  if (location.sectionLabel !== null) parts.push(location.sectionLabel)
  else if (location.sectionIndex !== null) parts.push(`sección ${location.sectionIndex + 1}`)
  parts.push(
    location.lineStart === location.lineEnd
      ? `línea ${location.lineStart}`
      : `líneas ${location.lineStart}–${location.lineEnd}`,
  )
  return parts.join(' · ')
}

function adaptLocation(location: ChunkLocation): CitationLocationView {
  return {
    label: formatChunkLocation(location),
    span: location.span,
    coordinateSpace: location.coordinateSpace,
    page: location.page,
    sectionIndex: location.sectionIndex,
    sectionLabel: location.sectionLabel,
    lineStart: location.lineStart,
    lineEnd: location.lineEnd,
  }
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

function buildExcerpt(text: string): CitationExcerpt {
  const truncated = text.length > CITATION_EXCERPT_MAX_LENGTH
  return {
    text: truncated ? `${text.slice(0, CITATION_EXCERPT_MAX_LENGTH).trimEnd()}…` : text,
    truncated,
    fullLength: text.length,
  }
}

/**
 * One citation, adapted for display.
 *
 * Throws {@link GroundedCitationError} when the offered chunk contradicts the
 * citation. Returns a `source_unavailable` view when no chunk was offered at
 * all — including the case where upstream deliberately withheld it (a chunk
 * outside the requester's scope, a quarantined passage).
 */
export function adaptCitation(
  citation: CitationReference,
  input: GroundedPresentationInput,
): GroundedCitationView {
  const chunk = input.chunks.get(citation.chunkId) ?? null

  if (chunk !== null && chunk.chunkId !== citation.chunkId) {
    throw new GroundedCitationError(
      'citation_chunk_mismatch',
      `La cita apunta al chunk ${citation.chunkId} pero el índice devolvió ${chunk.chunkId}`,
    )
  }
  if (chunk !== null && chunk.contentHash !== citation.quotedTextHash) {
    throw new GroundedCitationError(
      'citation_hash_mismatch',
      `La cita al chunk ${citation.chunkId} declara quotedTextHash ${citation.quotedTextHash} pero el chunk hashea a ${chunk.contentHash}`,
    )
  }

  const candidate = chunk === null ? null : (input.candidates?.get(citation.chunkId) ?? null)

  return {
    key: citation.chunkId,
    chunkId: citation.chunkId,
    evidenceId: citation.evidenceId,
    versionId: citation.versionId,
    quotedTextHash: citation.quotedTextHash,
    location: adaptLocation(citation.location),
    availability: chunk === null ? 'source_unavailable' : 'passage_loaded',
    excerpt: chunk === null ? null : buildExcerpt(chunk.text),
    sourceLabel: chunk === null ? null : chunk.provenance.sourceLabel,
    relevance: adaptRelevance(candidate, input.scorerId),
  }
}

// ---------------------------------------------------------------------------
// Contradictions
// ---------------------------------------------------------------------------

export function adaptContradiction(
  marker: ContradictionMarker,
  input: GroundedPresentationInput,
): GroundedContradictionView {
  return {
    id: marker.id,
    summary: marker.summary,
    sideA: marker.sideA.map((citation) => adaptCitation(citation, input)),
    sideB: marker.sideB.map((citation) => adaptCitation(citation, input)),
    sideAClaim: adaptContradictionClaim(marker.sideAClaim),
    sideBClaim: adaptContradictionClaim(marker.sideBClaim),
    resolution: marker.resolution,
    severity: marker.severity,
  }
}

/**
 * Carry attribution through, or state its absence. `undefined` (a marker from
 * before the field existed) and `null` (a generator that tracks no claim
 * identity) are the same fact for presentation — "this side is not attributed"
 * — and both become `null` so the UI has one case to handle, not two.
 */
function adaptContradictionClaim(
  attribution: ContradictionClaimAttribution | null | undefined,
): GroundedContradictionClaimView | null {
  if (!attribution) return null
  return { claimId: attribution.claimId, assertionHash: attribution.assertionHash }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Local re-derivation of the published `citationsOf` helper. It is duplicated
 * — six lines over a discriminant — rather than imported because importing it
 * as a VALUE would pull `node:crypto` into the client bundle (see the header).
 * If GROUNDING ever changes which field holds citations, the union type breaks
 * this switch at compile time.
 */
function citationsOfAssertion(assertion: GroundingAssertion): readonly CitationReference[] {
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

const ABSTENTION_TITLES: Record<AbstentionReasonCode, string> = {
  no_matching_evidence: 'Sin evidencia coincidente',
  below_relevance_threshold: 'Evidencia insuficientemente relacionada',
  out_of_scope: 'Evidencia fuera del alcance',
  evidence_unreadable: 'Evidencia ilegible',
  contradictory_evidence: 'Evidencia en conflicto',
  content_quarantined: 'Contenido retenido por seguridad',
  retrieval_unavailable: 'Búsqueda de evidencia no disponible',
}

function adaptAbstention(reason: AbstentionReason): GroundedAbstentionView {
  return {
    code: reason.code,
    title: ABSTENTION_TITLES[reason.code],
    explanation: reason.explanation,
    inspected: reason.inspected,
  }
}

/**
 * The support level of one claim.
 *
 * `contradictory_evidence` is reachable through exactly one door: the claim
 * cites a chunk that a ContradictionMarker names. `contradictedChunkIds` is
 * built only from markers, so no other input can open it — not opposing
 * statements, not diverging scores, not an AbstentionReason that happens to
 * carry the same spelling as a code.
 */
function supportForClaim(
  assertion: GroundingAssertion,
  citations: readonly CitationReference[],
  contradictedChunkIds: ReadonlySet<string>,
): EvidenceSupportLevel {
  if (citations.some((citation) => contradictedChunkIds.has(citation.chunkId))) {
    return 'contradictory_evidence'
  }
  if (assertion.kind === 'absence') return 'insufficient_evidence'
  if (citations.length === 0) return 'insufficient_evidence'
  return 'grounded'
}

function answerSupport(
  status: GroundingAnswerStatus,
  hasContradiction: boolean,
): EvidenceSupportLevel {
  if (hasContradiction) return 'contradictory_evidence'
  switch (status) {
    case 'grounded':
      return 'grounded'
    case 'partially_grounded':
      return 'partially_grounded'
    case 'abstained':
      return 'insufficient_evidence'
  }
}

// ---------------------------------------------------------------------------
// Answer
// ---------------------------------------------------------------------------

/**
 * The whole grounded answer, adapted for display. Pure: same inputs, same
 * output, no I/O, no clock, no randomness.
 */
export function adaptGroundedAnswer(
  state: GroundingAnswerState,
  input: GroundedPresentationInput,
): GroundedAnswerView {
  const contradictions = state.contradictions.map((marker) => adaptContradiction(marker, input))
  const contradictedChunkIds = new Set<string>(
    state.contradictions.flatMap((marker) =>
      [...marker.sideA, ...marker.sideB].map((citation) => citation.chunkId as string),
    ),
  )

  const assertions: readonly GroundingAssertion[] =
    state.status === 'abstained' ? [] : state.assertions

  const claims: GroundedClaimView[] = assertions.map((assertion, index) => {
    const citations = citationsOfAssertion(assertion)
    return {
      key: `${assertion.kind}-${index}`,
      kind: assertion.kind,
      statement: assertion.statement,
      support: supportForClaim(assertion, citations, contradictedChunkIds),
      citations: citations.map((citation) => adaptCitation(citation, input)),
      inferenceBasis: assertion.kind === 'inference' ? assertion.inferenceBasis : null,
      abstention: assertion.kind === 'absence' ? adaptAbstention(assertion.abstention) : null,
    }
  })

  const unresolvedCitationCount = [
    ...claims.flatMap((claim) => claim.citations),
    ...contradictions.flatMap((contradiction) => [...contradiction.sideA, ...contradiction.sideB]),
  ].filter((citation) => citation.availability === 'source_unavailable').length

  return {
    status: state.status,
    answerSupport: answerSupport(state.status, contradictions.length > 0),
    claims,
    contradictions,
    abstention: state.abstention === null ? null : adaptAbstention(state.abstention),
    requiresHumanReview: true,
    // No decision has been taken at adaptation time; the human workflow owns
    // the transitions from here (see decision-types.ts).
    decisionStatus: decisionStatusFromAction(null),
    unresolvedCitationCount,
  }
}

/**
 * Convenience for callers that already hold a RetrievalResult: builds the
 * lookup maps `adaptGroundedAnswer` expects. Pure, and still not a scope gate
 * — it indexes exactly the candidates retrieval decided to return.
 */
export function presentationInputFromRetrieval(
  result: RetrievalResult,
  /**
   * GROUNDING's `ScopedRetrievalResult` carries `scorerId`; the contract's
   * `RetrievalResult` does not. Taken as a separate argument rather than
   * widening the parameter type, so a caller holding only the contract shape
   * still compiles and simply reports the identity as unknown.
   */
  scorerId?: string,
): GroundedPresentationInput {
  return {
    chunks: new Map(result.candidates.map((candidate) => [candidate.chunk.chunkId as string, candidate.chunk])),
    candidates: new Map(result.candidates.map((candidate) => [candidate.chunk.chunkId as string, candidate])),
    scorerId,
  }
}
