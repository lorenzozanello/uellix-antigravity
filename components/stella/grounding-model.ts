// components/stella/grounding-model.ts
// PRODUCT TRAIN 1 — typed presentation model for grounded Stella responses.
//
// Every state here is derived from data this codebase already produces
// (AdvisorContextualOutput's sourceFields/missingInformation/proposedText,
// the StellaPanelErrorCode taxonomy, SuggestionDecisionAction). Nothing here
// invents a new backend capability or does business calculation -- it only
// re-labels existing signals for richer, more honest rendering.
//
// `contradictory_evidence` is the one exception: today's advisor contract has
// no way to represent "two evidence items disagree" (GROUNDING has not
// published a retrieval/provenance contract yet -- see
// docs/ops/contracts/PRODUCT-001_grounded-citation-provenance.md). The type
// models it and StellaGroundingBadge can render it, but no mapper in this
// file ever produces it -- it stays reachable only via an explicit
// GroundedClaim built by a future caller (or a test fixture), never as a
// silent default.

import { sourceFieldLabel } from './source-field-label'
import { EMPTY_COLLECTION_SENTINEL_SEGMENT } from '@/lib/stella/context/canonical-source-field-paths'
import type { ContextualFinding, ContextualSuggestion } from './StellaContextualAdvisorPanel'
import type { StellaPanelErrorCode } from './error-messages'
import type { SuggestionDecisionAction } from './decision-types'

/** How well a single claim (finding or suggestion) is backed by cited context. */
export type EvidenceSupportLevel =
  | 'grounded'
  | 'partially_grounded'
  | 'insufficient_evidence'
  | 'contradictory_evidence'

/** One citation: a canonical source-field path plus its precomputed Spanish label. */
export interface EvidenceReference {
  sourceField: string
  label: string
}

/** Why a response cannot be rendered at all -- one bucket per real error class. */
export type StellaAvailabilityState = 'unavailable' | 'permission_denied' | 'quota_reached' | 'provider_failure'

/** Where a claim sits in the human decision workflow. Mirrors SuggestionDecisionAction 1:1 minus 'copied'. */
export type StellaDecisionStatus = 'user_approval_required' | 'accepted' | 'accepted_edited' | 'rejected' | 'undone'

function isEmptySentinel(path: string): boolean {
  return path === EMPTY_COLLECTION_SENTINEL_SEGMENT || path.endsWith(`.${EMPTY_COLLECTION_SENTINEL_SEGMENT}`)
}

function classifySupport(opts: {
  hasContent: boolean
  sourceFields: readonly string[]
  hasGaps: boolean
}): EvidenceSupportLevel {
  if (!opts.hasContent) return 'insufficient_evidence'
  const realSources = opts.sourceFields.filter((f) => !isEmptySentinel(f))
  const citesOnlyAbsence = opts.sourceFields.length > 0 && realSources.length === 0
  if (citesOnlyAbsence) return 'insufficient_evidence'
  // A mix of real citations and `.empty`-sentinel citations is itself a gap
  // signal (part of the claim is backed, part explicitly cites an absence),
  // independent of any caller-supplied hasGaps (e.g. missingInformation).
  const hasGaps = opts.hasGaps || realSources.length < opts.sourceFields.length
  if (realSources.length === 0) return hasGaps ? 'partially_grounded' : 'insufficient_evidence'
  return hasGaps ? 'partially_grounded' : 'grounded'
}

/** Findings always have content (explanation text) and never carry a gaps list. */
export function classifyFindingSupport(finding: ContextualFinding): EvidenceSupportLevel {
  return classifySupport({ hasContent: true, sourceFields: finding.sourceFields, hasGaps: false })
}

/** Suggestions abstain via `proposedText: null` and can flag partial gaps via `missingInformation`. */
export function classifySuggestionSupport(suggestion: ContextualSuggestion): EvidenceSupportLevel {
  return classifySupport({
    hasContent: suggestion.proposedText !== null,
    sourceFields: suggestion.sourceFields,
    hasGaps: suggestion.missingInformation.length > 0,
  })
}

/** Maps raw canonical source-field paths to labeled, navigable-ready citation refs. */
export function buildEvidenceReferences(sourceFields: readonly string[]): EvidenceReference[] {
  return sourceFields.map((sourceField) => ({ sourceField, label: sourceFieldLabel(sourceField) }))
}

/**
 * Narrows the 12-code server error taxonomy down to the 4 availability
 * buckets the presentation layer needs to branch on. The full title/
 * description copy still comes from stellaErrorPresentation() -- this
 * function only decides which typed bucket a code belongs to.
 */
export function classifyAvailability(code: StellaPanelErrorCode): StellaAvailabilityState {
  switch (code) {
    case 'DISABLED':
      return 'unavailable'
    case 'UNAUTHORIZED':
      return 'permission_denied'
    case 'QUOTA_EXCEEDED':
      return 'quota_reached'
    default:
      return 'provider_failure'
  }
}

/** `null` = no decision made yet. 'copied' is a clipboard side-action, not a decision. */
export function decisionStatusFromAction(action: SuggestionDecisionAction | null): StellaDecisionStatus {
  if (action === null || action === 'copied') return 'user_approval_required'
  return action
}
