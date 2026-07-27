// lib/stella/context/pii-detection.ts
// Etapa A2 (STL-A2-007) — PII detection per DR-001, approved by the product
// owner on 2026-07-25 (see STELLA_A2_GOVERNANCE_DECISION_PACKAGE.md#DR-001
// and STELLA_A2_OWNER_DECISION_FORM.md).
//
// Two tiers, matching the approved decision exactly:
//   - COMMON: detected and flagged, never blocks by itself. A redacted
//     version can be produced (redactCommonPii) for the "anonymized version"
//     the decision asks to offer when possible.
//   - HIGH_RISK: detected and BLOCKS (the caller — context-guardrails.ts —
//     must fail closed). Covers: government ID documents, personal financial
//     account numbers, credentials/secrets (delegated to sanitize.ts's
//     existing hasForbiddenPattern, not reimplemented here), and two
//     keyword-based heuristics for minor-identifiable and individual-health
//     content.
//
// IMPORTANT LIMITATION (documented deliberately, not hidden): this is a
// regex/keyword heuristic detector, not an NLP PII classifier. It catches
// the specific patterns implemented below; it does not guarantee exhaustive
// detection of every possible way personal, minor-related, or health
// information could appear in free text. The minor/health heuristics in
// particular are a first pass — DR-002/DR-003 explicitly anticipate refining
// the aggregation threshold and identifiability rules with real data. Fail
// left on high-risk categories, per the approved decision, is the safety net
// for what this heuristic misses; it does not compensate for what it never
// looks for in the first place.

import { hasForbiddenPattern } from './sanitize'

export type CommonPiiCategory = 'email' | 'phone' | 'genericId' | 'preciseAddress'
export type HighRiskPiiCategory =
  | 'governmentId'
  | 'financialAccount'
  | 'credential'
  | 'minorIdentifiable'
  | 'individualHealth'

export interface PiiMatch {
  category: CommonPiiCategory | HighRiskPiiCategory
  /** The literal matched text. Callers must never persist or log this — only the category. */
  match: string
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

// Requires a leading "+" or parentheses or two separators, and 7-15 digits
// total — narrow enough to avoid matching plain sentences with a few numbers.
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]?\d{3,4}\b/g

// A bare 6-12 digit run, NOT already part of a longer digit sequence (financial
// account numbers are 13+ digits and handled separately as high-risk).
const GENERIC_ID_RE = /\b\d{6,12}\b/g

// Best-effort: a street-type keyword followed by a number nearby. Documented
// limitation — will miss most real addresses and may false-positive on
// unrelated numbered lists; kept intentionally narrow rather than broad.
const PRECISE_ADDRESS_RE = /\b(calle|avenida|av\.?|carrera|cra\.?|street|st\.?|ave\.?)\s+\S+\D*\d+/gi

const GOVERNMENT_ID_KEYWORD_RE = /\b(dni|c[ée]dula|pasaporte|passport|ssn|social security number|documento de identidad|id card)\b/i
const FINANCIAL_ACCOUNT_RE = /\b(?:\d[ -]?){13,19}\b/g
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g

// Ages 0-17 followed by "años"/"years old", combined with a minor-context keyword.
const MINOR_AGE_RE = /\b(?:[0-9]|1[0-7])\s*(años|years?\s*old)\b/i
const MINOR_CONTEXT_RE = /\b(menor(?:\s+de\s+edad)?|ni[ñn][oa]s?|estudiante|alumn[oa]|child|minor|student|pupil)\b/i

// Individual-framing verbs/phrases + a clinical keyword — narrower than a
// bare topic mention (e.g. "acceso a tratamiento de malaria en la comunidad"
// should NOT match; "Juan fue diagnosticado con VIH" should).
const INDIVIDUAL_HEALTH_RE =
  /\b(fue diagnosticad[oa]|diagnosticad[oa] con|padece de|fue tratad[oa] por|was diagnosed with|is being treated for)\b/i

/** Detects COMMON-tier PII. Never blocks by itself; the caller decides what to do with the result. */
export function detectCommonPii(text: string): PiiMatch[] {
  if (!text) return []
  const matches: PiiMatch[] = []

  for (const m of text.matchAll(EMAIL_RE)) matches.push({ category: 'email', match: m[0] })
  for (const m of text.matchAll(PHONE_RE)) matches.push({ category: 'phone', match: m[0] })
  for (const m of text.matchAll(PRECISE_ADDRESS_RE)) matches.push({ category: 'preciseAddress', match: m[0] })

  // Generic IDs: only bare digit runs not already claimed by the financial
  // account pattern (13+ digits) — avoids double-flagging a card number as
  // both "genericId" and "financialAccount".
  for (const m of text.matchAll(GENERIC_ID_RE)) {
    if (m[0].length <= 12) matches.push({ category: 'genericId', match: m[0] })
  }

  return matches
}

/** Detects HIGH_RISK-tier PII. Any non-empty result means the caller must block (fail closed). */
export function detectHighRiskPii(text: string): PiiMatch[] {
  if (!text) return []
  const matches: PiiMatch[] = []

  if (GOVERNMENT_ID_KEYWORD_RE.test(text)) {
    matches.push({ category: 'governmentId', match: text.match(GOVERNMENT_ID_KEYWORD_RE)![0] })
  }
  for (const m of text.matchAll(FINANCIAL_ACCOUNT_RE)) matches.push({ category: 'financialAccount', match: m[0] })
  for (const m of text.matchAll(IBAN_RE)) matches.push({ category: 'financialAccount', match: m[0] })
  if (hasForbiddenPattern(text)) matches.push({ category: 'credential', match: '[redacted-by-existing-sanitize-check]' })

  if (MINOR_AGE_RE.test(text) && MINOR_CONTEXT_RE.test(text)) {
    matches.push({ category: 'minorIdentifiable', match: text.match(MINOR_AGE_RE)![0] })
  }
  if (INDIVIDUAL_HEALTH_RE.test(text)) {
    matches.push({ category: 'individualHealth', match: text.match(INDIVIDUAL_HEALTH_RE)![0] })
  }

  return matches
}

/** Produces a redacted copy of `text` with each COMMON-tier match masked by its category. */
export function redactCommonPii(text: string): string {
  if (!text) return text
  return text
    .replace(EMAIL_RE, '[EMAIL_REDACTED]')
    .replace(PHONE_RE, '[PHONE_REDACTED]')
    .replace(PRECISE_ADDRESS_RE, '[ADDRESS_REDACTED]')
    .replace(GENERIC_ID_RE, (m) => (m.length <= 12 ? '[ID_REDACTED]' : m))
}
