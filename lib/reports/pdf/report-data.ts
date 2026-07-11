// lib/reports/pdf/report-data.ts
// Fase 6b — pure, deterministic extraction of audit-ready report annexes from
// the (immutable) calculation snapshot and evidence rows. Kept pure so the same
// locked report always yields the same annex data (tested), independent of PDF
// rendering.

export type FunderRow = {
  funderName: string
  funderType: string
  investmentUsd: string
  attributedNsvUsd: string
  sroiRatio: string
}

export type FunderBreakdown = {
  rows: FunderRow[]
  unattributedNsvUsd: string | null
}

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function toFunderRow(raw: unknown): FunderRow | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const funderName = asString(r.funderName)
  const investmentUsd = asString(r.investmentUsd)
  const attributedNsvUsd = asString(r.attributedNsvUsd)
  const sroiRatio = asString(r.sroiRatio)
  if (funderName === null || investmentUsd === null || attributedNsvUsd === null || sroiRatio === null) {
    return null
  }
  return {
    funderName,
    funderType: asString(r.funderType) ?? '',
    investmentUsd,
    attributedNsvUsd,
    sroiRatio,
  }
}

/** Extract the funder breakdown from a calculation snapshot. Null when absent,
 *  empty, or malformed — never throws on untrusted snapshot shape. */
export function extractFunderBreakdown(snapshotJson: unknown): FunderBreakdown | null {
  if (!snapshotJson || typeof snapshotJson !== 'object') return null
  const snap = snapshotJson as Record<string, unknown>
  const list = snap.fundersBreakdown
  if (!Array.isArray(list) || list.length === 0) return null

  const rows = list.map(toFunderRow).filter((r): r is FunderRow => r !== null)
  if (rows.length === 0) return null

  return { rows, unattributedNsvUsd: asString(snap.unattributedNsvUsd) }
}

export type FxTrailRow = {
  amount: string
  currency: string
  amountUsd: string
  year: number | null
  converted: boolean
}

export type FxTrail = { rows: FxTrailRow[] }

function toFxRow(raw: unknown): FxTrailRow | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const amount = asString(r.amount)
  const currency = asString(r.currency)
  const amountUsd = asString(r.amountUsd)
  if (amount === null || currency === null || amountUsd === null) return null
  const year = typeof r.year === 'number' ? r.year : null
  return { amount, currency, amountUsd, year, converted: currency !== 'USD' }
}

/** Extract the per-investment FX conversion trail from a calculation snapshot.
 *  Documents how each contribution was normalized to USD. Null when absent. */
export function extractFxTrail(snapshotJson: unknown): FxTrail | null {
  if (!snapshotJson || typeof snapshotJson !== 'object') return null
  const list = (snapshotJson as Record<string, unknown>).investments
  if (!Array.isArray(list) || list.length === 0) return null
  const rows = list.map(toFxRow).filter((r): r is FxTrailRow => r !== null)
  return rows.length === 0 ? null : { rows }
}

export type LineItemRow = {
  outcomeRef: string
  proxyRef: string
  quantity: string
  proxyValue: string
  grossValue: string
  adjustedValue: string
  adjustments: string
}

export type LineItems = { rows: LineItemRow[]; truncated: boolean; total: number }

function foldAdjustments(filters: unknown): string {
  if (!filters || typeof filters !== 'object') return ''
  const f = filters as Record<string, unknown>
  const parts: string[] = []
  const dw = asString(f.deadweightPct)
  const attr = asString(f.attributionPct)
  const disp = asString(f.displacementPct)
  const drop = asString(f.dropoffPct)
  if (dw !== null) parts.push(`DW ${dw}%`)
  if (attr !== null) parts.push(`Atr ${attr}%`)
  if (disp !== null) parts.push(`Desp ${disp}%`)
  if (drop !== null) parts.push(`Dec ${drop}%`)
  return parts.join(' · ')
}

function toLineItemRow(raw: unknown): LineItemRow | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const grossValue = asString(r.grossValue)
  const adjustedValue = asString(r.adjustedValue)
  if (grossValue === null || adjustedValue === null) return null
  return {
    outcomeRef: asString(r.outcomeId)?.slice(0, 8) ?? '—',
    proxyRef: asString(r.proxyId)?.slice(0, 8) ?? '—',
    quantity: asString(r.quantity) ?? '—',
    proxyValue: asString(r.proxyValue) ?? '—',
    grossValue,
    adjustedValue,
    adjustments: foldAdjustments(r.filters),
  }
}

/** Extract the raw per-assignment calculation line items from a snapshot, capped
 *  at `limit` rows (audit annex). References outcomes/proxies by their immutable
 *  snapshot IDs (truncated) — not by current names, which could have drifted. */
export function extractLineItems(snapshotJson: unknown, limit = 40): LineItems | null {
  if (!snapshotJson || typeof snapshotJson !== 'object') return null
  const list = (snapshotJson as Record<string, unknown>).assignments
  if (!Array.isArray(list) || list.length === 0) return null
  const all = list.map(toLineItemRow).filter((r): r is LineItemRow => r !== null)
  if (all.length === 0) return null
  return { rows: all.slice(0, limit), truncated: all.length > limit, total: all.length }
}

export type EvidenceManifestRow = {
  title: string
  type: string
  status: string
  hashShort: string | null
}

/** Build an audit manifest of evidence items with truncated content hashes. */
export function buildEvidenceManifest(
  items: { title: string; type: string; status: string; contentHash: string | null }[]
): EvidenceManifestRow[] {
  return items.map((i) => ({
    title: i.title,
    type: i.type,
    status: i.status,
    hashShort: i.contentHash ? i.contentHash.slice(0, 12) : null,
  }))
}
