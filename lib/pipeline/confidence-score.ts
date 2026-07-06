// lib/pipeline/confidence-score.ts
// Fase 2b — calculated confidence score for evidence_items. Deterministic and
// auditable, derived from objective signals rather than a human-declared value
// (contrast with indicators.confidenceLevel / financial_proxies.confidenceLevel,
// which remain manually declared and are out of scope here).
// Design: docs/superpowers/specs/2026-07-06-evidence-confidence-score-design.md

import { db } from '@/db/client'
import { evidenceItems } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
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

// Best-effort by design: this recalculation must never cause a caller's
// otherwise-successful operation (evidence creation, review status change,
// integrity verification, ...) to appear failed. Any error during access
// checks, computation, persistence, or audit logging is caught and logged
// here rather than propagated.
export async function recalculateConfidenceScore(projectId: string, evidenceId: string): Promise<void> {
  try {
    const { organization, user } = await requireOrganizationAccess()

    const row = await db.select().from(evidenceItems).where(eq(evidenceItems.id, evidenceId)).then((r) => r[0])
    if (!row) return

    const newScore = computeConfidenceScore({
      type: row.type as EvidenceType,
      status: row.status as EvidenceStatus,
      hasLinkage: row.outcomeId !== null || row.indicatorId !== null,
      integrityVerified: row.integrityVerified,
    })

    const previousScore = row.confidenceScore

    if (newScore === previousScore) return

    await db
      .update(evidenceItems)
      .set({ confidenceScore: newScore, confidenceCalculatedAt: new Date() })
      .where(eq(evidenceItems.id, evidenceId))

    await logAuditAction({
      organizationId: organization.id,
      projectId,
      actorUserId: user.id,
      entityType: 'evidence_item',
      entityId: evidenceId,
      action: AUDIT_ACTIONS.EVIDENCE_CONFIDENCE_SCORE_UPDATED,
      beforeJson: { confidenceScore: previousScore },
      afterJson: { confidenceScore: newScore },
    })
  } catch (error) {
    console.error('[confidence-score] recalculation failed', { evidenceId, error })
  }
}
