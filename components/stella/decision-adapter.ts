// components/stella/decision-adapter.ts
// WS3c U4 (D-007): client-side adapter that maps a SuggestionDecisionRecord
// (components/stella/decision-types.ts) onto the server persistence contract
// (app/actions/stella/decisions-schema.ts) and calls recordStellaDecision.
//
// Mapping:
// - suggestionId        → suggestionKey
// - action              → decision ('accepted' | 'accepted_edited' |
//                         'rejected' | 'undone' map 1:1)
// - action 'copied'     → NOT persisted (clipboard-only affordance; the
//                         server vocabulary has no such decision) — early
//                         return, the server action is never called.
// - appliedText         → editedText ONLY for 'accepted_edited'
// - previousValue       → passthrough (the server hashes it; never stored raw)
// - rejectionReason     → passthrough
//
// Failure semantics — persistence is best-effort and must NEVER disturb the
// UI flow:
// - { error: 'DISABLED' } is swallowed silently: it is the EXPECTED result
//   until gate G2 applies the prepared table and the flag is flipped.
// - Any other error result or thrown error logs a '[stella-decisions]'
//   console.warn (codes/names only, never suggestion text) and resolves.

import { recordStellaDecision } from '@/app/actions/stella/decisions'
import type { StellaDecisionInput, StellaDecisionValue } from '@/app/actions/stella/decisions-schema'
import type { SuggestionDecisionRecord } from './decision-types'

export interface StellaDecisionPersistenceContext {
  /** Project the suggestion belongs to (ownership re-verified server-side). */
  projectId: string
  /** Optional stella_interactions row the suggestion came from. */
  interactionId?: string
}

export async function persistStellaDecision(
  record: SuggestionDecisionRecord,
  ctx: StellaDecisionPersistenceContext,
): Promise<void> {
  // 'copied' is a clipboard affordance, not a persisted decision.
  if (record.action === 'copied') return

  const decision: StellaDecisionValue = record.action

  const input: StellaDecisionInput = {
    projectId: ctx.projectId,
    suggestionKey: record.suggestionId,
    decision,
    ...(ctx.interactionId !== undefined ? { interactionId: ctx.interactionId } : {}),
    ...(decision === 'accepted_edited' && record.appliedText !== undefined
      ? { editedText: record.appliedText }
      : {}),
    ...(record.previousValue !== undefined ? { previousValue: record.previousValue } : {}),
    ...(record.rejectionReason !== undefined ? { rejectionReason: record.rejectionReason } : {}),
  }

  try {
    const result = await recordStellaDecision(input)
    if (!result.ok && result.error !== 'DISABLED') {
      // Codes only — never the suggestion text or previous value.
      console.warn('[stella-decisions] decision not persisted:', result.error)
    }
  } catch (error) {
    console.warn(
      '[stella-decisions] decision persistence failed:',
      error instanceof Error ? error.name : 'unknown',
    )
  }
}
