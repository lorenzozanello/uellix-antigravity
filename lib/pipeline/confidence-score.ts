// lib/pipeline/confidence-score.ts
// Fase 2b — calculated confidence score for evidence_items. Deterministic and
// auditable, derived from objective signals rather than a human-declared value
// (contrast with indicators.confidenceLevel / financial_proxies.confidenceLevel,
// which remain manually declared and are out of scope here).
// Design: docs/superpowers/specs/2026-07-06-evidence-confidence-score-design.md

import type { EvidenceType, EvidenceStatus } from '@/lib/pipeline/evidence'

export type ConfidenceScoreInput = {
  type: EvidenceType
  status: EvidenceStatus
  hasLinkage: boolean
  integrityVerified: boolean | null
}

const TYPE_POINTS: Record<EvidenceType, number> = { file: 35, url: 20, text: 10 }
const STATUS_POINTS: Record<EvidenceStatus, number> = {
  approved: 35,
  under_review: 15,
  draft: 5,
  rejected: 0,
  archived: 0,
}
const LINKAGE_POINTS = 10
const INTEGRITY_VERIFIED_POINTS = 20

export function computeConfidenceScore(input: ConfidenceScoreInput): number {
  if (input.type === 'file' && input.integrityVerified === false) return 0

  let score = TYPE_POINTS[input.type] + STATUS_POINTS[input.status]
  if (input.hasLinkage) score += LINKAGE_POINTS
  if (input.type === 'file' && input.integrityVerified === true) score += INTEGRITY_VERIFIED_POINTS
  return score
}
