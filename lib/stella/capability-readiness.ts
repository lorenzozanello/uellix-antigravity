// lib/stella/capability-readiness.ts
// G-03 — READINESS IS A PROPERTY OF A CAPABILITY, NOT OF THE PROCESS.
//
// ---------------------------------------------------------------------------
// THE COUPLING THIS REPLACES
// ---------------------------------------------------------------------------
// `stellaState.canUseStella` is `isEnabled && geminiApiKey.length > 0`, and it
// was the third term of the gate in all six Stella actions — including
// `grounded_query`, which answers by quoting retrieved evidence chunks with the
// LOCAL extractive generator (`createExtractiveAnswerProvider`) and never opens
// a socket to a provider. A capability that cannot call Gemini was being
// disabled by the absence of a Gemini key.
//
// The naive fix — dropping the key term from that one gate — is the one thing
// this module is written to avoid. It would put the provider requirement in
// five places and its exception in a sixth, which is a rule that survives
// exactly until someone adds a seventh action. So the requirement is stated
// ONCE, as a set, and every capability is answered from the same table.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS NOT
// ---------------------------------------------------------------------------
// It is NOT an authorization check and NOT a substitute for one. It answers
// "is this capability configured to run at all?" — a question about the
// deployment, decided before authentication, before any row is read and before
// any observability event. Whether THIS caller may use it stays where it is:
// `requireOrganizationAccess()` for identity, `canUseStella(role)` for the
// capability, and the governed SQL surface for scope.
//
// It also does not weaken the master switch. `STELLA_ENABLED=false` still
// refuses everything, first, and that is asserted rather than assumed.

import { stellaConfig } from './config'

/**
 * Every Stella capability that has a feature flag of its own.
 *
 * One entry per flag in `stellaConfig`, and the tests walk this list — so a
 * flag added without a readiness decision is a visible failure rather than a
 * capability that silently defaults to "ready".
 */
export const STELLA_CAPABILITIES = [
  'advisor',
  'validator',
  'composer',
  'proxy_reviewer',
  'evidence_reviewer',
  'audit_assistant',
  'decisions_persistence',
  'grounded_query',
] as const

export type StellaCapability = (typeof STELLA_CAPABILITIES)[number]

/**
 * The capabilities whose execution reaches `StellaGeminiAdapter`.
 *
 * MEMBERSHIP IS THE PROVIDER REQUIREMENT. A capability in this set is refused
 * without a key; one outside it is not, and the only way to change that for a
 * capability is to change this set — not to write a condition at a call site.
 *
 * `grounded_query` is deliberately absent: its answers come from
 * `createExtractiveAnswerProvider`, which quotes retrieved passages verbatim
 * and runs offline. `decisions_persistence` is absent for a different reason —
 * it persists a human's decision about a suggestion and calls no provider at
 * all.
 */
export const GEMINI_BACKED_STELLA_CAPABILITIES: ReadonlySet<StellaCapability> = new Set([
  'advisor',
  'validator',
  'composer',
  'proxy_reviewer',
  'evidence_reviewer',
  'audit_assistant',
])

/**
 * Why a capability cannot run, or `null` when it can.
 *
 * Ordered from the broadest cause to the narrowest, and reported in that order:
 * an operator who turned Stella off should be told that, not that a key is
 * missing behind it.
 */
export type StellaCapabilityBlocker =
  /** `STELLA_ENABLED` is not `'true'`. Refuses everything. */
  | 'master_disabled'
  /** The capability's own flag is not `'true'`. */
  | 'capability_disabled'
  /** The capability calls Gemini and `GEMINI_API_KEY` is absent or blank. */
  | 'provider_key_missing'

const CAPABILITY_FLAG: Record<StellaCapability, () => boolean> = {
  advisor: () => stellaConfig.isAdvisorEnabled,
  validator: () => stellaConfig.isValidatorEnabled,
  composer: () => stellaConfig.isComposerEnabled,
  proxy_reviewer: () => stellaConfig.isProxyReviewerEnabled,
  evidence_reviewer: () => stellaConfig.isEvidenceReviewerEnabled,
  audit_assistant: () => stellaConfig.isAuditAssistantEnabled,
  decisions_persistence: () => stellaConfig.isDecisionsPersistenceEnabled,
  grounded_query: () => stellaConfig.isGroundedQueryEnabled,
}

/**
 * The single reason this capability cannot run, or `null`.
 *
 * A FUNCTION rather than a precomputed record: `stellaConfig` is read at call
 * time, so a test that flips a flag between cases sees the flip. A frozen
 * snapshot — which is what `stellaState` is — would answer with the value the
 * module happened to load with.
 */
export function stellaCapabilityBlocker(
  capability: StellaCapability,
): StellaCapabilityBlocker | null {
  if (!stellaConfig.isEnabled) return 'master_disabled'
  if (!CAPABILITY_FLAG[capability]()) return 'capability_disabled'
  // `.trim()`, because a key set to whitespace by a mis-pasted secret is an
  // absent key that `length > 0` would have called present.
  if (GEMINI_BACKED_STELLA_CAPABILITIES.has(capability) && stellaConfig.geminiApiKey.trim() === '') {
    return 'provider_key_missing'
  }
  return null
}

/** `true` when the deployment is configured to run this capability. */
export function isStellaCapabilityReady(capability: StellaCapability): boolean {
  return stellaCapabilityBlocker(capability) === null
}
