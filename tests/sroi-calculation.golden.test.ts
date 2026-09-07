// tests/sroi-calculation.golden.test.ts
// U2 (WS4) — golden tests pinning EXACT engine output strings, plus
// property-style invariants. If any pinned string changes, the deterministic
// engine's numeric behavior changed: that is a breaking event for audit-ready
// runs and must be an explicit, versioned decision — never an accident.
//
// Expected values were re-derived independently from the documented formulas
// (see docs / snapshot formulaNotes) with decimal.js at the pinned config
// (precision 20, ROUND_HALF_UP), then hardcoded here.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'
import Decimal from 'decimal.js'

// sroi-calculation.ts pulls the DB client and auth at module load — stub them;
// runDeterministicCalc itself is pure.
vi.mock('@/db/client', () => ({ db: {} }))
vi.mock('@/lib/auth/session', () => ({ requireOrganizationAccess: vi.fn() }))
vi.mock('@/lib/auth/permissions', () => ({ hasRole: vi.fn() }))
vi.mock('@/lib/audit/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/logger')>()
  return { ...actual, logAuditAction: vi.fn() }
})

import { runDeterministicCalc, applyMaterialityExclusion, type EngineOptions } from '@/lib/pipeline/sroi-calculation'
import { convertToUsd } from '@/lib/pipeline/fx-math'
import { applyDecimalConfig } from '@/lib/pipeline/decimal-config'

// ── Fixture builders (minimal shapes, cast to the engine's drizzle types) ────

function inv(amountUsd: string | null, funderId = 'funder-1') {
  return { id: `inv-${funderId}`, funderId, amountUsd } as any
}

interface LineOpts {
  id?: string
  outcomeId?: string
  quantity?: string
  proxyUsd?: string
  deadweightPct?: string | null
  attributionPct?: string | null
  displacementPct?: string | null
  dropoffPct?: string | null
  durationYears?: number
}

function line(opts: LineOpts = {}) {
  const id = opts.id ?? 'a1'
  return {
    assignment: { id, outcomeId: opts.outcomeId ?? 'out-1', proxyId: `proxy-${id}` },
    input: { quantity: opts.quantity ?? '10', unit: 'units' },
    filterSet: {
      deadweightPct: opts.deadweightPct ?? null,
      attributionPct: opts.attributionPct ?? null,
      displacementPct: opts.displacementPct ?? null,
      dropoffPct: opts.dropoffPct ?? null,
      durationYears: opts.durationYears ?? 1,
    },
    // R-B2-05 (AG-B2-1) — the engine reads value_usd from the BOUND version
    // only. The live row deliberately carries a different figure so a
    // fallback to it would break every pinned golden string.
    proxy: { id: `proxy-${id}`, valueUsd: '999999' },
    proxyVersion: { id: `version-${id}`, financialProxyId: `proxy-${id}`, reviewStatus: 'approved', valueUsd: opts.proxyUsd ?? '100' },
    outcome: { id: opts.outcomeId ?? 'out-1' },
  } as any
}

// W2-B3 completeness (AG-B3-4): the engine now names its filter semantics.
// These historical goldens build lines with NULL filters by default and pin
// the legacy coercion — that is exactly the labelled 'preliminary' path
// (calculateSroiPreview / calculateSroiScenarios). The 'authoritative' path
// (calculateAndPersistSroiRun) refuses a NULL filter outright — pinned in
// the "AG-B3-4 authoritative filter semantics" block below.
const run = (
  investments: any[],
  lines: any[],
  allocations: any[] = [],
  funders: any[] = [],
  discountRatePct: string | null = null,
  options: EngineOptions = { filterSemantics: 'preliminary' },
) => runDeterministicCalc(investments, lines, allocations, funders, discountRatePct, options)

// ── Golden scenarios (exact strings pinned) ──────────────────────────────────

describe('Golden: exact engine output strings', () => {
  it('G1 multi-year with dropoff + NPV discounting', () => {
    // 25 × 320.50 = 8012.5/yr · (1-.15)(1-.10)(1-.05) · Σ y=0..4 (.88^y / 1.08^y)
    const r = run(
      [inv('10000')],
      [line({
        quantity: '25', proxyUsd: '320.50',
        deadweightPct: '15', attributionPct: '10', displacementPct: '5',
        dropoffPct: '12', durationYears: 5,
      })],
      [], [], '8',
    )
    expect(r.totalInvestmentExact).toBe('10000.0000')
    expect(r.grossSocialValueExact).toBe('40062.5000')
    expect(r.netSocialValueExact).toBe('20150.8209')
    expect(r.sroiRatioExact).toBe('2.015082')
    expect(r.lineItems[0].adjustedValueExact).toBe('20150.8209')
    expect(r.currency).toBe('USD')
  })

  it('G2 COP investment through the FX conversion path', () => {
    // 40,000,000 COP at TRM 4000.1234 COP/USD → 9999.6915 USD (HALF_UP, 4dp)
    const amountUsd = convertToUsd('40000000', '4000.1234')
    expect(amountUsd).toBe('9999.6915')
    const r = run(
      [inv(amountUsd)],
      [line({ quantity: '12', proxyUsd: '150.75', deadweightPct: '20' })],
    )
    expect(r.totalInvestmentExact).toBe('9999.6915')
    expect(r.grossSocialValueExact).toBe('1809.0000')
    expect(r.netSocialValueExact).toBe('1447.2000')
    expect(r.sroiRatioExact).toBe('0.144724')
  })

  it('G3 funder attribution breakdown', () => {
    const r = run(
      [inv('600', 'funder-1'), inv('400', 'funder-2')],
      [line({ quantity: '10', proxyUsd: '100' })],
      [
        { outcomeId: 'out-1', funderId: 'funder-1', allocationPct: '60', status: 'active' },
        { outcomeId: 'out-1', funderId: 'funder-2', allocationPct: '25', status: 'active' },
      ] as any,
      [
        { id: 'funder-1', name: 'Fundación A', funderType: 'foundation' },
        { id: 'funder-2', name: 'Privado B', funderType: 'private' },
      ] as any,
    )
    expect(r.sroiRatioExact).toBe('1.000000')
    const byId = Object.fromEntries(r.fundersBreakdown.map(f => [f.funderId, f]))
    expect(byId['funder-1'].investmentUsd).toBe('600.0000')
    expect(byId['funder-1'].attributedNsvUsd).toBe('600.0000')
    expect(byId['funder-1'].sroiRatio).toBe('1.000000')
    expect(byId['funder-2'].investmentUsd).toBe('400.0000')
    expect(byId['funder-2'].attributedNsvUsd).toBe('250.0000')
    expect(byId['funder-2'].sroiRatio).toBe('0.625000')
    expect(r.unattributedNsvUsd).toBe('150.0000')
  })

  it('G4 sensitivity triple (uniform ±10pp shift, inlined literals — FIBIU-18 supersedes scenarioFilterPct, expected outputs unchanged)', () => {
    // Literals below are scenarioFilterPct(base, scenario, 10) inlined, base =
    // { deadweightPct: 20, attributionPct: 10, displacementPct: 0, dropoffPct: 5 }:
    //   base:         unchanged            -> 20, 10, 0, 5
    //   conservative: +10pp, clamp 0..100  -> 30, 20, 10, 15
    //   optimistic:   -10pp, clamp 0..100  -> 10, 0, 0, 0
    const scenarioFilters: Record<'base' | 'conservative' | 'optimistic', { deadweightPct: string; attributionPct: string; displacementPct: string; dropoffPct: string }> = {
      base: { deadweightPct: '20', attributionPct: '10', displacementPct: '0', dropoffPct: '5' },
      conservative: { deadweightPct: '30', attributionPct: '20', displacementPct: '10', dropoffPct: '15' },
      optimistic: { deadweightPct: '10', attributionPct: '0', displacementPct: '0', dropoffPct: '0' },
    }
    const mk = (scenario: 'conservative' | 'base' | 'optimistic') =>
      run(
        [inv('1000')],
        [line({
          quantity: '10', proxyUsd: '100', durationYears: 3,
          ...scenarioFilters[scenario],
        })],
      )
    expect(mk('base').sroiRatioExact).toBe('2.053800')
    expect(mk('conservative').sroiRatioExact).toBe('1.296540')
    expect(mk('optimistic').sroiRatioExact).toBe('2.700000')
    expect(mk('base').netSocialValueExact).toBe('2053.8000')
    expect(mk('conservative').netSocialValueExact).toBe('1296.5400')
    expect(mk('optimistic').netSocialValueExact).toBe('2700.0000')
  })

  it('G5 zero-investment guard throws (never divides by zero)', () => {
    expect(() => run([inv('0')], [line()])).toThrow('Investment amount must be > 0')
    expect(() => run([], [line()])).toThrow('Investment amount must be > 0')
    expect(() => run([inv(null)], [line()])).toThrow('Investment amount must be > 0')
  })

  it('G6 saturating clamp: filters cap at 100%, duration caps at 50', () => {
    const saturated = run([inv('1000')], [line({ deadweightPct: '150' })])
    expect(saturated.netSocialValueExact).toBe('0.0000')
    expect(saturated.sroiRatioExact).toBe('0.000000')
    expect(saturated.lineItems[0].deadweightPct).toBe(100)

    const clamped = run([inv('1000')], [line({ durationYears: 60 })])
    expect(clamped.lineItems[0].durationYears).toBe(50)
    expect(clamped.grossSocialValueExact).toBe('50000.0000') // 1000/yr × 50
    expect(clamped.netSocialValueExact).toBe('50000.0000')

    const negative = run([inv('1000')], [line({ attributionPct: '-20' })])
    expect(negative.lineItems[0].attributionPct).toBe(0)
    expect(negative.netSocialValueExact).toBe('1000.0000')
  })
})

// ── Property-style invariants ────────────────────────────────────────────────

describe('Property: ratio monotonicity in discount filters', () => {
  const sweep = (key: 'deadweightPct' | 'attributionPct' | 'displacementPct') =>
    [0, 10, 25, 40, 60, 90].map(pct =>
      run([inv('1000')], [line({ [key]: String(pct) })]).sroiRatio,
    )

  it.each(['deadweightPct', 'attributionPct', 'displacementPct'] as const)(
    'more %s ⇒ strictly lower ratio',
    (key) => {
      const ratios = sweep(key)
      for (let i = 1; i < ratios.length; i++) {
        expect(ratios[i]).toBeLessThan(ratios[i - 1]!)
      }
    },
  )

  it('a higher discount rate ⇒ lower net social value (multi-year)', () => {
    const nets = ['0', '5', '10', '20'].map(disc =>
      run([inv('1000')], [line({ durationYears: 5 })], [], [], disc).netSocialValue,
    )
    for (let i = 1; i < nets.length; i++) {
      expect(nets[i]).toBeLessThan(nets[i - 1])
    }
  })

  it('a higher dropoff ⇒ lower net social value (multi-year)', () => {
    const nets = ['0', '10', '30', '70'].map(dr =>
      run([inv('1000')], [line({ durationYears: 4, dropoffPct: dr })]).netSocialValue,
    )
    for (let i = 1; i < nets.length; i++) {
      expect(nets[i]).toBeLessThan(nets[i - 1])
    }
  })
})

describe('Property: currency invariance (COP path vs direct USD)', () => {
  it('an evenly-dividing rate matches the direct-USD run exactly', () => {
    const viaCop = run([inv(convertToUsd('10000000', '4000'))], [line()])
    const direct = run([inv('2500')], [line()])
    expect(viaCop.sroiRatioExact).toBe(direct.sroiRatioExact)
    expect(viaCop.netSocialValueExact).toBe(direct.netSocialValueExact)
  })

  it('a non-even rate matches within 4dp rounding tolerance', () => {
    const rate = '3999.7'
    const amountUsd = convertToUsd('10000000', rate) // rounded to 4dp
    const exactUsd = new Decimal('10000000').div(rate) // full precision
    const viaCop = run([inv(amountUsd)], [line()])
    const direct = run([inv(exactUsd.toString())], [line()])
    expect(Math.abs(viaCop.sroiRatio! - direct.sroiRatio!)).toBeLessThan(1e-4)
    expect(Math.abs(viaCop.totalInvestment - direct.totalInvestment)).toBeLessThan(1e-3)
  })
})

describe('Property: rounding + determinism stability', () => {
  const build = () => run(
    [inv('3333.3333')],
    [
      line({ id: 'a1', quantity: '7', proxyUsd: '133.33', dropoffPct: '25', durationYears: 4 }),
      line({ id: 'a2', outcomeId: 'out-2', quantity: '3', proxyUsd: '99.99', deadweightPct: '33' }),
    ],
    [], [], '7.5',
  )

  it('money strings carry exactly MONEY_DP=4 decimals, ratio RATIO_DP=6', () => {
    const r = build()
    const money = /^-?\d+\.\d{4}$/
    expect(r.totalInvestmentExact).toMatch(money)
    expect(r.grossSocialValueExact).toMatch(money)
    expect(r.netSocialValueExact).toMatch(money)
    expect(r.unattributedNsvUsd).toMatch(money)
    expect(r.sroiRatioExact).toMatch(/^-?\d+\.\d{6}$/)
    for (const li of r.lineItems) {
      expect(li.grossValueExact).toMatch(money)
      expect(li.adjustedValueExact).toMatch(money)
    }
  })

  it('two identical runs produce byte-identical results (determinism)', () => {
    expect(build()).toEqual(build())
  })

  it('stays deterministic even after external Decimal config perturbation + re-apply', () => {
    const before = build()
    Decimal.set({ precision: 40, rounding: Decimal.ROUND_FLOOR })
    applyDecimalConfig() // production entry points import decimal-config first
    expect(build()).toEqual(before)
  })
})

describe('Property: duration clamp bounds', () => {
  it('duration below 1 behaves exactly as 1', () => {
    const zero = run([inv('1000')], [line({ durationYears: 0 })])
    const one = run([inv('1000')], [line({ durationYears: 1 })])
    expect(zero.netSocialValueExact).toBe(one.netSocialValueExact)
    expect(zero.lineItems[0].durationYears).toBe(1)
  })

  it('duration above 50 behaves exactly as 50', () => {
    const over = run([inv('1000')], [line({ durationYears: 51 })])
    const cap = run([inv('1000')], [line({ durationYears: 50 })])
    expect(over.netSocialValueExact).toBe(cap.netSocialValueExact)
    expect(over.grossSocialValueExact).toBe(cap.grossSocialValueExact)
  })
})

describe('Property: drop-off is geometric', () => {
  it('n-year stream equals base × Σ (1-d)^y, pinned exact string', () => {
    // 7 × 133.33 = 933.31/yr, d = 25%, 4 years → 933.31 × (1+.75+.5625+.421875)
    const r = run([inv('1000')], [line({ quantity: '7', proxyUsd: '133.33', dropoffPct: '25', durationYears: 4 })])
    expect(r.netSocialValueExact).toBe('2552.0195')

    const base = new Decimal('7').mul('133.33')
    let expected = new Decimal(0)
    for (let y = 0; y < 4; y++) expected = expected.plus(base.mul(new Decimal('0.75').pow(y)))
    expect(r.netSocialValueExact).toBe(expected.toFixed(4))
  })
})

// ── W2-B3 completeness (docs/ops/wave2/W2_B3_TEST_MANIFEST_v2.json) ──────────
// Materiality (AG-B3-1), no-ratio (AG-B3-2) and filter semantics (AG-B3-4)
// pinned at the pure engine, exactly like the goldens above.

const AUTHORITATIVE: EngineOptions = { filterSemantics: 'authoritative' }
const PRELIMINARY: EngineOptions = { filterSemantics: 'preliminary' }
const ZERO_FILTERS = { deadweightPct: '0', attributionPct: '0', displacementPct: '0', dropoffPct: '0', durationYears: 1 }

const classified = (opts: LineOpts & { classification?: 'material' | 'not_material' | null }) => {
  const l = line(opts)
  l.outcome = { id: opts.outcomeId ?? 'out-1', materialityClassification: opts.classification ?? null }
  return l
}

describe('AG-B3-1 materiality exclusion (P-MAT-1 / N-MAT-1 / N-MAT-2 / M-MAT-1)', () => {
  it('P-MAT-1: a material outcome contributes exactly as before (golden strings unchanged)', () => {
    const r = run([inv('1000')], [classified({ ...ZERO_FILTERS, classification: 'material' })], [], [], null, AUTHORITATIVE)
    expect(r.grossSocialValueExact).toBe('1000.0000')
    expect(r.netSocialValueExact).toBe('1000.0000')
    expect(r.sroiRatioExact).toBe('1.000000')
    expect(r.monetizedOutcomeIds).toEqual(['out-1'])
    expect(r.materialityUnclassifiedOutcomeIds).toEqual([])
    expect(r.skippedAssignments).toEqual([])
  })

  it('N-MAT-1 / M-MAT-1: a not_material outcome contributes exactly zero and is itemized with its reason (removing the exclusion changes gross/net/ratio and drops the skip entry)', () => {
    const withExcluded = run(
      [inv('1000')],
      [
        classified({ id: 'a1', outcomeId: 'out-1', ...ZERO_FILTERS, classification: 'material' }),
        classified({ id: 'a2', outcomeId: 'out-2', quantity: '50', proxyUsd: '200', ...ZERO_FILTERS, classification: 'not_material' }),
      ],
      [], [], null, AUTHORITATIVE,
    )
    const without = run([inv('1000')], [classified({ id: 'a1', outcomeId: 'out-1', ...ZERO_FILTERS, classification: 'material' })], [], [], null, AUTHORITATIVE)
    // Exactly the same numbers as if the not_material line never existed...
    expect(withExcluded.grossSocialValueExact).toBe(without.grossSocialValueExact)
    expect(withExcluded.netSocialValueExact).toBe(without.netSocialValueExact)
    expect(withExcluded.sroiRatioExact).toBe(without.sroiRatioExact)
    expect(withExcluded.sroiRatioExact).toBe('1.000000')
    // ...but the exclusion is retained in traceability, never silently dropped.
    expect(withExcluded.lineItems.map((li) => li.outcomeId)).toEqual(['out-1'])
    expect(withExcluded.skippedAssignments).toEqual([{ outcomeId: 'out-2', reason: 'not_material' }])
    expect(withExcluded.monetizedOutcomeIds).toEqual(['out-1'])
    // Mutation sensitivity: had the not_material line been summed, the ratio
    // would have been (1000 + 50*200)/1000 = 11.000000 - this pin catches it.
    expect(withExcluded.sroiRatioExact).not.toBe('11.000000')
  })

  it('N-MAT-2: an unclassified (NULL) outcome may contribute but NEVER silently - it is itemized', () => {
    const r = run([inv('1000')], [classified({ ...ZERO_FILTERS, classification: null })], [], [], null, AUTHORITATIVE)
    expect(r.sroiRatioExact).toBe('1.000000')
    expect(r.materialityUnclassifiedOutcomeIds).toEqual(['out-1'])
    // A legacy line with no classification on its outcome row is unclassified too (never treated as material).
    const legacy = run([inv('1000')], [line(ZERO_FILTERS)], [], [], null, AUTHORITATIVE)
    expect(legacy.materialityUnclassifiedOutcomeIds).toEqual(['out-1'])
  })

  it('applyMaterialityExclusion is pure, never reads the legacy 1-5 score, and dedupes unclassified ids per outcome', () => {
    const a = classified({ id: 'a1', outcomeId: 'out-x', classification: null })
    const b = classified({ id: 'a2', outcomeId: 'out-x', classification: null })
    ;(a.outcome as any).materialityScore = 5
    const res = applyMaterialityExclusion([a, b])
    expect(res.included).toHaveLength(2)
    expect(res.materialityUnclassifiedOutcomeIds).toEqual(['out-x'])
    expect(res.skipped).toEqual([])
  })
})

describe('AG-B3-2 no-ratio state (P-RATIO-1 / N-RATIO-1 / M-RATIO-1)', () => {
  it('P-RATIO-1: with >= 1 defensibly monetized line the ratio is emitted exactly as today', () => {
    const r = run([inv('1000')], [classified({ ...ZERO_FILTERS, classification: 'material' })], [], [], null, AUTHORITATIVE)
    expect(r.sroiRatio).toBe(1)
    expect(r.sroiRatioExact).toBe('1.000000')
    expect(r.noRatioReason).toBeUndefined()
  })

  it('N-RATIO-1 / M-RATIO-1: zero defensibly monetized outcomes => NO ratio (null, not 0.000000), no per-funder ratio, totals still reported', () => {
    const r = run(
      [inv('1000', 'funder-1')],
      [classified({ id: 'a1', outcomeId: 'out-1', quantity: '10', proxyUsd: '100', ...ZERO_FILTERS, classification: 'not_material' })],
      [{ outcomeId: 'out-1', funderId: 'funder-1', allocationPct: '100', status: 'active' }] as any,
      [{ id: 'funder-1', name: 'F', funderType: 'foundation' }] as any,
      null,
      AUTHORITATIVE,
    )
    expect(r.lineItems).toEqual([])
    expect(r.sroiRatio).toBeNull()
    expect(r.sroiRatioExact).toBeNull()
    expect(r.noRatioReason).toBe('NO_DEFENSIBLE_MONETIZATION')
    expect(r.monetizedOutcomeIds).toEqual([])
    // Results reporting remains permitted: investment and (zero) values are reported...
    expect(r.totalInvestmentExact).toBe('1000.0000')
    expect(r.netSocialValueExact).toBe('0.0000')
    expect(r.grossSocialValueExact).toBe('0.0000')
    expect(r.skippedAssignments).toEqual([{ outcomeId: 'out-1', reason: 'not_material' }])
    // ...but no ratio is fabricated anywhere: not globally, not per funder.
    expect(r.fundersBreakdown).toEqual([])
    expect(r.unattributedNsvUsd).toBe('0.0000')
    // Mutation sensitivity: the removed guard would have produced 0/1000 = '0.000000'.
    expect(r.sroiRatioExact).not.toBe('0.000000')
  })
})

describe('AG-B3-4 filter semantics (P-FILTER-1 / P-FILTER-2 / N-FILTER-1 / M-FILTER-1)', () => {
  it('P-FILTER-1: explicit 0 for every governed filter under authoritative semantics is exactly 0 - identical strings to the legacy coercion path', () => {
    const explicit = run([inv('1000')], [line({ quantity: '10', proxyUsd: '100', ...ZERO_FILTERS })], [], [], null, AUTHORITATIVE)
    const legacy = run([inv('1000')], [line({ quantity: '10', proxyUsd: '100' })], [], [], null, PRELIMINARY)
    expect(explicit.netSocialValueExact).toBe(legacy.netSocialValueExact)
    expect(explicit.sroiRatioExact).toBe(legacy.sroiRatioExact)
    expect(explicit.sroiRatioExact).toBe('1.000000')
    expect(explicit.preliminaryFilterAssumptions).toEqual([])
  })

  it.each(['deadweightPct', 'attributionPct', 'displacementPct', 'dropoffPct'] as const)(
    'N-FILTER-1: a NULL %s under authoritative semantics throws FILTER_VALUE_UNKNOWN naming the assignment and filter - no line, no ratio',
    (key) => {
      const l = line({ id: 'a-null', ...ZERO_FILTERS })
      ;(l.filterSet as any)[key] = null
      expect(() => run([inv('1000')], [l], [], [], null, AUTHORITATIVE)).toThrow(/FILTER_VALUE_UNKNOWN: assignment a-null .* has no (deadweight|attribution|displacement|dropoff) value/)
    },
  )

  it('N-FILTER-1: a NULL duration under authoritative semantics throws too (duration is one of the five governed filters)', () => {
    const l = line({ id: 'a-dur', ...ZERO_FILTERS })
    ;(l.filterSet as any).durationYears = null
    expect(() => run([inv('1000')], [l], [], [], null, AUTHORITATIVE)).toThrow(/FILTER_VALUE_UNKNOWN: assignment a-dur .* has no duration value/)
  })

  it('N-FILTER-1: an empty-string filter is unknown, not zero, on the authoritative path', () => {
    const l = line({ id: 'a-empty', ...ZERO_FILTERS, deadweightPct: '' })
    expect(() => run([inv('1000')], [l], [], [], null, AUTHORITATIVE)).toThrow(/FILTER_VALUE_UNKNOWN/)
  })

  it('P-FILTER-2 / M-FILTER-1: the preliminary path coerces AND itemizes every unknown filter (the legacy pins above stay green only because they run preliminary)', () => {
    const r = run([inv('1000')], [line({ id: 'a1', quantity: '10', proxyUsd: '100', dropoffPct: '5' })], [], [], null, PRELIMINARY)
    expect(r.sroiRatioExact).toBe('1.000000')
    expect(r.preliminaryFilterAssumptions).toEqual([
      { assignmentId: 'a1', outcomeId: 'out-1', filter: 'deadweight', assumedValue: 0 },
      { assignmentId: 'a1', outcomeId: 'out-1', filter: 'attribution', assumedValue: 0 },
      { assignmentId: 'a1', outcomeId: 'out-1', filter: 'displacement', assumedValue: 0 },
    ])
    // The same line under authoritative semantics is refused - restoring the
    // parseNum(null) -> 0 coercion on that path would make this assertion fail.
    expect(() => run([inv('1000')], [line({ id: 'a1', quantity: '10', proxyUsd: '100', dropoffPct: '5' })], [], [], null, AUTHORITATIVE)).toThrow(/FILTER_VALUE_UNKNOWN/)
  })
})
