// app/actions/stella/decisions-schema.ts
// WS3b U4: input contract for recordStellaDecision (app/actions/stella/decisions.ts).
//
// Kept OUTSIDE the 'use server' module on purpose: a 'use server' file may only
// export async server functions, so the Zod schema and types the UI layer needs
// for client-side validation live here. The UI agent wires its onDecision hook
// against this schema — see the contract comment in decisions.ts.

import { z } from 'zod'

/** The 4 decision states persisted by db/prepared/stella_0003_suggestion_decisions.sql. */
export const STELLA_DECISION_VALUES = ['accepted', 'accepted_edited', 'rejected', 'undone'] as const

export type StellaDecisionValue = (typeof STELLA_DECISION_VALUES)[number]

export const StellaDecisionInputSchema = z
  .object({
    /** Project the suggestion belongs to. Ownership is re-verified server-side
     *  against the session organization — a foreign projectId is rejected. */
    projectId: z.uuid(),
    /** Stable key identifying WHICH suggestion inside the interaction payload
     *  (e.g. 'advisor.suggested_next_actions[2]'). Assigned by the UI layer. */
    suggestionKey: z.string().min(1).max(300),
    decision: z.enum(STELLA_DECISION_VALUES),
    /** Optional stella_interactions row the suggestion came from. */
    interactionId: z.uuid().optional(),
    /** Text actually applied (for 'accepted_edited'); persisted as applied_text. */
    editedText: z.string().max(20000).optional(),
    /** Free-text reason (for 'rejected'); persisted as rejection_reason. */
    rejectionReason: z.string().max(2000).optional(),
    /** RAW previous value the suggestion replaced. NEVER persisted — the server
     *  stores only its SHA-256 hex digest (previous_value_hash). */
    previousValue: z.string().max(100000).optional(),
  })
  .strict()

export type StellaDecisionInput = z.infer<typeof StellaDecisionInputSchema>
