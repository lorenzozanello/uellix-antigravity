// lib/grounding/__tests__/retrieval.test.ts
// U4: offline retrieval behind interfaces — deterministic hash embeddings,
// in-memory org-scoped index, strict isolation, deletion/reindex, and the
// untrusted marking every retrieved chunk must carry.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { extractDocument } from '../extract'
import { chunkExtraction, chunkText, type DocumentChunk } from '../chunk'
import {
  DeterministicHashEmbeddingProvider,
  cosineSimilarity,
  type EmbeddingProvider,
} from '../embedding-provider'
import { InMemoryGroundingIndex } from '../retrieval'

const FIXTURES = path.resolve(process.cwd(), 'audit-fixtures', 'agua-segura')

function fixtureChunks(name: string, mime: string, evidenceId: string): DocumentChunk[] {
  const extraction = extractDocument(readFileSync(path.join(FIXTURES, name)), mime)
  return chunkExtraction(extraction, evidenceId)
}

// The agua-segura fixtures do not mention water chlorination, so the
// water-quality document for the "cloro" relevance check is a synthetic
// in-test corpus (same shape as a real monitoring CSV would have).
const CALIDAD_AGUA_CSV = [
  'punto_muestreo,fecha,cloro_residual_mgl,turbidez_ntu,resultado',
  'PM-01,2025-06-01,0.6,1.2,apto',
  'PM-02,2025-06-01,0.5,1.4,apto',
  'PM-03,2025-06-01,0.2,4.9,no apto — cloro residual bajo el minimo',
  'PM-04,2025-06-01,0.7,1.1,apto',
].join('\n')

describe('DeterministicHashEmbeddingProvider', () => {
  const provider = new DeterministicHashEmbeddingProvider()

  it('exposes id and dimensions (default 384)', () => {
    expect(provider.dimensions).toBe(384)
    expect(provider.id).toContain('deterministic-hash')
    expect(provider.id).toContain('384')
  })

  it('is deterministic: same text embeds to the identical vector', async () => {
    const [a] = await provider.embed(['el agua sale limpia del filtro'])
    const [b] = await provider.embed(['el agua sale limpia del filtro'])
    expect(a).toEqual(b)
    expect(a).toHaveLength(384)
  })

  it('produces unit-length vectors comparable by cosine', async () => {
    const [v] = await provider.embed(['cloro residual y turbidez'])
    const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0))
    expect(norm).toBeCloseTo(1, 6)
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6)
  })

  it('scores overlapping vocabulary above disjoint vocabulary', async () => {
    const [query, related, unrelated] = await provider.embed([
      'cloro residual en el agua',
      'medicion de cloro residual mensual',
      'presupuesto anual de talleres de formacion',
    ])
    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated))
  })

  it('is accent- and case-insensitive in tokenization', async () => {
    const [a, b] = await provider.embed(['COMITÉ de agua', 'comite de AGUA'])
    expect(a).toEqual(b)
  })

  it('embeds empty text to a zero vector without throwing', async () => {
    const [v] = await provider.embed([''])
    expect(v.every((x) => x === 0)).toBe(true)
  })

  it('different seeds produce different embedding spaces (and ids)', async () => {
    const other: EmbeddingProvider = new DeterministicHashEmbeddingProvider({ seed: 99 })
    expect(other.id).not.toBe(provider.id)
    const [a] = await provider.embed(['cloro'])
    const [b] = await other.embed(['cloro'])
    expect(a).not.toEqual(b)
  })
})

describe('InMemoryGroundingIndex', () => {
  let index: InMemoryGroundingIndex

  beforeEach(async () => {
    index = new InMemoryGroundingIndex(new DeterministicHashEmbeddingProvider())
    await index.addChunks(
      'org-a',
      'ev-testimonios',
      fixtureChunks('testimonios.txt', 'text/plain', 'ev-testimonios'),
    )
    await index.addChunks(
      'org-a',
      'ev-asistencia',
      fixtureChunks('asistencia.csv', 'text/csv', 'ev-asistencia'),
    )
    await index.addChunks(
      'org-a',
      'ev-calidad-agua',
      chunkText(CALIDAD_AGUA_CSV, { evidenceId: 'ev-calidad-agua' }),
    )
  })

  it('relevance sanity: "cloro" retrieves the water-quality rows first', async () => {
    const results = await index.search('org-a', 'cloro residual', 3)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].evidenceId).toBe('ev-calidad-agua')
    expect(results[0].text).toContain('cloro')
    expect(results[0].score).toBeGreaterThan(0)
  })

  it('relevance sanity: "filtro" retrieves testimonial content', async () => {
    const results = await index.search('org-a', 'el filtro de agua', 3)
    expect(results[0].evidenceId).toBe('ev-testimonios')
    expect(results[0].text.toLowerCase()).toContain('filtro')
  })

  it('relevance sanity: "talleres" retrieves attendance rows', async () => {
    const results = await index.search('org-a', 'talleres', 3)
    expect(results[0].evidenceId).toBe('ev-asistencia')
  })

  it('marks every retrieved chunk untrusted: true with a reconstructible anchor', async () => {
    const results = await index.search('org-a', 'agua', 5)
    expect(results.length).toBeGreaterThan(0)
    for (const result of results) {
      expect(result.untrusted).toBe(true)
      expect(result.anchor.evidenceId).toBe(result.evidenceId)
      expect(result.anchor.charEnd).toBeGreaterThan(result.anchor.charStart)
    }
  })

  it('respects k and returns results in stable descending score order', async () => {
    const results = await index.search('org-a', 'agua comite talleres', 2)
    expect(results.length).toBeLessThanOrEqual(2)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
    }
  })

  it('returns no results for a query sharing no vocabulary', async () => {
    // Feature hashing can collide arbitrary tokens into occupied dimensions,
    // so this uses tokens verified collision-free against the corpus under the
    // default seed — the deterministic provider keeps this stable. The general
    // irrelevance policy is a minimum-score threshold at the consumer
    // (spec §12.3), not a hard guarantee of the hash space.
    const results = await index.search('org-a', 'xyzzy frobnicar glorp', 5)
    expect(results).toEqual([])
  })

  describe('organization isolation (adversarial)', () => {
    it('never returns another org chunks, even with identical content', async () => {
      // org-b indexes the exact same water-quality document under its own id
      await index.addChunks(
        'org-b',
        'ev-b-calidad',
        chunkText(CALIDAD_AGUA_CSV, { evidenceId: 'ev-b-calidad' }),
      )

      const orgB = await index.search('org-b', 'cloro residual', 10)
      expect(orgB.length).toBeGreaterThan(0)
      for (const result of orgB) {
        expect(result.evidenceId).toBe('ev-b-calidad')
      }

      const orgA = await index.search('org-a', 'cloro residual', 10)
      for (const result of orgA) {
        expect(result.evidenceId).not.toBe('ev-b-calidad')
      }
    })

    it('an unknown org sees nothing', async () => {
      expect(await index.search('org-mallory', 'cloro agua filtro', 10)).toEqual([])
    })

    it('removal in one org does not affect another org', async () => {
      await index.addChunks(
        'org-b',
        'ev-b-calidad',
        chunkText(CALIDAD_AGUA_CSV, { evidenceId: 'ev-b-calidad' }),
      )
      expect(index.removeEvidence('org-a', 'ev-calidad-agua')).toBe(true)
      const orgA = await index.search('org-a', 'cloro residual', 5)
      expect(orgA.some((r) => r.evidenceId === 'ev-calidad-agua')).toBe(false)
      const orgB = await index.search('org-b', 'cloro residual', 5)
      expect(orgB.length).toBeGreaterThan(0)
      expect(orgB[0].evidenceId).toBe('ev-b-calidad')
    })
  })

  describe('deletion and reindex', () => {
    it('removeEvidence drops all chunks of that evidence only', async () => {
      expect(index.removeEvidence('org-a', 'ev-testimonios')).toBe(true)
      const results = await index.search('org-a', 'el filtro de agua', 5)
      expect(results.some((r) => r.evidenceId === 'ev-testimonios')).toBe(false)
      // other evidence in the same org survives
      expect((await index.search('org-a', 'cloro', 5)).length).toBeGreaterThan(0)
    })

    it('removeEvidence returns false for unknown evidence', () => {
      expect(index.removeEvidence('org-a', 'ev-nope')).toBe(false)
      expect(index.removeEvidence('org-nope', 'ev-testimonios')).toBe(false)
    })

    it('reindexEvidence replaces stale chunks atomically', async () => {
      const updated = chunkText('registro nuevo: dosificacion de cloro corregida', {
        evidenceId: 'ev-calidad-agua',
      })
      await index.reindexEvidence('org-a', 'ev-calidad-agua', updated)
      const results = await index.search('org-a', 'cloro', 5)
      const fromReindexed = results.filter((r) => r.evidenceId === 'ev-calidad-agua')
      expect(fromReindexed).toHaveLength(1)
      expect(fromReindexed[0].text).toContain('dosificacion')
      // the old PM-xx monitoring rows are gone
      expect(results.some((r) => r.text.includes('PM-01'))).toBe(false)
    })
  })
})
