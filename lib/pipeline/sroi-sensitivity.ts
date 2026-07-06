// lib/pipeline/sroi-sensitivity.ts
// Fase 1d — scenario parameter shifts (pure).
//
// The four SROI filters (deadweight, attribution, displacement, dropoff) are
// all subtractive: raising them lowers net social value. So a CONSERVATIVE
// estimate shifts every filter UP by a fixed delta, an OPTIMISTIC one shifts
// them DOWN, and BASE is the analyst's stated assumption. Applying the same
// delta uniformly across every filter gives a conservative/base/optimistic band
// on the SROI ratio without re-eliciting per-assumption ranges.

export const SCENARIO_DELTA_PP = 10
export type Scenario = 'conservative' | 'base' | 'optimistic'

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

export function scenarioFilterPct(basePct: number, scenario: Scenario, deltaPp: number = SCENARIO_DELTA_PP): number {
  if (scenario === 'base') return clamp(basePct, 0, 100)
  const delta = scenario === 'conservative' ? deltaPp : -deltaPp
  return clamp(basePct + delta, 0, 100)
}
