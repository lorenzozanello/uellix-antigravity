// tests/eval/stella-release/e2e/local-extractive-generator.ts
// RELEASE line — Train 4. The "generación extractiva" step of the disposable
// local E2E journey.
//
// THIS IS NOT app/actions/stella/grounded-query.ts's answerDraftProvider, AND
// IT IS NOT A PROVIDER. app/actions/stella/grounded-query.ts wires
// `absentAnswerDraftProvider`, which always rejects, by contract — replacing
// it with a real Gemini round trip is gate G1 and out of scope for every
// offline/local train so far, this one included (see RELEASE_LOCAL_END_TO_END
// prohibitions: "NO llames proveedores. NO uses Gemini.").
//
// What this module IS: a deterministic, offline, regex-driven extractor over
// chunk text that was ALREADY retrieved from a real disposable database via
// `uellix_grounding.chunks_in_scope`. It answers exactly one fixture-shaped
// question (the planting-count claim in
// tests/eval/stella-release/fixtures/e2e/documents/*.txt) so the harness can
// demonstrate every step of
//   retrieval -> generation -> citations -> contradiction attribution -> abstention
// against REAL retrieved rows, without a language model anywhere in the loop.
// It has no other use — it is not a template for a shipping answer generator.
//
// Every GroundingAssertion/ContradictionMarker/AbstentionReason produced here
// is checked downstream by the REAL `validateAnswerCitations` from
// lib/grounding/contracts/answer.ts — this module builds nothing that
// contract does not independently re-verify.

import { hashContent } from '@/lib/grounding/contracts'
import type {
  AbstentionReason,
  ChunkLocation,
  CitationReference,
  ContentHash,
  ContradictionMarker,
  EvidenceAssertion,
  GroundingAnswerState,
  GroundingScope,
  RetrievalQuery,
} from '@/lib/grounding/contracts'

/**
 * A chunk as retrieved from the real database, shaped to exactly what
 * `uellix_grounding.chunks_in_scope` returns plus the version-level fields the
 * repository adapter (db/grounding/grounding-chunk-repository.ts) joins in.
 * Deliberately mirrors that module's `toGroundingChunk` mapping, including the
 * `LINE_RANGE_NOT_PERSISTED = 0` sentinel — this harness exercises the same
 * persisted shape production code would see, not an idealized one.
 */
export interface RetrievedChunkForGeneration {
  readonly chunkId: ContentHash
  readonly evidenceId: string
  readonly versionId: ContentHash
  readonly scope: GroundingScope
  readonly text: string
  readonly contentHash: ContentHash
  readonly location: ChunkLocation
}

export interface ExtractiveGenerationResult {
  readonly answer: GroundingAnswerState
  /** chunkIds the generator actually drew a citation from — the harness uses
   *  this to confirm the citation set was not invented or hardcoded. */
  readonly usedChunkIds: readonly ContentHash[]
}

/**
 * The one claim shape this fixture pair is built to disagree on. The number
 * precedes "native tree saplings" in both real fixture documents regardless
 * of whether "planted" sits before it ("planted 1,240 native tree
 * saplings...") or after ("...1,180 native tree saplings planted..."), so the
 * pattern anchors on the noun phrase, not on word order.
 */
const PLANTING_CLAIM_PATTERN = /([\d,]+)\s+native tree saplings/i

function citationFor(chunk: RetrievedChunkForGeneration): CitationReference {
  return {
    chunkId: chunk.chunkId,
    evidenceId: chunk.evidenceId,
    versionId: chunk.versionId,
    location: chunk.location,
    // Read off the chunk's OWN persisted hash, never recomputed from a
    // statement string — a citation must quote what retrieval actually
    // returned, and a generator that rehashes its own paraphrase would let a
    // drifted quote pass validation silently.
    quotedTextHash: chunk.contentHash,
  }
}

function inspectedCounts(total: number, belowThreshold: number, quarantined: number) {
  return { total, belowThreshold, quarantined }
}

function abstain(query: RetrievalQuery, reason: AbstentionReason): ExtractiveGenerationResult {
  return {
    answer: {
      query,
      contradictions: [],
      signals: [],
      requiresHumanReview: true,
      status: 'abstained',
      abstention: reason,
    },
    usedChunkIds: [],
  }
}

/**
 * Generate an extractive answer from chunks a REAL retrieval call already
 * returned. Never fetches anything itself, never calls a provider, never
 * fabricates a chunk id or quoted-text hash outside what its input carries.
 */
export function generateExtractiveAnswer(
  query: RetrievalQuery,
  candidates: readonly RetrievedChunkForGeneration[],
): ExtractiveGenerationResult {
  if (candidates.length === 0) {
    return abstain(query, {
      code: 'no_matching_evidence',
      explanation: 'No indexed chunk within scope matched the query text.',
      query,
      inspected: inspectedCounts(0, 0, 0),
    })
  }

  const claims = candidates
    .map((chunk) => ({ chunk, match: PLANTING_CLAIM_PATTERN.exec(chunk.text) }))
    .filter((entry): entry is { chunk: RetrievedChunkForGeneration; match: RegExpExecArray } => entry.match !== null)

  if (claims.length === 0) {
    return abstain(query, {
      code: 'below_relevance_threshold',
      explanation: 'Retrieved chunks did not contain an extractable answer to the query pattern.',
      query,
      inspected: inspectedCounts(candidates.length, candidates.length, 0),
    })
  }

  const distinctValues = new Set(claims.map((entry) => entry.match[1].replace(/,/g, '')))

  if (claims.length >= 2 && distinctValues.size > 1) {
    const [sideA, sideB] = claims
    const marker: ContradictionMarker = {
      id: `contradiction-${sideA.chunk.chunkId.slice(0, 8)}-${sideB.chunk.chunkId.slice(0, 8)}`,
      summary: `Sources disagree on the number of native tree saplings planted (${claims.map((c) => c.match[1]).join(' vs ')}).`,
      sideA: [citationFor(sideA.chunk)],
      sideB: [citationFor(sideB.chunk)],
      sideAClaim: { claimId: sideA.chunk.chunkId, assertionHash: hashContent(sideA.match[0]) },
      sideBClaim: { claimId: sideB.chunk.chunkId, assertionHash: hashContent(sideB.match[0]) },
      resolution: 'requires_human_resolution',
      severity: 'warning',
    }
    const assertion: EvidenceAssertion = {
      kind: 'evidence',
      statement: `Reported planting counts differ between sources: ${claims
        .map((c) => `${c.match[1]} (evidence ${c.chunk.evidenceId})`)
        .join('; ')}.`,
      citations: [citationFor(sideA.chunk), citationFor(sideB.chunk)],
    }
    return {
      answer: {
        query,
        contradictions: [marker],
        signals: [],
        requiresHumanReview: true,
        status: 'partially_grounded',
        assertions: [assertion],
        abstention: {
          code: 'contradictory_evidence',
          explanation: 'Sources disagree on the planting count; resolution requires human review.',
          query,
          inspected: inspectedCounts(candidates.length, 0, 0),
        },
      },
      usedChunkIds: [sideA.chunk.chunkId, sideB.chunk.chunkId],
    }
  }

  const best = claims[0]
  const assertion: EvidenceAssertion = {
    kind: 'evidence',
    statement: `${best.match[1]} native tree saplings were planted, per evidence ${best.chunk.evidenceId}.`,
    citations: [citationFor(best.chunk)],
  }
  return {
    answer: {
      query,
      contradictions: [],
      signals: [],
      requiresHumanReview: true,
      status: 'grounded',
      assertions: [assertion],
      abstention: null,
    },
    usedChunkIds: [best.chunk.chunkId],
  }
}
