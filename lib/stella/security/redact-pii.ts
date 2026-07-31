// lib/stella/security/redact-pii.ts
// WS3 (Fable Moonshot): pure PII redaction for free-text fields that reach
// Stella prompts. No imports, no side effects — safe from any layer.
//
// Covered:
//  - email addresses
//  - phone numbers (international + Colombian formats)
//  - Colombian cédulas / NITs and generic 6-12+ digit ID sequences that are
//    preceded by a context word (cédula, CC, NIT, documento, identificación,
//    DNI, pasaporte, id, ...)
//  - URLs with embedded credentials (https://user:pass@host/...)
//
// Deliberately NOT redacted: years, monetary amounts, percentages, scores,
// SROI ratios and bare digit runs without an identifying context word.

export interface PiiRedaction {
  kind: string
  count: number
}

export interface RedactPiiResult {
  text: string
  redactions: PiiRedaction[]
}

type RedactionRule = {
  kind: string
  pattern: RegExp
  /** Replacement — may keep captured context via a function. */
  replace: string | ((...match: string[]) => string)
}

// Order matters:
//  1. URLs with credentials first (the user:pass@host part would otherwise
//     half-match the email rule).
//  2. Emails.
//  3. Contextual IDs before phones (a "cédula 1.234.567.890" must be an ID,
//     not a phone).
//  4. Phones last.
const RULES: readonly RedactionRule[] = [
  {
    kind: 'url-credentials',
    pattern: /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/gi,
    replace: '[REDACTED:url-credentials]',
  },
  {
    kind: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: '[REDACTED:email]',
  },
  {
    // Context word + 6-20 char digit sequence (dots/commas/hyphens allowed,
    // e.g. 1.234.567.890 or NIT 900.123.456-7). The context word is kept so
    // the model still knows WHAT was redacted.
    kind: 'id',
    pattern:
      /\b(c[eé]dula(?:\s+de\s+ciudadan[ií]a)?|c\.?c\.?|nit|documento(?:\s+de\s+identidad)?|identificaci[oó]n|dni|pasaporte|passport|id)\s*(?:n[oº°]{0,2}\.?\s*|#\s*|:\s*)?(\d[\d.,-]{4,18}\d)/gi,
    replace: (_match, contextWord: string) => `${contextWord} [REDACTED:id]`,
  },
  {
    // International: +<country> then 2-4 digit groups.
    kind: 'phone',
    pattern: /(?<!\d)\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?!\d)/g,
    replace: '[REDACTED:phone]',
  },
  {
    // Parenthesized area code: (300) 123-4567
    kind: 'phone',
    pattern: /\(\d{3}\)\s?\d{3}[-\s]?\d{4}(?!\d)/g,
    replace: '[REDACTED:phone]',
  },
  {
    // Colombian mobile written with separators: 3XX XXX XXXX / 3XX-XXX-XXXX.
    // Separators are REQUIRED so plain amounts (450000, 3000000) never match.
    kind: 'phone',
    pattern: /(?<!\d)3\d{2}[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g,
    replace: '[REDACTED:phone]',
  },
]

/**
 * Redact PII from free text. Pure function: returns the redacted text plus a
 * summary of what was redacted (kind + count), never the original values.
 */
export function redactPii(text: string): RedactPiiResult {
  if (!text) return { text: '', redactions: [] }

  let result = text
  const counts = new Map<string, number>()

  for (const rule of RULES) {
    result = result.replace(rule.pattern, (...args) => {
      counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1)
      if (typeof rule.replace === 'function') {
        return rule.replace(...(args as string[]))
      }
      return rule.replace
    })
  }

  const redactions: PiiRedaction[] = [...counts.entries()].map(([kind, count]) => ({ kind, count }))
  return { text: result, redactions }
}
