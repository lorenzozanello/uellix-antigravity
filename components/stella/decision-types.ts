// components/stella/decision-types.ts
// WS2 (Moonshot) — client-side suggestion-lifecycle decision contract.
//
// Every user decision over a contextual-advisor suggestion (accept, accept
// with edits, reject, undo) produces one SuggestionDecisionRecord. The panel
// reports it through the optional `onDecision` callback prop (default no-op).
//
// PERSISTENCE HOOK — coordinator note: another workstream will wire
// `onDecision` to a server action that appends these records to an
// audit-friendly store. This module deliberately contains only serializable
// data (no functions, no class instances) so a record can be posted to a
// server action as-is. Do not add non-serializable fields.

import type { AdvisorPipelineStep } from '@/lib/stella/advisor/steps'

/** What the user decided about one suggestion. */
export type SuggestionDecisionAction =
  /** Applied Stella's proposed text without changes. */
  | 'accepted'
  /** Applied a user-edited version of the proposed text. */
  | 'accepted_edited'
  /** Explicitly discarded the suggestion (optional free-text reason). */
  | 'rejected'
  /** Reverted a previous apply back to the pre-apply value. */
  | 'undone'
  /** Copied the proposed text to the clipboard (pages without a wired target). */
  | 'copied'

export interface SuggestionDecisionRecord {
  /** Stable id of the suggestion, as returned by the contextual advisor. */
  suggestionId: string
  /** Pipeline step the advisor was invoked for. */
  step: AdvisorPipelineStep
  action: SuggestionDecisionAction
  /** Stella's original proposal (null when Stella had insufficient information). */
  proposedText: string | null
  /**
   * Text actually handed to the page via `onApply` (accept/accept_edited/
   * undone) or copied to the clipboard (`copied`). Absent for `rejected`.
   * For `undone` this is the RESTORED value (what the field holds after the
   * undo completes).
   */
  appliedText?: string
  /**
   * The field value this decision displaced, when the page supplied one.
   * - accept/accept_edited: the target's value immediately before the apply.
   * - undone: the target's value at undo time (what the undo overwrote —
   *   which may differ from the applied text if the user edited afterwards;
   *   that case requires an explicit stale-undo confirmation in the UI).
   * Absent in clipboard mode and for `rejected`.
   */
  previousValue?: string
  /** Optional free-text reason captured on `rejected`. */
  rejectionReason?: string
  /** ISO-8601 timestamp captured client-side at decision time. */
  decidedAt: string
}

/** One entry of the client-side undo history (U2). */
export interface AppliedSuggestionHistoryEntry {
  suggestionId: string
  previousValue: string
  appliedValue: string
  /** ISO-8601 timestamp of the apply. */
  at: string
}
