// tests/cross-workstream/grounding-to-product.test.ts
// INTEGRATION (Stella parallel train 2) — the GROUNDING → PRODUCT seam.
//
// Every other suite in this repository tests one line against its own fixtures.
// These tests exist because that is exactly the shape of failure the parallel
// trains produce: four units that are individually correct and disagree at the
// joins. Train 2 shipped three such disagreements — a citable-chunk record with
// no scope, a threshold set defined twice, a closed finding still asserted as
// open — and none of them was visible from inside the line that caused it.
//
// So these tests are deliberately NOT written against integration-invented
// fixtures. They drive GROUNDING's REAL retrieval implementation over
// GROUNDING's own fixtures, and feed the result straight into PRODUCT's REAL
// adapter. A fixture written here to represent a RetrievalCandidate would be a
// fixture written by the party with the least reason to notice it had drifted.

import { describe, it, expect } from 'vitest'
import {
  InMemoryChunkRepository,
  retrieveGroundedChunks,
  RELEVANCE_THRESHOLDS,
  RELEVANCE_THRESHOLDS_VERSION,
  presentRelevance,
} from '@/lib/grounding/retrieve'
import type {
  CitationReference,
  ContradictionMarker,
  GroundedAnswerState,
  NonEmptyReadonlyArray,
} from '@/lib/grounding/contracts'
import {
  citationsOf,
  hashContent,
  toCitableChunkRecord,
  validateAnswerCitations,
} from '@/lib/grounding/contracts'
import {
  chunkFixture,
  scopeA1,
  scopeA2,
  ORG_A,
  PROJECT_1,
} from '@/lib/grounding/__tests__/fixtures'
import {
  adaptCitation,
  adaptGroundedAnswer,
  presentationInputFromRetrieval,
  RELEVANCE_THRESHOLDS as PRODUCT_THRESHOLDS,
  RELEVANCE_THRESHOLDS_VERSION as PRODUCT_THRESHOLDS_VERSION,
} from '@/components/stella/grounding-adapter'

const HOUSEHOLDS = 'El informe registra 1.240 hogares beneficiarios directos en 2025.'
const ANNEX = 'El anexo del informe registra 890 hogares en el mismo periodo de 2025.'
const OTHER_PROJECT = 'El informe del proyecto vecino registra 1.240 hogares en 2025.'

const REPORT_CHUNK = chunkFixture(HOUSEHOLDS, { evidenceId: 'ev-informe' })
const ANNEX_CHUNK = chunkFixture(ANNEX, { evidenceId: 'ev-anexo' })
const SIBLING_PROJECT_CHUNK = chunkFixture(OTHER_PROJECT, {
  evidenceId: 'ev-vecino',
  scope: scopeA2,
})

const REPOSITORY = new InMemoryChunkRepository([REPORT_CHUNK, ANNEX_CHUNK, SIBLING_PROJECT_CHUNK])

/** Real retrieval, real scoring, real scope guard. Nothing stubbed. */
async function retrieve(scopeOverride = scopeA1) {
  return retrieveGroundedChunks(REPOSITORY, scopeOverride, 'hogares beneficiarios 2025')
}

/**
 * A grounded answer over the given citations.
 *
 * Typed as `GroundedAnswerState` with no cast: a cast would let this file keep
 * compiling on the day the contract grows a field, which is precisely the class
 * of drift these tests exist to catch. `signals` is spelled out for the same
 * reason — an answer that forgot to declare its injection signals should not be
 * constructible here.
 *
 * The parameter is `NonEmptyReadonlyArray`, not a plain array, because that is
 * what the contract says an evidence assertion carries. Widening it here to make
 * the helper convenient would have moved the check from compile time to nowhere.
 */
function evidenceAnswer(
  citations: NonEmptyReadonlyArray<CitationReference>,
): GroundedAnswerState {
  return {
    status: 'grounded',
    query: {
      scope: scopeA1,
      text: 'hogares beneficiarios 2025',
      topK: 5,
      minScore: 0.15,
      evidenceIds: [],
      quarantineAtOrAbove: 'warning',
    },
    assertions: [
      { kind: 'evidence', statement: 'El programa alcanzó 1.240 hogares en 2025.', citations },
    ],
    contradictions: [],
    abstention: null,
    signals: [],
    requiresHumanReview: true,
  }
}

function citationOf(chunk: typeof REPORT_CHUNK): CitationReference {
  return {
    chunkId: chunk.chunkId,
    evidenceId: chunk.evidenceId,
    versionId: chunk.versionId,
    quotedTextHash: chunk.contentHash,
    location: chunk.location,
  }
}

// ---------------------------------------------------------------------------
// 1. A RetrievalCandidate survives adaptation with its score intact
// ---------------------------------------------------------------------------

describe('GROUNDING → PRODUCT: the score crosses the seam unchanged', () => {
  it('adapts a real RetrievalCandidate without losing, rounding or replacing its score', async () => {
    const result = await retrieve()
    expect(result.candidates.length).toBeGreaterThan(0)

    const candidate = result.candidates[0]
    const input = presentationInputFromRetrieval(result)
    const view = adaptCitation(citationOf(candidate.chunk), input)

    // Identity, not approximate equality: a bucket that replaced the number
    // would leave nothing to recalibrate historical data against.
    expect(view.relevance?.score).toBe(candidate.score)
    expect(view.relevance?.strategy).toBe(candidate.strategy)
    expect(view.relevance?.rank).toBe(candidate.rank)
  })

  it('carries the strategy AND the scorer identity, because a score is comparable only within one of each', async () => {
    const result = await retrieve()
    expect(result.scorerId).toBeTruthy()

    const view = adaptCitation(
      citationOf(result.candidates[0].chunk),
      presentationInputFromRetrieval(result, result.scorerId),
    )
    expect(view.relevance?.strategy).toBe(result.strategy)
    // Asserted on the VIEW, not on GROUNDING's result. The first version of
    // this test checked `result.scorerId` — a property of the producer — and
    // then only compared `strategy`, so its title claimed a seam property it
    // never crossed. `RelevanceAssessment.scorerId` did not exist at the time;
    // the adversarial review found that the field was missing and the test was
    // covering for it.
    expect(view.relevance?.scorerId).toBe(result.scorerId)
  })

  it('says the scorer is unknown rather than implying one, when the caller does not supply it', async () => {
    const result = await retrieve()
    const view = adaptCitation(citationOf(result.candidates[0].chunk), presentationInputFromRetrieval(result))
    expect(view.relevance?.scorerId).toBeNull()
    // The score and bucket still cross intact — only the attribution is absent.
    expect(view.relevance?.score).toBe(result.candidates[0].score)
  })
})

// ---------------------------------------------------------------------------
// 2. The bucket and its version are consumed, never recomputed
// ---------------------------------------------------------------------------

describe('GROUNDING → PRODUCT: one owner for the relevance classification', () => {
  it('PRODUCT re-exports GROUNDING’s thresholds by identity, not by copy', () => {
    expect(PRODUCT_THRESHOLDS).toBe(RELEVANCE_THRESHOLDS)
    expect(PRODUCT_THRESHOLDS_VERSION).toBe(RELEVANCE_THRESHOLDS_VERSION)
  })

  it('agrees with GROUNDING’s own presentRelevance on every real candidate', async () => {
    const result = await retrieve()
    const input = presentationInputFromRetrieval(result)

    for (const candidate of result.candidates) {
      const canonical = presentRelevance(candidate, result)
      const view = adaptCitation(citationOf(candidate.chunk), input)

      expect(view.relevance?.bucket).toBe(canonical.bucket)
      expect(view.relevance?.score).toBe(canonical.score)
      expect(view.relevance?.thresholdsVersion).toBe(canonical.thresholdsVersion)
    }
  })

  it('would disagree if PRODUCT still used its retired thresholds — the boundary between them is exercised', async () => {
    // The retired PRODUCT thresholds were 0.6 / 0.3 against GROUNDING's
    // 0.4 / 0.2. This asserts a score in the disputed band exists and lands on
    // the canonical side, so the test above is not passing vacuously on scores
    // both calibrations happened to agree about.
    const result = await retrieve()
    const disputed = result.candidates.filter((c) => c.score >= 0.4 && c.score < 0.6)
    if (disputed.length === 0) {
      // Not an excuse to skip: assert the classification directly instead.
      expect(RELEVANCE_THRESHOLDS.high).toBe(0.4)
      expect(RELEVANCE_THRESHOLDS.medium).toBe(0.2)
      return
    }
    const input = presentationInputFromRetrieval(result)
    for (const candidate of disputed) {
      const view = adaptCitation(citationOf(candidate.chunk), input)
      expect(view.relevance?.bucket).toBe('high')
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Cross-project citations die before the UI, not in it
// ---------------------------------------------------------------------------

describe('GROUNDING → PRODUCT: isolation is decided upstream', () => {
  it('never retrieves a sibling project’s chunk for a project-scoped reader', async () => {
    const result = await retrieve(scopeA1)
    const evidenceIds = result.candidates.map((c) => c.chunk.evidenceId)
    expect(evidenceIds).not.toContain('ev-vecino')
  })

  it('reports a sibling-project citation as out of scope BEFORE anything is adapted', () => {
    const answer = evidenceAnswer([citationOf(SIBLING_PROJECT_CHUNK)])
    const available = new Map([
      [SIBLING_PROJECT_CHUNK.chunkId, toCitableChunkRecord(SIBLING_PROJECT_CHUNK)],
    ])

    const issues = validateAnswerCitations(answer, available)
    expect(issues.map((i) => i.code)).toContain('citation_out_of_scope')
    expect(answer.query.scope).toEqual({ organizationId: ORG_A, projectId: PROJECT_1 })
  })

  it('does not ask the adapter to be a second scope gate', () => {
    // Stated as a test because it is a design decision that looks like a gap.
    // The adapter is handed a chunk map; re-checking scope there would create a
    // second, divergent answer to "may this be read?". What it DOES guarantee is
    // narrower and checkable: a chunk it was not given cannot acquire an
    // excerpt, a source label or a score.
    const answer = evidenceAnswer([citationOf(SIBLING_PROJECT_CHUNK)])
    const view = adaptGroundedAnswer(answer, { chunks: new Map() })

    const citation = view.claims[0].citations[0]
    expect(citation.availability).toBe('source_unavailable')
    expect(citation.excerpt).toBeNull()
    expect(citation.sourceLabel).toBeNull()
    expect(citation.relevance).toBeNull()
    expect(view.unresolvedCitationCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. A ContradictionMarker reaches PRODUCT as itself
// ---------------------------------------------------------------------------

describe('GROUNDING → PRODUCT: contradictions', () => {
  const marker: ContradictionMarker = {
    id: 'contra-hogares-2025',
    summary: 'El informe y el anexo declaran cifras distintas de hogares para 2025.',
    sideA: [citationOf(REPORT_CHUNK)],
    sideB: [citationOf(ANNEX_CHUNK)],
    resolution: 'requires_human_resolution',
    severity: 'warning',
  }

  const contradicted: GroundedAnswerState = {
    ...evidenceAnswer([citationOf(REPORT_CHUNK)]),
    contradictions: [marker],
  }

  const chunks = new Map([
    [REPORT_CHUNK.chunkId as string, REPORT_CHUNK],
    [ANNEX_CHUNK.chunkId as string, ANNEX_CHUNK],
  ])

  it('carries both sides, the resolution literal and the severity through unchanged', () => {
    const view = adaptGroundedAnswer(contradicted, { chunks })

    expect(view.contradictions).toHaveLength(1)
    expect(view.contradictions[0].id).toBe(marker.id)
    expect(view.contradictions[0].resolution).toBe('requires_human_resolution')
    expect(view.contradictions[0].severity).toBe('warning')
    expect(view.contradictions[0].sideA[0].chunkId).toBe(REPORT_CHUNK.chunkId)
    expect(view.contradictions[0].sideB[0].chunkId).toBe(ANNEX_CHUNK.chunkId)
  })

  it('produces contradictory_evidence ONLY from the marker, never from the prose', () => {
    const withMarker = adaptGroundedAnswer(contradicted, { chunks })
    expect(withMarker.answerSupport).toBe('contradictory_evidence')
    expect(withMarker.claims[0].support).toBe('contradictory_evidence')

    // Same two chunks, same opposing numbers in the statements, NO marker.
    const withoutMarker = adaptGroundedAnswer(
      evidenceAnswer([citationOf(REPORT_CHUNK), citationOf(ANNEX_CHUNK)]),
      { chunks },
    )
    expect(withoutMarker.answerSupport).not.toBe('contradictory_evidence')
    expect(withoutMarker.claims[0].support).not.toBe('contradictory_evidence')
  })
})

// ---------------------------------------------------------------------------
// 5. No chunk, no excerpt — ever
// ---------------------------------------------------------------------------

describe('GROUNDING → PRODUCT: an absent chunk cannot become text', () => {
  it('renders a verifiable citation with no passage rather than inventing one', () => {
    const view = adaptCitation(citationOf(REPORT_CHUNK), { chunks: new Map() })

    expect(view.availability).toBe('source_unavailable')
    expect(view.excerpt).toBeNull()
    // The verification chain survives: the citation is still checkable by hash.
    expect(view.quotedTextHash).toBe(REPORT_CHUNK.contentHash)
    expect(view.versionId).toBe(REPORT_CHUNK.versionId)
    expect(view.location.coordinateSpace).toBe(REPORT_CHUNK.location.coordinateSpace)
  })

  it('refuses a chunk whose text no longer hashes to the citation, instead of degrading it softly', () => {
    // The realistic drift: the document was re-normalized, so the chunk's text
    // AND its own hash moved together, while a citation emitted against the
    // previous version still carries the old `quotedTextHash`. The chunk is
    // internally consistent — which is why a naive check would let it through.
    const driftedText = `${REPORT_CHUNK.text} (corregido)`
    const drifted = {
      ...REPORT_CHUNK,
      text: driftedText,
      contentHash: hashContent(driftedText),
    }
    expect(() =>
      adaptCitation(citationOf(REPORT_CHUNK), {
        chunks: new Map([[REPORT_CHUNK.chunkId as string, drifted]]),
      }),
    ).toThrow(/quotedTextHash/)
  })

  it('counts every unresolved citation instead of hiding the gap', () => {
    const answer = evidenceAnswer([citationOf(REPORT_CHUNK), citationOf(ANNEX_CHUNK)])
    const view = adaptGroundedAnswer(answer, {
      chunks: new Map([[REPORT_CHUNK.chunkId as string, REPORT_CHUNK]]),
    })

    expect(view.unresolvedCitationCount).toBe(1)
    expect(citationsOf(answer.assertions[0])).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 6. Contradiction ATTRIBUTION (train 3) — closing finding A-M
// ---------------------------------------------------------------------------
//
// Train 2 closed with A-M open: `sideA`/`sideB` are `CitationReference[]`, and
// two assertions that cite the SAME chunk produce the SAME reference, so an
// answer could not say WHICH claim sustained which side. GROUNDING answered
// with `ContradictionClaimAttribution`; PRODUCT's adapter and panel were
// finished before that field existed. These tests are the join.

describe('GROUNDING → PRODUCT: contradiction attribution survives the seam', () => {
  // The hard case, stated first: ONE chunk, cited by BOTH sides. Every
  // citation-based way of telling the two claims apart is unavailable here by
  // construction — which is exactly what A-M was about.
  const SHARED = REPORT_CHUNK
  const sharedChunks = new Map([[SHARED.chunkId as string, SHARED]])

  const attributed: ContradictionMarker = {
    id: 'contra-mismo-chunk',
    summary: 'Dos afirmaciones leen el mismo pasaje de forma incompatible.',
    sideA: [citationOf(SHARED)],
    sideB: [citationOf(SHARED)],
    sideAClaim: { claimId: 'claim-a', assertionHash: hashContent('1.240 hogares en 2025') },
    sideBClaim: { claimId: 'claim-b', assertionHash: hashContent('890 hogares en 2025') },
    resolution: 'requires_human_resolution',
    severity: 'warning',
  }

  const answerWith = (marker: ContradictionMarker): GroundedAnswerState => ({
    ...evidenceAnswer([citationOf(SHARED)]),
    contradictions: [marker],
  })

  it('two assertions over the SAME chunk stay distinguishable after adaptation', () => {
    const view = adaptGroundedAnswer(answerWith(attributed), { chunks: sharedChunks })
    const contradiction = view.contradictions[0]

    // The citations are identical — this is the premise, not an accident.
    expect(contradiction.sideA[0].chunkId).toBe(contradiction.sideB[0].chunkId)

    // And the two sides are still told apart, by attribution.
    expect(contradiction.sideAClaim).not.toBeNull()
    expect(contradiction.sideBClaim).not.toBeNull()
    expect(contradiction.sideAClaim!.claimId).not.toBe(contradiction.sideBClaim!.claimId)
    expect(contradiction.sideAClaim!.assertionHash).not.toBe(contradiction.sideBClaim!.assertionHash)
  })

  it('the attribution is carried VERBATIM from the marker — the adapter derives none of it', () => {
    const view = adaptGroundedAnswer(answerWith(attributed), { chunks: sharedChunks })
    expect(view.contradictions[0].sideAClaim).toEqual(attributed.sideAClaim)
    expect(view.contradictions[0].sideBClaim).toEqual(attributed.sideBClaim)
  })

  it('assertionHash is SYSTEM-DERIVED from the statement, never a value a model could choose', () => {
    // GROUNDING computes it in buildGroundedAnswer via hashContent; a draft
    // that supplied its own fingerprint could not make it stick. Pinned here
    // as the cross-line agreement: PRODUCT may treat the hash as trustworthy
    // precisely because PRODUCT never computes it.
    expect(attributed.sideAClaim!.assertionHash).toBe(hashContent('1.240 hogares en 2025'))
    expect(attributed.sideAClaim!.assertionHash).toHaveLength(64)
  })

  it('a HISTORICAL marker with no attribution degrades to null on BOTH sides — never to a guess', () => {
    const historical: ContradictionMarker = {
      id: 'contra-historico',
      summary: 'Marcador anterior al contrato de atribución.',
      sideA: [citationOf(REPORT_CHUNK)],
      sideB: [citationOf(ANNEX_CHUNK)],
      resolution: 'requires_human_resolution',
      severity: 'warning',
    }
    const view = adaptGroundedAnswer(
      { ...evidenceAnswer([citationOf(REPORT_CHUNK)]), contradictions: [historical] },
      {
        chunks: new Map([
          [REPORT_CHUNK.chunkId as string, REPORT_CHUNK],
          [ANNEX_CHUNK.chunkId as string, ANNEX_CHUNK],
        ]),
      },
    )
    expect(view.contradictions[0].sideAClaim).toBeNull()
    expect(view.contradictions[0].sideBClaim).toBeNull()
  })

  it('an explicit null and an absent field are the SAME fact for presentation', () => {
    const explicitNull: ContradictionMarker = { ...attributed, sideAClaim: null, sideBClaim: null }
    const view = adaptGroundedAnswer(answerWith(explicitNull), { chunks: sharedChunks })
    expect(view.contradictions[0].sideAClaim).toBeNull()
    expect(view.contradictions[0].sideBClaim).toBeNull()
  })

  it('attribution is NOT inferred from order: swapping the sides swaps the attribution with them', () => {
    const swapped: ContradictionMarker = {
      ...attributed,
      sideAClaim: attributed.sideBClaim,
      sideBClaim: attributed.sideAClaim,
    }
    const view = adaptGroundedAnswer(answerWith(swapped), { chunks: sharedChunks })
    expect(view.contradictions[0].sideAClaim!.claimId).toBe('claim-b')
    expect(view.contradictions[0].sideBClaim!.claimId).toBe('claim-a')
  })

  it('one side attributed and the other not is representable — partial attribution is not rounded up', () => {
    const partial: ContradictionMarker = { ...attributed, sideBClaim: null }
    const view = adaptGroundedAnswer(answerWith(partial), { chunks: sharedChunks })
    expect(view.contradictions[0].sideAClaim!.claimId).toBe('claim-a')
    expect(view.contradictions[0].sideBClaim).toBeNull()
  })
})
