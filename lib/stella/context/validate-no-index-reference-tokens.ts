// lib/stella/context/validate-no-index-reference-tokens.ts
// FABLE MOONSHOT WS1 / U5 (R4): the sourceRefIndexes transport is an internal
// mechanism. A provider response must never surface bare index tokens like
// "(0)" or "(13)" — or the transport field name itself — inside free text.
// This validator runs post-decode and fails closed.

import { StellaParseError } from '../errors'

export class ContextualIndexTokenLeakError extends StellaParseError {
  constructor(readonly location: string, readonly token: string) {
    super(`${location}: free text contains a bare source-reference token ${JSON.stringify(token)}`)
    this.name = 'ContextualIndexTokenLeakError'
  }
}

/** Bare integer wrapped in parentheses or brackets: "(0)", "( 3 )", "[13]". */
const BARE_INDEX_TOKEN_PATTERN = /[([]\s*(\d{1,4})\s*[)\]]/g
/** The provider-transport field name must never appear in user-facing text. */
const TRANSPORT_FIELD_PATTERN = /\bsourceRefIndexes?\b/gi
/**
 * Unbracketed Spanish index-reference phrasings: "índice 3", "fuente 0",
 * "referencia 2". Bounded by the same in-range rule as the bracketed form.
 * Words WITHOUT a trailing integer ("fuente oficial") can never match.
 * A custom lookbehind/lookahead replaces \b, which is ASCII-only and would
 * silently fail on the accented "índice".
 */
const UNBRACKETED_INDEX_PHRASE_PATTERN = /(?<![\p{L}\p{N}])(índice|indice|fuente|referencia)\s+(\d{1,4})(?![\p{N}])/giu

/**
 * Returns the bare index-reference tokens found in one free-text value.
 * A numeric reference — "(3)", "[3]", "índice 3", "fuente 3", "referencia 3"
 * — only counts as a leak when the integer is a valid index into this
 * request's catalog (0 <= n < pathCount). This keeps years like "(2026)" or
 * "fuente 2026" and other out-of-range numbers from being false positives.
 *
 * Known residue (documented in G1_PACKAGE.md §"Known reservations"): other
 * phrasings — English "index 3"/"source 3", "ítem 3", ordinals like
 * "tercera fuente" — are NOT detected and rely on the prompt rule plus
 * mandatory human review.
 */
export function findBareIndexReferenceTokens(text: string, pathCount: number): string[] {
  const tokens: string[] = []
  const isCatalogIndex = (raw: string): boolean => {
    const index = Number(raw)
    return Number.isInteger(index) && index >= 0 && index < pathCount
  }
  for (const match of text.matchAll(BARE_INDEX_TOKEN_PATTERN)) {
    if (isCatalogIndex(match[1])) tokens.push(match[0])
  }
  for (const match of text.matchAll(UNBRACKETED_INDEX_PHRASE_PATTERN)) {
    if (isCatalogIndex(match[2])) tokens.push(match[0])
  }
  for (const match of text.matchAll(TRANSPORT_FIELD_PATTERN)) {
    tokens.push(match[0])
  }
  return tokens
}

interface TextFieldEntry {
  location: string
  text: string
}

type AdvisorOutputTextShape = {
  summary: string
  findings: ReadonlyArray<{ title: string; explanation: string }>
  suggestions: ReadonlyArray<{ proposedText: string | null; rationale: string; missingInformation: readonly string[] }>
  clarifyingQuestions: readonly string[]
  limitations: readonly string[]
}

/**
 * Collects every free-text field of a decoded advisor output with a stable
 * location label. Shared by the leak validator and by evaluation harness
 * detectors so no text field escapes scanning.
 */
export function collectAdvisorOutputTextFields(output: AdvisorOutputTextShape): TextFieldEntry[] {
  const entries: TextFieldEntry[] = [{ location: 'summary', text: output.summary }]
  output.findings.forEach((finding, index) => {
    entries.push({ location: `findings[${index}].title`, text: finding.title })
    entries.push({ location: `findings[${index}].explanation`, text: finding.explanation })
  })
  output.suggestions.forEach((suggestion, index) => {
    if (suggestion.proposedText !== null) {
      entries.push({ location: `suggestions[${index}].proposedText`, text: suggestion.proposedText })
    }
    entries.push({ location: `suggestions[${index}].rationale`, text: suggestion.rationale })
    suggestion.missingInformation.forEach((item, itemIndex) => {
      entries.push({ location: `suggestions[${index}].missingInformation[${itemIndex}]`, text: item })
    })
  })
  output.clarifyingQuestions.forEach((question, index) => {
    entries.push({ location: `clarifyingQuestions[${index}]`, text: question })
  })
  output.limitations.forEach((limitation, index) => {
    entries.push({ location: `limitations[${index}]`, text: limitation })
  })
  return entries
}

/**
 * Fails closed when any free-text field of the output leaks a bare
 * source-reference index token. Citations live exclusively in sourceFields
 * (decoded from sourceRefIndexes) — never in prose.
 */
export function validateNoIndexReferenceTokens(output: AdvisorOutputTextShape, pathCount: number): void {
  for (const entry of collectAdvisorOutputTextFields(output)) {
    const tokens = findBareIndexReferenceTokens(entry.text, pathCount)
    if (tokens.length > 0) {
      throw new ContextualIndexTokenLeakError(entry.location, tokens[0])
    }
  }
}
