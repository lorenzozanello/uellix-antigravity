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

import { runDeterministicCalc, parseNum } from '@/lib/pipeline/sroi-calculation'
import { convertToUsd } from '@/lib/pipeline/fx-math'
import { scenarioFilterPct } from '@/lib/pipeline/sroi-sensitivity'
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
    proxy: { id: `proxy-${id}`, valueUsd: opts.proxyUsd ?? '100' },
    outcome: { id: opts.outcomeId ?? 'out-1' },
  } as any
}

const run = (
  investments: any[],
  lines: any[],
  allocations: any[] = [],
  funders: any[] = [],
  discountRatePct: string | null = null,
) => runDeterministicCalc(investments, lines, allocations, funders, discountRatePct)

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

  it('G4 sensitivity triple (uniform ±10pp via scenarioFilterPct)', () => {
    const base = { deadweightPct: '20', attributionPct: '10', displacementPct: '0', dropoffPct: '5' }
    const mk = (scenario: 'conservative' | 'base' | 'optimistic') =>
      run(
        [inv('1000')],
        [line({
          quantity: '10', proxyUsd: '100', durationYears: 3,
          deadweightPct: String(scenarioFilterPct(parseNum(base.deadweightPct), scenario, 10)),
          attributionPct: String(scenarioFilterPct(parseNum(base.attributionPct), scenario, 10)),
          displacementPct: String(scenarioFilterPct(parseNum(base.displacementPct), scenario, 10)),
          dropoffPct: String(scenarioFilterPct(parseNum(base.dropoffPct), scenario, 10)),
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
        expect(ratios[i]).toBeLessThan(ratios[i - 1])
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
    expect(Math.abs(viaCop.sroiRatio - direct.sroiRatio)).toBeLessThan(1e-4)
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
