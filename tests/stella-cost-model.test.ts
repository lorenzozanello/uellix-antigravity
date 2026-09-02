// tests/stella-cost-model.test.ts
// Pure cost-model cases: known model, unknown-model fallback, zero/invalid input,
// and the documented assumptions object contract that the admin UI relies on.
import { describe, expect, it } from 'vitest'
import {
  COST_MODEL_ASSUMPTIONS,
  blendedUsdPerMillionTokens,
  estimateCostUsd,
} from '@/lib/stella/cost-model'
import { STELLA_DEFAULT_GEMINI_MODEL } from '@/lib/stella/config'

describe('COST_MODEL_ASSUMPTIONS', () => {
  it('documents the default model, an as-of date and the blended input share', () => {
    expect(COST_MODEL_ASSUMPTIONS.defaultModel).toBe('gemini-3.6-flash')
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

// ---------------------------------------------------------------------------
// G1-M0 — the cost model must track the RUNTIME model target.
//
// cost-model.ts cannot import lib/stella/config.ts without breaking its purity
// contract (config reads process.env at load), so `defaultModel` is a literal
// and THIS ASSERTION is the coupling. If the runtime target moves and this
// table does not, the failure surfaces here instead of as a quietly wrong
// number in the admin table.
// ---------------------------------------------------------------------------
describe('G1-M0 — cost model tracks the runtime model target', () => {
  it('prices the runtime default model explicitly, with no fallback', () => {
    expect(COST_MODEL_ASSUMPTIONS.defaultModel).toBe(STELLA_DEFAULT_GEMINI_MODEL)
    expect(
      COST_MODEL_ASSUMPTIONS.pricesUsdPerMillionTokens[STELLA_DEFAULT_GEMINI_MODEL]
    ).toBeDefined()
  })

  it('pins the official gemini-3.6-flash Standard paid-tier prices', () => {
    // USD per 1M tokens. Output INCLUDES thinking tokens, and 3.6-flash runs at
    // thinking level `medium` by default — so this rate is what a thinking token
    // costs, not just what a JSON character costs.
    expect(COST_MODEL_ASSUMPTIONS.pricesUsdPerMillionTokens['gemini-3.6-flash']).toEqual({
      input: 1.5,
      output: 7.5,
    })
  })

  it('does NOT price 3.6-flash through the 2.5-flash fallback', () => {
    // The bug this prevents: an unpriced 3.6-flash silently inheriting the
    // previous model's much cheaper rates and looking calibrated.
    expect(blendedUsdPerMillionTokens('gemini-3.6-flash')).not.toBeCloseTo(
      blendedUsdPerMillionTokens('gemini-2.5-flash'),
      6
    )
  })

  it('still prices historical 2.5-flash ledger rows at 2.5-flash rates', () => {
    // stella_interactions is append-only; rows written before G1-M0 carry
    // model_used = 'gemini-2.5-flash' and must not be repriced at today's rates.
    expect(COST_MODEL_ASSUMPTIONS.pricesUsdPerMillionTokens['gemini-2.5-flash']).toEqual({
      input: 0.3,
      output: 2.5,
    })
  })

  it('degrades an unknown model UPWARD, never to a silent zero', () => {
    // The existing contract (unknown -> default) is kept. What is asserted here
    // is the direction: since the default is now the current, more expensive
    // model, an unrecognised legacy id overstates rather than understates.
    const unknown = blendedUsdPerMillionTokens('gemini-2.0-flash')
    expect(unknown).toBe(blendedUsdPerMillionTokens(STELLA_DEFAULT_GEMINI_MODEL))
    expect(unknown).toBeGreaterThan(blendedUsdPerMillionTokens('gemini-2.5-flash'))
    expect(estimateCostUsd(1_000_000, 'gemini-2.0-flash')).toBeGreaterThan(0)
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
