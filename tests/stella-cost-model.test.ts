// tests/stella-cost-model.test.ts
// Pure cost-model cases: known model, unknown-model fallback, zero/invalid input,
// and the documented assumptions object contract that the admin UI relies on.
import { describe, expect, it } from 'vitest'
import {
  COST_MODEL_ASSUMPTIONS,
  blendedUsdPerMillionTokens,
  estimateCostUsd,
} from '@/lib/stella/cost-model'

describe('COST_MODEL_ASSUMPTIONS', () => {
  it('documents the default model, an as-of date and the blended input share', () => {
    expect(COST_MODEL_ASSUMPTIONS.defaultModel).toBe('gemini-2.5-flash')
    expect(COST_MODEL_ASSUMPTIONS.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(COST_MODEL_ASSUMPTIONS.assumedInputShare).toBeGreaterThan(0)
    expect(COST_MODEL_ASSUMPTIONS.assumedInputShare).toBeLessThan(1)
    expect(COST_MODEL_ASSUMPTIONS.limitation).toContain('tokens_used')
  })

  it('has pricing for the default model', () => {
    expect(
      COST_MODEL_ASSUMPTIONS.pricesUsdPerMillionTokens[COST_MODEL_ASSUMPTIONS.defaultModel]
    ).toBeDefined()
  })
})

describe('blendedUsdPerMillionTokens', () => {
  it('blends input/output prices with the assumed input share', () => {
    const { input, output } =
      COST_MODEL_ASSUMPTIONS.pricesUsdPerMillionTokens['gemini-2.5-flash']
    const share = COST_MODEL_ASSUMPTIONS.assumedInputShare
    const expected = input * share + output * (1 - share)

    expect(blendedUsdPerMillionTokens('gemini-2.5-flash')).toBeCloseTo(expected, 10)
  })

  it('falls back to the default model pricing for unknown models', () => {
    expect(blendedUsdPerMillionTokens('gemini-9.9-unobtainium')).toBe(
      blendedUsdPerMillionTokens(COST_MODEL_ASSUMPTIONS.defaultModel)
    )
  })

  it('uses the default model when no model is given', () => {
    expect(blendedUsdPerMillionTokens()).toBe(
      blendedUsdPerMillionTokens(COST_MODEL_ASSUMPTIONS.defaultModel)
    )
  })
})

describe('estimateCostUsd', () => {
  it('returns 0 for zero tokens', () => {
    expect(estimateCostUsd(0)).toBe(0)
  })

  it('returns 0 for negative or non-finite token counts (defensive, never NaN)', () => {
    expect(estimateCostUsd(-100)).toBe(0)
    expect(estimateCostUsd(Number.NaN)).toBe(0)
    expect(estimateCostUsd(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('prices exactly one million tokens at the blended per-million rate', () => {
    expect(estimateCostUsd(1_000_000, 'gemini-2.5-flash')).toBeCloseTo(
      blendedUsdPerMillionTokens('gemini-2.5-flash'),
      10
    )
  })

  it('scales linearly with token count', () => {
    const one = estimateCostUsd(250_000)
    expect(estimateCostUsd(500_000)).toBeCloseTo(one * 2, 10)
  })

  it('unknown model falls back to default-model pricing instead of throwing', () => {
    expect(estimateCostUsd(1_000_000, 'some-future-model')).toBeCloseTo(
      estimateCostUsd(1_000_000, COST_MODEL_ASSUMPTIONS.defaultModel),
      10
    )
  })
})
