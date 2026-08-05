// lib/grounding/__tests__/r7.test.ts
// GROUNDING line — R7: source-diversity floor calibration (grounding train 3).
//
// R7 (docs/ops/workstreams/GROUNDING.md, tren 2): "la diversidad de fuentes
// puede desplazar al mejor candidato" — DEFAULT_MIN_DISTINCT_SOURCES: 2 can
// swap out the single highest-scoring chunk to make room for a second source.
// That trade was intentional (a one-source answer cannot surface a
// contradiction) but UNEVALUATED: no labelled set exists to say whether it
// improves answers in practice.
//
// PROVISIONAL DECISION (this train, not final, not claimed optimal):
//   KEEP the existing behaviour — greedy top-K, then repair only when the
//   floor is genuinely missed, floor = min(minDistinctSources, topK) — as
//   implemented in retrieve.ts's selectWithDiversity. Nothing here changes
//   that algorithm. What this suite adds is the six-scenario evidence GR-CAP-002's
//   train asked for, so the next calibration pass (with a labelled set) has a
//   fixed set of cases to compare against instead of re-deriving them.
//
// Every scenario below is deterministic and offline: fixed corpora, the
// lexical scorer, no network.

import { describe, it, expect } from 'vitest'
import { buildGroundedAnswer } from '../retrieve'
import { InMemoryChunkRepository, enforceRepositoryScope, retrieveGroundedChunks } from '../retrieve'
import { chunkFixture, scopeA1 } from './fixtures'

const retrieve = (chunks: readonly ReturnType<typeof chunkFixture>[], text: string, options = {}) =>
  retrieveGroundedChunks(enforceRepositoryScope(new InMemoryChunkRepository(chunks)), scopeA1, text, options)

describe('R7 — one excellent source', () => {
  it('does not fabricate a second source when only one evidence item is relevant at all', async () => {
    const excellent = chunkFixture('El informe registra 120 beneficiarios del programa de agua potable.', {
      evidenceId: 'ev-excellent',
      chunkIndex: 0,
    })
    const unrelated = chunkFixture('Anexo metodológico sobre el cálculo del valor presente neto.', {
      evidenceId: 'ev-unrelated',
      chunkIndex: 0,
    })
    const result = await retrieve([excellent, unrelated], 'beneficiarios del programa de agua potable', {
      topK: 2,
      minDistinctSources: 2,
    })

    // The floor is a floor, not a quota: unrelated content is never promoted
    // just to hit a source count.
    expect(result.candidates.map((c) => c.chunk.chunkId)).toEqual([excellent.chunkId])
    expect(result.distinctSources).toBe(1)
    expect(result.exclusions.some((e) => e.reason === 'displaced_for_source_diversity')).toBe(false)
  })
})

describe('R7 — two mediocre sources', () => {
  it('keeps both when two weaker-but-relevant sources already span the floor without repair', async () => {
    // Each chunk answers half the query and neither is top-of-scale, but they
    // come from two different evidence items, so the floor is met with no swap.
    //
    // Every query term appears in at least one chunk on purpose. A term absent
    // from the WHOLE candidate set still enlarges the scorer's normalizing
    // denominator (see LexicalChunkScorer: `maximum` sums idf over all query
    // terms), which depresses every score at once — an earlier draft of this
    // fixture pushed the second source under DEFAULT_RETRIEVAL_MIN_SCORE and
    // the test then "showed" a single source for a reason that had nothing to
    // do with diversity.
    const mediocreA = chunkFixture('Los hogares del programa fueron registrados.', {
      evidenceId: 'ev-a',
      chunkIndex: 0,
    })
    const mediocreB = chunkFixture('La cobertura de la vereda fue medida.', {
      evidenceId: 'ev-b',
      chunkIndex: 0,
    })
    const result = await retrieve([mediocreA, mediocreB], 'hogares programa cobertura vereda', {
      topK: 2,
      minDistinctSources: 2,
    })

    expect(result.distinctSources).toBe(2)
    expect(result.exclusions.some((e) => e.reason === 'displaced_for_source_diversity')).toBe(false)
    // Genuinely mediocre: above the retrieval threshold, below the `high`
    // presentation bucket (RELEVANCE_THRESHOLDS: high >= 0.4, medium >= 0.2).
    for (const candidate of result.candidates) {
      expect(candidate.score).toBeGreaterThan(0.15)
      expect(candidate.score).toBeLessThan(0.4)
    }
  })
})

describe('R7 — potential contradiction: diversity is what makes it visible at all', () => {
  it('a single dominant source would hide the second figure; the floor surfaces it', async () => {
    // ev-report owns the two best-matching passages — BOTH cover all four
    // query terms, so they outrank ev-audit, which covers two. Without the
    // floor, topK: 2 returns ev-report twice: no second source, so
    // buildGroundedAnswer could never be handed a second side to contradict
    // the first with.
    const reportA = chunkFixture('El informe registra 120 beneficiarios de agua potable en la vereda.', {
      evidenceId: 'ev-report',
      chunkIndex: 0,
    })
    const reportB = chunkFixture('El informe detalla beneficiarios de agua potable por vereda.', {
      evidenceId: 'ev-report',
      chunkIndex: 1,
    })
    const audit = chunkFixture('La auditoría externa contabilizó 90 beneficiarios de agua.', {
      evidenceId: 'ev-audit',
      chunkIndex: 0,
    })

    const withoutFloor = await retrieve([reportA, reportB, audit], 'beneficiarios agua potable vereda', {
      topK: 2,
      minDistinctSources: 1,
    })
    expect(withoutFloor.distinctSources).toBe(1)

    const withFloor = await retrieve([reportA, reportB, audit], 'beneficiarios agua potable vereda', {
      topK: 2,
      minDistinctSources: 2,
    })
    expect(withFloor.distinctSources).toBe(2)
    expect(withFloor.candidates.map((c) => c.chunk.evidenceId)).toContain('ev-audit')

    // With the second source present, a drafted contradiction between the two
    // figures can actually be constructed and validated end to end.
    const outcome = buildGroundedAnswer(withFloor, {
      claims: [{ kind: 'evidence', statement: '120 beneficiarios según el informe.', chunkIds: [reportA.chunkId] }],
      contradictions: [
        {
          summary: 'Dos cifras de beneficiarios de agua potable',
          sideAChunkIds: [reportA.chunkId],
          sideBChunkIds: [audit.chunkId],
        },
      ],
    })
    expect(outcome.kind).toBe('contradictory_evidence')
    expect(outcome.answer.contradictions).toHaveLength(1)
  })
})

describe('R7 — topK: 1', () => {
  it('yields the floor to topK rather than thrash the single slot', async () => {
    const dominant = chunkFixture('El informe registra 120 beneficiarios de agua potable.', {
      evidenceId: 'ev-dominant',
      chunkIndex: 0,
    })
    const secondary = chunkFixture('El censo de beneficiarios de agua potable fue actualizado.', {
      evidenceId: 'ev-secondary',
      chunkIndex: 0,
    })
    const result = await retrieve([dominant, secondary], 'beneficiarios agua potable', {
      topK: 1,
      minDistinctSources: 2,
    })

    expect(result.candidates).toHaveLength(1)
    expect(result.exclusions.some((e) => e.reason === 'displaced_for_source_diversity')).toBe(false)
  })
})

describe('R7 — topK: 2', () => {
  it('repairs the floor by displacing the weaker of the dominant source\'s two chunks', async () => {
    const strongA = chunkFixture('El informe registra 120 beneficiarios de agua potable en la vereda.', {
      evidenceId: 'ev-dominant',
      chunkIndex: 0,
    })
    const strongB = chunkFixture('El informe de agua potable detalla beneficiarios por vereda.', {
      evidenceId: 'ev-dominant',
      chunkIndex: 1,
    })
    const weakerOtherSource = chunkFixture('Beneficiarios de agua fueron mencionados brevemente.', {
      evidenceId: 'ev-secondary',
      chunkIndex: 0,
    })
    const result = await retrieve([strongA, strongB, weakerOtherSource], 'beneficiarios agua potable vereda', {
      topK: 2,
      minDistinctSources: 2,
    })

    expect(result.distinctSources).toBe(2)
    const displaced = result.exclusions.find((e) => e.reason === 'displaced_for_source_diversity')
    expect(displaced).toBeTruthy()
    // The displaced chunk scored higher than what was kept in its place —
    // that is the trade R7 records, not hides.
    expect(displaced?.evidenceId).toBe('ev-dominant')
  })
})

describe('R7 — a query with only one source available at all', () => {
  it('abandons the floor instead of inventing a source that does not exist', async () => {
    const onlySourceA = chunkFixture('El informe registra 120 beneficiarios de agua potable.', {
      evidenceId: 'ev-only',
      chunkIndex: 0,
    })
    const onlySourceB = chunkFixture('El mismo informe detalla la cobertura de agua potable.', {
      evidenceId: 'ev-only',
      chunkIndex: 1,
    })
    const result = await retrieve([onlySourceA, onlySourceB], 'beneficiarios agua potable cobertura', {
      topK: 2,
      minDistinctSources: 3,
    })

    expect(result.candidates).toHaveLength(2)
    expect(result.distinctSources).toBe(1)
    expect(result.exclusions.some((e) => e.reason === 'displaced_for_source_diversity')).toBe(false)
  })
})
