// lib/pipeline/sroi-funders.ts
// Fase 1b — per-funder SROI breakdown (pure, no DB, decimal.js).
//
// Given the per-outcome net social value (already in USD) and the funder↔outcome
// allocations, computes each funder's attributed social value, their own SROI
// ratio (attributed value / their own investment), and the unattributed
// remainder (social value not claimed by any funder — a legitimate state, not
// an error). Kept pure so the attribution math is unit-tested in isolation from
// the calculation engine and the database.

import Decimal from 'decimal.js'

const MONEY_DP = 4
const RATIO_DP = 6

export interface FunderBreakdownRow {
  funderId: string
  funderName: string
  funderType: string
  investmentUsd: string
  attributedNsvUsd: string
  sroiRatio: string
}

export function computeFundersBreakdown(params: {
  netSocialValueUsd: string
  outcomeNsvUsd: Record<string, string>
  investments: { funderId: string; amountUsd: string }[]
  allocations: { outcomeId: string; funderId: string; allocationPct: string }[]
  funders: { id: string; name: string; funderType: string }[]
}): { fundersBreakdown: FunderBreakdownRow[]; unattributedNsvUsd: string } {
  const netNsv = new Decimal(params.netSocialValueUsd)

  const nsvByOutcome = new Map<string, Decimal>()
  for (const [oid, v] of Object.entries(params.outcomeNsvUsd)) {
    nsvByOutcome.set(oid, new Decimal(v))
  }

  // A funder's own investment = sum of its active contributions (already USD).
  const investmentByFunder = new Map<string, Decimal>()
  for (const inv of params.investments) {
    const cur = investmentByFunder.get(inv.funderId) ?? new Decimal(0)
    investmentByFunder.set(inv.funderId, cur.plus(new Decimal(inv.amountUsd)))
  }

  // A funder's attributed value = sum over its allocations of
  // outcomeNsv * (allocationPct / 100).
  const attributedByFunder = new Map<string, Decimal>()
  for (const alloc of params.allocations) {
    const outcomeNsv = nsvByOutcome.get(alloc.outcomeId) ?? new Decimal(0)
    const share = outcomeNsv.mul(new Decimal(alloc.allocationPct).div(100))
    const cur = attributedByFunder.get(alloc.funderId) ?? new Decimal(0)
    attributedByFunder.set(alloc.funderId, cur.plus(share))
  }

  const funderById = new Map(params.funders.map(f => [f.id, f]))
  // Every funder that either invested or was allocated something appears.
  const funderIds = new Set<string>([...investmentByFunder.keys(), ...attributedByFunder.keys()])

  const fundersBreakdown: FunderBreakdownRow[] = []
  let totalAttributed = new Decimal(0)
  for (const fid of funderIds) {
    const f = funderById.get(fid)
    const investmentUsd = investmentByFunder.get(fid) ?? new Decimal(0)
    const attributed = attributedByFunder.get(fid) ?? new Decimal(0)
    totalAttributed = totalAttributed.plus(attributed)
    // Ratio is 0 when a funder has an allocation-less investment (or no
    // investment yet) — a legitimate "not attributed yet" state, not a divide error.
    const ratio = investmentUsd.lte(0) ? new Decimal(0) : attributed.div(investmentUsd)
    fundersBreakdown.push({
      funderId: fid,
      funderName: f?.name ?? '',
      funderType: f?.funderType ?? '',
      investmentUsd: investmentUsd.toFixed(MONEY_DP),
      attributedNsvUsd: attributed.toFixed(MONEY_DP),
      sroiRatio: ratio.toFixed(RATIO_DP),
    })
  }

  return {
    fundersBreakdown,
    unattributedNsvUsd: netNsv.minus(totalAttributed).toFixed(MONEY_DP),
  }
}
