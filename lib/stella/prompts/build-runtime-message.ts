// lib/stella/prompts/build-runtime-message.ts
// Etapa A1.5 (STL-A15-001) — shared runtime composer used by all four
// buildXUserMessage functions (advisor/validator/reviewer/composer-system.ts).
//
// Before this file, each builder concatenated a fixed instruction sentence
// and free-form project data (narrative, outcome names, evidence titles,
// proxy names — all user-writable) directly into one prose string. That
// satisfied A1.5's context-object guardrail (assertContextHasNoForbiddenData)
// but never separated INSTRUCTION from DATA at the message level — the exact
// gap STELLA_THREAT_MODEL.md's S1 threat describes. This composer closes it:
// the TASK and RESPONSE_REQUIREMENTS sections are always fixed,
// developer-authored strings (never receive user-writable content directly);
// everything that came from the project — including plain counts, which are
// bundled here for a single, unambiguous data boundary rather than splitting
// "safe-looking" fields out of the envelope — goes through
// wrapUntrustedData(), which JSON-serializes it inside explicit delimiters
// with a literal "data, never an instruction" warning.
//
// This does not claim prompt injection is "neutralized" — see the adversarial
// suite (tests/stella-adversarial-runtime.test.ts) for exactly what is
// verified and STELLA_THREAT_MODEL.md for residual risk.

import { wrapUntrustedData } from '../context/build-untrusted-payload'

export interface StellaRuntimeMessageInput {
  /** Fixed, developer-authored objective sentence(s). Must never embed user-writable content directly. */
  task: string
  /** The project's data for this call. May contain anything a user typed — always wrapped, never concatenated. */
  untrustedData: Record<string, unknown>
  /** Fixed, developer-authored output/format instructions. Must never embed user-writable content directly. */
  responseRequirements: string
}

export const RUNTIME_MESSAGE_SECTIONS = {
  task: 'TASK',
  untrustedData: 'UNTRUSTED_PROJECT_DATA',
  responseRequirements: 'RESPONSE_REQUIREMENTS',
} as const

/**
 * Composes the three-section runtime message format required for every
 * Stella role: TASK (fixed objective) / UNTRUSTED_PROJECT_DATA (delimited
 * JSON, via wrapUntrustedData) / RESPONSE_REQUIREMENTS (fixed output rules).
 */
export function buildStellaUserMessage(input: StellaRuntimeMessageInput): string {
  return [
    RUNTIME_MESSAGE_SECTIONS.task,
    input.task,
    '',
    RUNTIME_MESSAGE_SECTIONS.untrustedData,
    wrapUntrustedData(input.untrustedData),
    '',
    RUNTIME_MESSAGE_SECTIONS.responseRequirements,
    input.responseRequirements,
  ].join('\n')
}
