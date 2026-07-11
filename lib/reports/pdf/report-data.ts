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
