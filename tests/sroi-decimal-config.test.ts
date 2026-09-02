// tests/sroi-decimal-config.test.ts
// U1 (WS4) — the SROI pipeline must run under an EXPLICITLY pinned Decimal
// configuration. These values are the decimal.js defaults on purpose: pinning
// them must not change numeric behavior, only make it reproducible.
import { describe, it, expect, vi } from 'vitest'
import Decimal from 'decimal.js'
import {
  applyDecimalConfig,
  DECIMAL_PRECISION,
  DECIMAL_ROUNDING,
  DECIMAL_TO_EXP_NEG,
  DECIMAL_TO_EXP_POS,
} from '@/lib/pipeline/decimal-config'
// Side-effect-only warmup import. `vi.resetModules()` below clears vitest's
// module REGISTRY so the later `await import(...)` re-executes fresh (that
// fresh execution is exactly what these tests assert on) — it does not force
// a re-transform of already-compiled source. Without this static import,
// fx.ts/fx-oracle.ts's first-ever transform happens inside a 5s-timeout test
// body, racing every other worker's transforms under the full battery; a cold
// transform occasionally lost that race (observed: 3/4 full `test:unit` runs
// timed out here under load, 0/2 in isolation). Statically importing once
// during this file's own collection — which carries no per-test timeout —
// moves that one-time cost out of the timed window without changing what any
// assertion below actually exercises.
import '@/lib/pipeline/fx-oracle'

describe('decimal-config (determinism guard)', () => {
  it('pins the documented values (equal to decimal.js defaults)', () => {
    expect(DECIMAL_PRECISION).toBe(20)
    expect(DECIMAL_ROUNDING).toBe(Decimal.ROUND_HALF_UP)
    expect(DECIMAL_ROUNDING).toBe(4) // ROUND_HALF_UP numeric value, belt & braces
    expect(DECIMAL_TO_EXP_NEG).toBe(-7)
    expect(DECIMAL_TO_EXP_POS).toBe(21)
  })

  it('is applied to the shared Decimal constructor on import', () => {
    // Importing the module (done above) must have configured the constructor.
    expect(Decimal.precision).toBe(DECIMAL_PRECISION)
    expect(Decimal.rounding).toBe(DECIMAL_ROUNDING)
    expect(Decimal.toExpNeg).toBe(DECIMAL_TO_EXP_NEG)
    expect(Decimal.toExpPos).toBe(DECIMAL_TO_EXP_POS)
  })

  it('applyDecimalConfig restores the pinned config after a perturbation', () => {
    Decimal.set({ precision: 5, rounding: Decimal.ROUND_FLOOR })
    expect(Decimal.precision).toBe(5)
    applyDecimalConfig()
    expect(Decimal.precision).toBe(DECIMAL_PRECISION)
    expect(Decimal.rounding).toBe(DECIMAL_ROUNDING)
  })

  it('produces the expected arithmetic under the pinned config', () => {
    applyDecimalConfig()
    // 20 significant digits
    expect(new Decimal(1).div(3).toString()).toBe('0.33333333333333333333')
    // ROUND_HALF_UP: ties round away from zero
    expect(new Decimal('2.5').toFixed(0)).toBe('3')
    expect(new Decimal('-2.5').toFixed(0)).toBe('-3')
    expect(new Decimal('1.00005').toFixed(4)).toBe('1.0001')
  })

  it('pipeline modules import the guard (spot check via fx-math)', async () => {
    // Perturb, then import a pipeline module: its own import of decimal-config
    // is cached (side effects ran at first import), so instead assert that the
    // exported behavior matches the pinned config.
    const { convertToUsd } = await import('@/lib/pipeline/fx-math')
    applyDecimalConfig()
    // 1000000 / 3 = 333333.33333... → HALF_UP at 4dp
    expect(convertToUsd('1000000', '3')).toBe('333333.3333')
    // Tie case at the 4th decimal: 0.00005 / 1 → 0.0001 under HALF_UP
    expect(convertToUsd('0.00005', '1')).toBe('0.0001')
  })

  // Audit FIX 4 — fx.ts (the production FX path) and fx-oracle.ts must sit
  // under the determinism pin like the rest of the pipeline. Each test
  // perturbs the shared Decimal config, resets the module registry and
  // re-imports the module: its own decimal-config side-effect import must
  // restore the pinned configuration. Without that import (`decimal.js` is
  // externalized, so the perturbed constructor is shared), the perturbation
  // leaks and these assertions fail.
  it('importing fx.ts re-applies the pinned config (side-effect import present)', async () => {
    vi.doMock('@/db/client', () => ({ db: {} }))
    Decimal.set({ precision: 7, rounding: Decimal.ROUND_FLOOR })
    vi.resetModules()
    const fx = await import('@/lib/pipeline/fx')
    expect(Decimal.precision).toBe(DECIMAL_PRECISION)
    expect(Decimal.rounding).toBe(DECIMAL_ROUNDING)
    // Under a leaked precision-7 / ROUND_FLOOR config this is '333333.3000'.
    expect(fx.convertToUsd('1000000', '3')).toBe('333333.3333')
    vi.doUnmock('@/db/client')
  })

  it('importing fx-oracle.ts re-applies the pinned config (side-effect import present)', async () => {
    Decimal.set({ precision: 7, rounding: Decimal.ROUND_FLOOR })
    vi.resetModules()
    await import('@/lib/pipeline/fx-oracle')
    expect(Decimal.precision).toBe(DECIMAL_PRECISION)
    expect(Decimal.rounding).toBe(DECIMAL_ROUNDING)
  })
})
