// tests/sroi-sensitivity.service.test.ts
// Fase 1d — scenario parameter shifts (pure).

import { describe, it, expect } from 'vitest'
import { scenarioFilterPct, SCENARIO_DELTA_PP } from '@/lib/pipeline/sroi-sensitivity'

describe('scenarioFilterPct', () => {
  it('leaves the base scenario unchanged (clamped)', () => {
    expect(scenarioFilterPct(20, 'base')).toBe(20)
    expect(scenarioFilterPct(120, 'base')).toBe(100)
  })

  it('conservative RAISES the discounting factor (lower value)', () => {
    // deadweight/attribution/displacement/dropoff all reduce net value, so a
    // conservative estimate pushes them up by the delta.
    expect(scenarioFilterPct(20, 'conservative', 10)).toBe(30)
  })

  it('optimistic LOWERS the discounting factor (higher value)', () => {
    expect(scenarioFilterPct(20, 'optimistic', 10)).toBe(10)
  })

  it('clamps conservative at 100 and optimistic at 0', () => {
    expect(scenarioFilterPct(95, 'conservative', 10)).toBe(100)
    expect(scenarioFilterPct(5, 'optimistic', 10)).toBe(0)
  })

  it('defaults the delta to SCENARIO_DELTA_PP', () => {
    expect(scenarioFilterPct(20, 'conservative')).toBe(20 + SCENARIO_DELTA_PP)
  })
})
