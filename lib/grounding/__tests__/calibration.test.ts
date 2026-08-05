// lib/grounding/__tests__/calibration.test.ts
// GROUNDING line — presentation buckets over a numeric score.
//
// The thresholds are FIRST-PASS and unmeasured (workstream risk R4). What the
// tests pin down is therefore not that the numbers are right — no test can
// establish that — but that they are versioned, that the boundaries behave
// exactly as documented, and that bucketing never destroys the number it was
// derived from. Those three properties are what make recalibration possible
// later; the values themselves are expected to move.

import { describe, it, expect } from 'vitest'
import {
  RELEVANCE_THRESHOLDS,
  RELEVANCE_THRESHOLDS_VERSION,
  presentRelevance,
  relevanceBucket,
} from '../retrieve'
import {
  InMemoryChunkRepository,
  enforceRepositoryScope,
  retrieveGroundedChunks,
} from '../retrieve'
import { chunkFixture, scopeA1 } from './fixtures'

describe('relevance buckets', () => {
  it('is versioned, so a recalibration is visible in stored data', () => {
    expect(RELEVANCE_THRESHOLDS_VERSION).toMatch(/^grounding-relevance-/)
  })

  it('orders the thresholds', () => {
    expect(RELEVANCE_THRESHOLDS.high).toBeGreaterThan(RELEVANCE_THRESHOLDS.medium)
    expect(RELEVANCE_THRESHOLDS.medium).toBeGreaterThan(0)
  })

  it('treats each threshold as inclusive at its exact boundary', () => {
    expect(relevanceBucket(RELEVANCE_THRESHOLDS.high)).toBe('high')
    expect(relevanceBucket(RELEVANCE_THRESHOLDS.medium)).toBe('medium')
  })

  it('drops to the lower bucket just below each boundary', () => {
    expect(relevanceBucket(RELEVANCE_THRESHOLDS.high - Number.EPSILON)).toBe('medium')
    expect(relevanceBucket(RELEVANCE_THRESHOLDS.medium - Number.EPSILON)).toBe('low')
  })

  it('buckets the extremes', () => {
    expect(relevanceBucket(1)).toBe('high')
    expect(relevanceBucket(0)).toBe('low')
  })

  it('rejects a score outside [0, 1] instead of bucketing it', () => {
    // A score off the scale means the scorer changed and the thresholds did
    // not. Silently clamping would hide exactly that.
    expect(() => relevanceBucket(1.5)).toThrow(/\[0, 1\]/)
    expect(() => relevanceBucket(-0.1)).toThrow(/\[0, 1\]/)
  })
})

describe('presentRelevance keeps the number', () => {
  it('returns the original score alongside the bucket', async () => {
    const chunk = chunkFixture('El informe registra 120 beneficiarios del programa de agua.')
    const retrieval = await retrieveGroundedChunks(
      enforceRepositoryScope(new InMemoryChunkRepository([chunk])),
      scopeA1,
      'beneficiarios agua',
    )
    const presented = presentRelevance(retrieval.candidates[0], retrieval)

    expect(presented.score).toBe(retrieval.candidates[0].score)
    expect(presented.bucket).toBe(relevanceBucket(retrieval.candidates[0].score))
  })

  it('carries the strategy and scorer, because a score is comparable only within one', async () => {
    const chunk = chunkFixture('El informe registra 120 beneficiarios del programa de agua.')
    const retrieval = await retrieveGroundedChunks(
      enforceRepositoryScope(new InMemoryChunkRepository([chunk])),
      scopeA1,
      'beneficiarios agua',
    )
    const presented = presentRelevance(retrieval.candidates[0], retrieval)

    expect(presented.strategy).toBe('lexical')
    expect(presented.scorerId).toBe(retrieval.scorerId)
    expect(presented.thresholdsVersion).toBe(RELEVANCE_THRESHOLDS_VERSION)
  })
})
